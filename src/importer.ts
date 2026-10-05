/**
 * One call, from the dialer into Likho:
 *
 *   details (the dialer's database, when there is one)
 *   → the audio (the dialer's API)
 *   → a recording in likho-api, the file to likho-media, source "ameyo", the details as attributes
 *   → a transcription, when asked for and the recording is not already on its way
 *   → the outcome in the connector's state, and on the bus for whoever asked
 */
import { AmeyoClient, type FetchResult } from './ameyo.js';
import { maskPhone, type CallRecord, type DialerDb } from './dialer.js';
import { LikhoApi, LikhoApiError } from './likho.js';
import { describe, type Logger } from './log.js';
import type { Metrics } from './metrics.js';
import { type CallRow, State } from './state.js';

export type FailureCode = 'not_found' | 'no_recording' | 'unavailable' | 'rejected' | 'error';

export type Outcome =
  | { ok: true; recordingId: string; existing: boolean; call: CallRow }
  | { ok: false; code: FailureCode; reason: string; retry: boolean };

export interface ImportRequest {
  externalId: string;
  workspaceId: string;
  /** Start a transcription once stored (default true). */
  transcribe?: boolean;
  /** Who asked: 'schedule', 'cli', or an import request id. */
  requestedBy: string;
  /** Details already in hand (the schedule has them); otherwise the dialer's database is asked. */
  details?: CallRecord | null;
}

export interface ImporterOptions {
  source: string;
  phoneDigits: number;
  /** Counts every call asked for, by outcome, and how long it took. */
  metrics?: Metrics;
}

export class Importer {
  constructor(
    private readonly ameyo: AmeyoClient,
    private readonly likho: LikhoApi,
    private readonly state: State,
    private readonly dialer: DialerDb | null,
    private readonly options: ImporterOptions,
    private readonly log: Logger,
  ) {}

  async run(request: ImportRequest): Promise<Outcome> {
    const started = Date.now();
    const outcome = await this.fetchAndStore(request);
    const metrics = this.options.metrics;
    if (metrics) {
      metrics.imports.add(1, {
        outcome: outcome.ok ? (outcome.existing ? 'existing' : 'imported') : outcome.code,
      });
      metrics.importSeconds.record((Date.now() - started) / 1000);
    }
    return outcome;
  }

  private async fetchAndStore(request: ImportRequest): Promise<Outcome> {
    const { externalId, workspaceId } = request;
    const transcribe = request.transcribe ?? true;

    // Fetched before, and still there: nothing to fetch again.
    const earlier = await this.state.call(externalId);
    if (earlier?.status === 'imported' && earlier.recordingId) {
      if (transcribe) await this.transcribeIfIdle(earlier.recordingId);
      return { ok: true, recordingId: earlier.recordingId, existing: true, call: earlier };
    }

    let details = request.details ?? null;
    if (!details && this.dialer) {
      try {
        details = await this.dialer.call(externalId);
      } catch (error) {
        this.log.warn('the dialer’s database did not answer; fetching without details', {
          call: externalId,
          error: describe(error),
        });
      }
    }

    let fetched = await this.ameyo.download(externalId);
    let audioFrom = 'live';
    if (
      (fetched.kind === 'no_recording' || fetched.kind === 'not_found') &&
      this.ameyo.hasArchive &&
      details?.callId
    ) {
      // The live server keeps a week or two; an older call is on the archiver, by its leg's id.
      const archived = await this.ameyo.downloadArchived(details.callId);
      if (archived.kind === 'audio') {
        fetched = archived;
        audioFrom = 'archive';
      } else {
        this.log.info('not on the archiver either', {
          call: externalId,
          leg: details.callId,
          reason: archived.reason,
        });
      }
    }
    if (fetched.kind !== 'audio') return this.fail(request, fetched, details);
    this.options.metrics?.downloadBytes.add(fetched.bytes.byteLength);

    const attributes = { ...this.attributes(details), audioFrom };
    let uploaded;
    try {
      uploaded = await this.likho.upload({
        originalName: `${externalId}.${extensionOf(fetched.contentType)}`,
        bytes: fetched.bytes,
        contentType: fetched.contentType,
        externalId,
        source: this.options.source,
        attributes,
      });
    } catch (error) {
      const reason =
        error instanceof LikhoApiError
          ? `Likho did not take the recording: ${error.message}`
          : 'Likho could not be reached.';
      await this.state.record({
        externalId,
        workspaceId,
        status: 'failed',
        code: 'error',
        reason,
        callTime: details?.callTime,
        campaign: details?.campaign,
        requestedBy: request.requestedBy,
      });
      this.log.error('upload failed', { call: externalId, error: describe(error) });
      return {
        ok: false,
        code: 'error',
        reason,
        retry: !(error instanceof LikhoApiError) || error.status >= 500,
      };
    }

    if (transcribe && uploaded.existing) await this.transcribeIfIdle(uploaded.recording.id);
    const row = await this.state.record({
      externalId,
      workspaceId,
      status: 'imported',
      recordingId: uploaded.recording.id,
      callTime: details?.callTime,
      campaign: details?.campaign,
      requestedBy: request.requestedBy,
    });
    this.log.info(uploaded.existing ? 'call already in Likho' : 'call fetched', {
      call: externalId,
      recording: uploaded.recording.id,
      bytes: fetched.bytes.byteLength,
      campaign: details?.campaign ?? '',
    });
    return { ok: true, recordingId: uploaded.recording.id, existing: uploaded.existing, call: row };
  }

  private async fail(
    request: ImportRequest,
    fetched: Exclude<FetchResult, { kind: 'audio' }>,
    details: CallRecord | null,
  ): Promise<Outcome> {
    await this.state.record({
      externalId: request.externalId,
      workspaceId: request.workspaceId,
      status: 'failed',
      code: fetched.kind,
      reason: fetched.reason,
      callTime: details?.callTime,
      campaign: details?.campaign,
      requestedBy: request.requestedBy,
    });
    this.log.warn('call not fetched', {
      call: request.externalId,
      code: fetched.kind,
      reason: fetched.reason,
    });
    return { ok: false, code: fetched.kind, reason: fetched.reason, retry: fetched.kind === 'unavailable' };
  }

  /** A recording that is ready and has no transcript yet gets a job; one on its way is left alone. */
  private async transcribeIfIdle(recordingId: string): Promise<void> {
    try {
      const recording = await this.likho.recording(recordingId);
      if (recording.status === 'ready') await this.likho.transcribe(recordingId);
    } catch (error) {
      this.log.warn('could not start the transcription', { recording: recordingId, error: describe(error) });
    }
  }

  /** The call's details as a recording's attributes: short names, text values, the phone masked. */
  attributes(details: CallRecord | null): Record<string, string> {
    if (!details) return {};
    const out: Record<string, string> = {};
    const put = (key: string, value: string) => {
      if (value) out[key] = value.slice(0, 500);
    };
    put('callId', details.callId);
    put('callTime', details.callTime);
    put('campaign', details.campaign);
    put('agent', details.agent);
    put('disposition', details.disposition);
    if (details.talkSeconds > 0) put('talkSeconds', String(details.talkSeconds));
    put('phone', maskPhone(details.phone, this.options.phoneDigits));
    for (const [key, value] of Object.entries(details.extra)) {
      if (/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) && Object.keys(out).length < 40) put(key, value);
    }
    return out;
  }
}

export function extensionOf(contentType: string): string {
  switch (contentType) {
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/flac':
      return 'flac';
    case 'audio/mp4':
    case 'audio/x-m4a':
      return 'm4a';
    default:
      return 'mp3';
  }
}
