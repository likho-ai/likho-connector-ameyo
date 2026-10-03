/**
 * Puts the connector together: the dialer, Likho, the state, the bus, the schedule and the
 * write-back; /healthz and /readyz for the gateway and Kubernetes.
 */
import { createServer, type Server } from 'node:http';
import { AmeyoClient } from './ameyo.js';
import { Bus, event } from './bus.js';
import { campaignsOf, type Config } from './config.js';
import { openDialerDb, type DialerDb } from './dialer.js';
import { Importer } from './importer.js';
import { hinglishText, LikhoApi } from './likho.js';
import { describe, type Logger } from './log.js';
import { Schedule } from './schedule.js';
import { State } from './state.js';
import { openWriteBack, type WriteBack } from './writeback.js';

export const VERSION = '0.1.0';

export interface Parts {
  state: State;
  likho: LikhoApi;
  ameyo: AmeyoClient;
  dialer: DialerDb | null;
  importer: Importer;
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
    timeoutMs: config.AMEYO_TIMEOUT_SECONDS * 1000,
    fetchImpl,
  });
  const dialer = config.DIALER_DATABASE_URL
    ? openDialerDb(config.DIALER_DATABASE_URL, config.CALLS_QUERY_FILE, config.CALL_QUERY_FILE)
    : null;
  const importer = new Importer(
    ameyo,
    likho,
    state,
    dialer,
    { source: config.SOURCE, phoneDigits: config.PHONE_DIGITS },
    log,
  );
  return {
    state,
    likho,
    ameyo,
    dialer,
    importer,
    async close() {
      await dialer?.close();
      await state.close();
    },
  };
}

export class App {
  private readonly parts: Parts;
  private readonly bus: Bus;
  private server: Server | null = null;
  private stopSchedule: (() => void) | null = null;
  private writeBack: WriteBack | null = null;

  private constructor(
    private readonly config: Config,
    private readonly log: Logger,
    parts: Parts,
  ) {
    this.parts = parts;
    this.bus = new Bus(config.NATS_URL, config.CONSUMER_GROUP, log);
  }

  static async start(config: Config, log: Logger, fetchImpl?: typeof fetch): Promise<App> {
    const app = new App(config, log, await assemble(config, log, fetchImpl));
    await app.run();
    return app;
  }

  /** The address the HTTP side listens on. */
  address(): string {
    const addr = this.server?.address();
    return typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
  }

  private async run(): Promise<void> {
    const { config, log, parts } = this;
    await this.bus.connect();
    if (config.WRITEBACK_ENABLED)
      this.writeBack = await openWriteBack(config.CRM_DATABASE_URL, config.WRITEBACK_QUERY_FILE);

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
      if (this.writeBack) {
        await this.bus.consume({
          stream: 'LIKHO',
          name: 'completed',
          subject: 'likho.transcription.completed',
          handler: this.once((data) => this.onCompleted(String(data.recording_id ?? ''))),
        });
      }
    }

    if (config.SCHEDULE_ENABLED && parts.dialer) {
      const schedule = new Schedule(
        parts.dialer,
        parts.importer,
        parts.state,
        {
          workspaceId: config.WORKSPACE_ID,
          batchLimit: config.BATCH_LIMIT,
          dailyLimit: config.DAILY_LIMIT,
          start: config.SCHEDULE_START,
          policy: { campaigns: campaignsOf(config), minTalkSeconds: config.MIN_TALK_SECONDS },
        },
        log,
      );
      this.stopSchedule = schedule.start(config.POLL_INTERVAL_SECONDS * 1000);
    }

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
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => this.server!.listen(config.HTTP_PORT, resolve));
    log.info(
      `likho-connector-ameyo ${VERSION}: health on ${config.HTTP_PORT}, consumers ${config.CONSUMERS_ENABLED ? 'on' : 'off'}, schedule ${config.SCHEDULE_ENABLED ? `every ${config.POLL_INTERVAL_SECONDS}s` : 'off'}, write-back ${config.WRITEBACK_ENABLED ? 'on' : 'off'}`,
    );
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
    await this.bus.close();
    await this.writeBack?.close();
    await this.parts.close();
  }

  /** For tests: the bus, to publish what the other services would. */
  get events(): Bus {
    return this.bus;
  }
}
