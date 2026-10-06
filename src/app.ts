/**
 * Puts the connector together: the dialer, Likho, the state, the bus, the schedule and the
 * write-back; the dialer's lists over gRPC for likho-api; /healthz and /readyz for the gateway
 * and Kubernetes. What the schedule and the write-back do follows the workspace's settings in
 * Likho (Admin → Dialer), read at start and whenever they change.
 */
import { createServer, type Server } from 'node:http';
import type { Http2Server } from 'node:http2';
import { AmeyoClient } from './ameyo.js';
import { Bus, event } from './bus.js';
import { dialerZone, type Config } from './config.js';
import { openDialerDb, type DialerDb } from './dialer.js';
import { Importer } from './importer.js';
import { hinglishText, LikhoApi } from './likho.js';
import { openDialerLists, type DialerLists } from './lists.js';
import { describe, type Logger } from './log.js';
import { Metrics } from './metrics.js';
import { dialerRoutes, serveRpc } from './rpc.js';
import { Schedule } from './schedule.js';
import { fromConfig, fromLikho, scheduleChanged, type LiveSettings } from './settings.js';
import { State } from './state.js';
import { openWriteBack, type WriteBack } from './writeback.js';

export const VERSION = '0.4.0';

export interface Parts {
  state: State;
  likho: LikhoApi;
  ameyo: AmeyoClient;
  dialer: DialerDb | null;
  /** The campaigns, agents and calls of a window (the same database), for the lists people choose from. */
  lists: DialerLists | null;
  importer: Importer;
  metrics: Metrics;
  close(): Promise<void>;
}

/** Everything the CLI and the service share: connections and the importer. */
export async function assemble(config: Config, log: Logger, fetchImpl?: typeof fetch): Promise<Parts> {
  const state = new State(config.DATABASE_URL);
  await state.migrate();
  const likho = new LikhoApi(config.LIKHO_API_URL, config.LIKHO_API_KEY, fetchImpl);
  const ameyo = new AmeyoClient({
    baseUrl: config.AMEYO_VOICELOG_URL,
    hashKey: config.AMEYO_HASH_KEY,
    policyName: config.AMEYO_POLICY_NAME,
    requestingHost: config.AMEYO_REQUESTING_HOST,
    archiveUrl: config.AMEYO_ARCHIVAL_URL,
    archiveFileId: config.AMEYO_ARCHIVAL_FILE_ID,
    timeoutMs: config.AMEYO_TIMEOUT_SECONDS * 1000,
    fetchImpl,
  });
  const dialer = config.DIALER_DATABASE_URL
    ? openDialerDb(config.DIALER_DATABASE_URL, config.CALLS_QUERY_FILE, config.CALL_QUERY_FILE)
    : null;
  const lists = config.DIALER_DATABASE_URL
    ? openDialerLists(config.DIALER_DATABASE_URL, {
        campaigns: config.CAMPAIGNS_LIST_QUERY_FILE,
        agents: config.AGENTS_QUERY_FILE,
        window: config.WINDOW_QUERY_FILE,
      })
    : null;
  const metrics = new Metrics(VERSION, config.OTEL_EXPORTER_OTLP_ENDPOINT, log);
  const importer = new Importer(
    ameyo,
    likho,
    state,
    dialer,
    { source: config.SOURCE, phoneDigits: config.PHONE_DIGITS, metrics },
    log,
  );
  return {
    state,
    likho,
    ameyo,
    dialer,
    lists,
    importer,
    metrics,
    async close() {
      await dialer?.close();
      await lists?.close();
      await state.close();
      await metrics.close();
    },
  };
}

export class App {
  private readonly parts: Parts;
  private readonly bus: Bus;
  private server: Server | null = null;
  private rpc: Http2Server | null = null;
  private schedule: Schedule | null = null;
  private stopSchedule: (() => void) | null = null;
  private writeBack: WriteBack | null = null;
  private settings: LiveSettings;

  private constructor(
    private readonly config: Config,
    private readonly log: Logger,
    parts: Parts,
  ) {
    this.parts = parts;
    this.settings = fromConfig(config);
    this.bus = new Bus(config.NATS_URL, config.CONSUMER_GROUP, log);
    this.bus.handled = (subject, outcome) => parts.metrics.eventsHandled.add(1, { subject, outcome });
  }

  static async start(config: Config, log: Logger, fetchImpl?: typeof fetch): Promise<App> {
    const app = new App(config, log, await assemble(config, log, fetchImpl));
    await app.run();
    return app;
  }

  /** The address the gRPC side listens on. */
  rpcAddress(): string {
    const addr = this.rpc?.address();
    return typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
  }

  /** The settings in force right now. */
  current(): LiveSettings {
    return this.settings;
  }

  /** The address the HTTP side listens on. */
  address(): string {
    const addr = this.server?.address();
    return typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
  }

  private async run(): Promise<void> {
    const { config, log, parts } = this;
    await this.bus.connect(config.NATS_CONNECT_TIMEOUT_SECONDS);
    await this.reloadSettings('start');

    if (config.CONSUMERS_ENABLED) {
      await this.bus.consume({
        stream: 'LIKHO',
        name: 'requested',
        subject: 'likho.import.requested',
        handler: this.once((data) => this.onRequested(data)),
      });
      await this.bus.consume({
        stream: 'LIKHO',
        name: 'deleted',
        subject: 'likho.recording.deleted',
        handler: this.once((data) => parts.state.forgetRecording(String(data.recording_id ?? ''))),
      });
      // Always taken: whether a transcript is written back is decided when it comes (the setting may change).
      await this.bus.consume({
        stream: 'LIKHO',
        name: 'completed',
        subject: 'likho.transcription.completed',
        handler: this.once((data) => this.onCompleted(String(data.recording_id ?? ''))),
      });
      if (config.SETTINGS_FROM_LIKHO) {
        await this.bus.consume({
          stream: 'LIKHO',
          name: 'settings',
          subject: 'likho.settings.changed',
          handler: async (ev) => {
            const data = ev.data as { workspace_id?: string; keys?: string[] };
            if (config.WORKSPACE_ID && data.workspace_id !== config.WORKSPACE_ID) return;
            if (!(data.keys ?? []).some((k) => k.startsWith('dialer.'))) return;
            await this.reloadSettings('changed');
          },
        });
      }
    }

    this.rpc = await serveRpc(
      dialerRoutes(
        {
          lists: parts.lists,
          dialer: parts.dialer,
          state: parts.state,
          zone: dialerZone(config),
          version: VERSION,
          archiveEnabled: Boolean(config.AMEYO_ARCHIVAL_URL),
          settings: () => this.settings,
          writebackRunning: () => this.writeBack !== null,
          lastRun: () => {
            const last = this.schedule?.last;
            if (!last) return null;
            const r = last.report;
            return {
              at: last.at,
              summary: `seen ${r.seen}, taken ${r.taken}, left out ${r.skipped}, failed ${r.failed}; ${r.budgetLeft} left of the day's budget`,
            };
          },
        },
        log,
      ),
      config.GRPC_PORT,
    );

    this.server = createServer(async (request, response) => {
      if (request.url === '/healthz') {
        response.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
        return;
      }
      if (request.url === '/readyz') {
        const ready = this.bus.connected && (await parts.state.ping());
        response
          .writeHead(ready ? 200 : 503, { 'content-type': 'text/plain' })
          .end(ready ? 'ready\n' : 'not ready\n');
        return;
      }
      if (request.url === '/metrics') {
        parts.metrics.scrape(request, response);
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => this.server!.listen(config.HTTP_PORT, resolve));
    const s = this.settings;
    log.info(
      `likho-connector-ameyo ${VERSION}: health on ${config.HTTP_PORT}, gRPC on ${config.GRPC_PORT}, consumers ${config.CONSUMERS_ENABLED ? 'on' : 'off'}, settings from ${s.from}, schedule ${this.schedule ? `every ${s.pollIntervalSeconds}s` : 'off'}, write-back ${this.writeBack ? 'on' : 'off'}`,
    );
  }

  /**
   * Reads the settings (from Likho when it answers, else the .env values stand) and applies them:
   * the schedule is started, stopped or started again with the new policy; the write-back is
   * opened or closed; the phone digits change for the next call.
   */
  async reloadSettings(why: 'start' | 'changed'): Promise<void> {
    const { config, log, parts } = this;
    let next = this.settings;
    if (config.SETTINGS_FROM_LIKHO && config.LIKHO_API_KEY) {
      try {
        next = await fromLikho(parts.likho);
      } catch (error) {
        log.warn('the settings could not be read from Likho; the ones in force stand', {
          error: describe(error),
        });
        if (why === 'changed') throw error; // the event is delivered again later
      }
    }
    const before = this.settings;
    this.settings = next;
    parts.importer.setPhoneDigits(next.phoneDigits);

    if (why === 'start' || scheduleChanged(before, next)) this.restartSchedule();

    const wantWriteBack = next.writebackEnabled && Boolean(config.CRM_DATABASE_URL);
    if (next.writebackEnabled && !config.CRM_DATABASE_URL)
      log.warn('the write-back is switched on in Likho but CRM_DATABASE_URL is not set; it stays off');
    if (wantWriteBack && !this.writeBack) {
      this.writeBack = await openWriteBack(config.CRM_DATABASE_URL, config.WRITEBACK_QUERY_FILE);
    } else if (!wantWriteBack && this.writeBack) {
      await this.writeBack.close();
      this.writeBack = null;
    }
    if (why === 'changed')
      log.info('settings changed', { ...next, campaigns: next.campaigns.join(', ') || 'all' });
  }

  private restartSchedule(): void {
    const { config, log, parts } = this;
    this.stopSchedule?.();
    this.stopSchedule = null;
    const s = this.settings;
    const last = this.schedule?.last ?? null;
    if (!s.scheduleEnabled) {
      this.schedule = null;
      return;
    }
    if (!parts.dialer) {
      log.warn('the schedule is switched on but DIALER_DATABASE_URL is not set; it stays off');
      this.schedule = null;
      return;
    }
    this.schedule = new Schedule(
      parts.dialer,
      parts.importer,
      parts.state,
      {
        workspaceId: config.WORKSPACE_ID,
        batchLimit: s.batchLimit,
        dailyLimit: s.dailyLimit,
        start: config.SCHEDULE_START,
        policy: { campaigns: s.campaigns, minTalkSeconds: s.minTalkSeconds },
      },
      log,
    );
    this.schedule.last = last;
    this.stopSchedule = this.schedule.start(s.pollIntervalSeconds * 1000);
  }

  /** Wraps a handler so that an event id is acted on once. */
  private once(apply: (data: Record<string, any>) => Promise<void>) {
    return async (ev: { id: string; data: Record<string, unknown> }): Promise<void> => {
      if (!(await this.parts.state.firstTime(ev.id))) return;
      try {
        await apply(ev.data);
      } catch (error) {
        await this.parts.state.unhandle(ev.id);
        throw error;
      }
    };
  }

  /** A person or a schedule asked likho-api for a call by its id. */
  private async onRequested(data: Record<string, any>): Promise<void> {
    const { config, log } = this;
    if (String(data.source) !== config.SOURCE) return; // another connector's
    if (config.WORKSPACE_ID && String(data.workspace_id) !== config.WORKSPACE_ID) {
      log.debug('import request of another workspace', { request: data.request_id });
      return;
    }
    const requestId = String(data.request_id);
    const externalId = String(data.external_id);
    const workspaceId = String(data.workspace_id);
    const outcome = await this.parts.importer.run({
      externalId,
      workspaceId,
      transcribe: data.transcribe !== false,
      requestedBy: requestId,
    });
    const base = {
      request_id: requestId,
      workspace_id: workspaceId,
      source: config.SOURCE,
      external_id: externalId,
    };
    if (outcome.ok) {
      await this.bus.publish(
        'likho.import.completed',
        event('likho.import.completed.v1', requestId, {
          ...base,
          recording_id: outcome.recordingId,
          existing: outcome.existing,
        }),
      );
    } else {
      if (outcome.retry) throw new Error(outcome.reason); // the dialer is down: the request is delivered again later
      await this.bus.publish(
        'likho.import.failed',
        event('likho.import.failed.v1', requestId, { ...base, reason: outcome.reason, code: outcome.code }),
      );
    }
  }

  /** A transcript exists: if the recording is one of ours, write the Hinglish into the CRM. */
  private async onCompleted(recordingId: string): Promise<void> {
    if (!this.writeBack) return;
    const call = await this.parts.state.byRecording(recordingId);
    if (!call || call.status !== 'imported') return;
    const transcript = await this.parts.likho.transcript(recordingId);
    if (!transcript) return;
    const rows = await this.writeBack.write(call.externalId, hinglishText(transcript.lines));
    await this.parts.state.markWrittenBack(recordingId);
    this.log.info('transcript written back', { call: call.externalId, recording: recordingId, rows });
  }

  async stop(): Promise<void> {
    this.stopSchedule?.();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => (this.rpc ? this.rpc.close(() => resolve()) : resolve()));
    await this.bus.close();
    await this.writeBack?.close();
    await this.parts.close();
  }

  /** For tests: the bus, to publish what the other services would. */
  get events(): Bus {
    return this.bus;
  }
}
