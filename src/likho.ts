/**
 * likho-api's REST API, with an API key: a recording is made, its file is PUT to the link
 * likho-media handed out, a job may be started, a transcript may be read.
 */
import { createHash } from 'node:crypto';

export interface RecordingSummary {
  id: string;
  originalName: string;
  status: string;
  externalId: string;
  source: string;
  latestTranscriptId: string;
}

export interface Uploaded {
  recording: RecordingSummary;
  /** True when the same audio was there already and that recording is reused. */
  existing: boolean;
}

export interface TranscriptLine {
  index: number;
  startSeconds: number;
  endSeconds: number;
  textScript: string;
  textRoman: string;
}

export class LikhoApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class LikhoApi {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!response.ok) {
      const error = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
      throw new LikhoApiError(
        error?.code ?? `http_${response.status}`,
        error?.message ?? `likho-api answered ${response.status}`,
        response.status,
      );
    }
    return parsed as T;
  }

  /** Makes the recording and sends the audio to likho-media; a duplicate reuses the earlier recording. */
  async upload(input: {
    originalName: string;
    bytes: Uint8Array;
    contentType: string;
    externalId: string;
    source: string;
    attributes: Record<string, string>;
  }): Promise<Uploaded> {
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const ticket = await this.call<{
      recording: RecordingSummary;
      uploadUrl: string;
      duplicateOf: RecordingSummary | null;
    }>('POST', '/api/v1/recordings', {
      originalName: input.originalName,
      sizeBytes: input.bytes.byteLength,
      contentType: input.contentType,
      sha256,
      externalId: input.externalId,
      source: input.source,
      attributes: input.attributes,
    });
    if (ticket.duplicateOf) return { recording: ticket.duplicateOf, existing: true };
    const put = await this.fetchImpl(ticket.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': input.contentType },
      body: new Blob([input.bytes as BlobPart]),
      signal: AbortSignal.timeout(600_000),
    });
    if (!put.ok)
      throw new LikhoApiError('upload_failed', `the audio could not be stored (${put.status})`, put.status);
    return { recording: ticket.recording, existing: false };
  }

  async recording(id: string): Promise<RecordingSummary> {
    return this.call<RecordingSummary>('GET', `/api/v1/recordings/${id}`);
  }

  /** Queues a transcription; a recording that already has a job running is left alone. */
  async transcribe(recordingId: string): Promise<void> {
    try {
      await this.call('POST', `/api/v1/recordings/${recordingId}/jobs`, {});
    } catch (error) {
      if (error instanceof LikhoApiError && error.code === 'invalid') return;
      throw error;
    }
  }

  /** The newest transcript's lines, or null while there is none. */
  async transcript(recordingId: string): Promise<{ status: string; lines: TranscriptLine[] } | null> {
    const reply = await this.call<{ status: string; transcript: { segments: TranscriptLine[] } | null }>(
      'GET',
      `/api/v1/recordings/${recordingId}/transcript`,
    );
    if (!reply.transcript) return null;
    return { status: reply.status, lines: reply.transcript.segments };
  }
}

/** The Hinglish layer as one text, one line per segment. */
export function hinglishText(lines: TranscriptLine[]): string {
  return lines
    .map((l) => l.textRoman.trim())
    .filter(Boolean)
    .join('\n');
}
