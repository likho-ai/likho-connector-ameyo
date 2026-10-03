/**
 * The dialer's voice-log API. One call, one recording, fetched by the interaction's id:
 *
 *   GET <AMEYO_VOICELOG_URL>/command?command=downloadVoiceLog&data={'crtObjectId':'<id>','targetFormat':'mp3'}
 *   headers: hash-key, policy-name, requesting-host (the dialer's API credentials)
 *
 * The dialer answers with the audio, or with something that is not audio: an empty body, the
 * literal "null" (a wrong key), an HTML page (no session), or JSON with a message. Each of those
 * is turned into a reason a person understands and a code the import carries.
 */

export type FetchResult =
  | { kind: 'audio'; bytes: Uint8Array; contentType: string }
  | { kind: 'no_recording' | 'not_found' | 'unavailable' | 'rejected' | 'error'; reason: string };

export interface AmeyoOptions {
  baseUrl: string;
  hashKey?: string;
  policyName?: string;
  requestingHost?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export class AmeyoClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AmeyoOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** The address a recording is downloaded from (the dialer's own single-quoted JSON form). */
  url(crtObjectId: string, targetFormat = 'mp3'): string {
    const data = `{'crtObjectId':'${crtObjectId}','targetFormat':'${targetFormat}'}`;
    return `${this.options.baseUrl.replace(/\/+$/, '')}/command?command=downloadVoiceLog&data=${encodeURIComponent(data)}`;
  }

  /** Fetches the recording of one interaction. */
  async download(crtObjectId: string): Promise<FetchResult> {
    if (!ID_PATTERN.test(crtObjectId))
      return { kind: 'rejected', reason: 'The call id is not in the dialer’s form.' };
    if (!this.options.baseUrl)
      return { kind: 'unavailable', reason: 'The dialer’s address is not set (AMEYO_VOICELOG_URL).' };
    const headers: Record<string, string> = { accept: 'audio/mpeg, audio/*;q=0.9, */*;q=0.1' };
    if (this.options.hashKey) headers['hash-key'] = this.options.hashKey;
    if (this.options.policyName) headers['policy-name'] = this.options.policyName;
    if (this.options.requestingHost) headers['requesting-host'] = this.options.requestingHost;

    let response: Response;
    try {
      response = await this.fetchImpl(this.url(crtObjectId), {
        headers,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.name === 'TimeoutError'
          ? 'The dialer did not answer in time.'
          : 'The dialer could not be reached.';
      return { kind: 'unavailable', reason };
    }
    if (response.status === 404) return { kind: 'not_found', reason: 'The dialer has no such call.' };
    if (response.status === 401 || response.status === 403)
      return { kind: 'unavailable', reason: 'The dialer refused the connector’s credentials.' };
    if (response.status >= 500)
      return { kind: 'unavailable', reason: `The dialer answered ${response.status}.` };
    if (!response.ok) return { kind: 'error', reason: `The dialer answered ${response.status}.` };

    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (bytes.length === 0)
      return { kind: 'no_recording', reason: 'The dialer has no recording for this call.' };
    if (
      contentType.startsWith('audio/') ||
      contentType === 'application/octet-stream' ||
      looksLikeAudio(bytes)
    ) {
      return {
        kind: 'audio',
        bytes,
        contentType: contentType.startsWith('audio/') ? contentType : sniffType(bytes),
      };
    }
    const text = new TextDecoder().decode(bytes.slice(0, 2000)).trim();
    if (text === 'null')
      return { kind: 'unavailable', reason: 'The dialer refused the connector’s key (it answered null).' };
    if (text.startsWith('{') || text.startsWith('[')) {
      let message = '';
      try {
        const body = JSON.parse(text) as { message?: string; error?: string };
        message = body.message ?? body.error ?? '';
      } catch {
        /* not JSON after all */
      }
      return {
        kind: 'no_recording',
        reason: message ? `The dialer said: ${message}` : 'The dialer has no recording for this call.',
      };
    }
    if (/<html/i.test(text))
      return { kind: 'unavailable', reason: 'The dialer asked for a sign-in instead of sending the audio.' };
    return {
      kind: 'error',
      reason: `The dialer sent something that is not audio (${contentType || 'no content type'}).`,
    };
  }
}

/** MP3 (ID3 tag or a frame sync), WAV (RIFF), OGG, FLAC, or MP4/M4A (ftyp). */
export function looksLikeAudio(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const head = String.fromCharCode(...bytes.slice(0, 4));
  if (head.startsWith('ID3') || head === 'RIFF' || head === 'OggS' || head === 'fLaC') return true;
  if (String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp') return true;
  return bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
}

export function sniffType(bytes: Uint8Array): string {
  const head = String.fromCharCode(...bytes.slice(0, 4));
  if (head === 'RIFF') return 'audio/wav';
  if (head === 'OggS') return 'audio/ogg';
  if (head === 'fLaC') return 'audio/flac';
  if (String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp') return 'audio/mp4';
  return 'audio/mpeg';
}
