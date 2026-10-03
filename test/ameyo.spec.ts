import { AmeyoClient, looksLikeAudio } from '../src/ameyo.js';
import { FakeAmeyo, MP3 } from './fakes.js';

describe('the dialer’s voice-log API', () => {
  let dialer: FakeAmeyo;
  let client: AmeyoClient;

  beforeAll(async () => {
    dialer = await new FakeAmeyo().start();
    client = new AmeyoClient({
      baseUrl: dialer.url,
      hashKey: 'k',
      policyName: 'p',
      requestingHost: 'h',
      timeoutMs: 5_000,
    });
  });
  afterAll(() => dialer.close());

  it('builds the download address in the dialer’s own form', () => {
    expect(client.url('d000-0a1b2c3d-vce-0001')).toBe(
      `${dialer.url}/command?command=downloadVoiceLog&data=%7B'crtObjectId'%3A'd000-0a1b2c3d-vce-0001'%2C'targetFormat'%3A'mp3'%7D`,
    );
  });

  it('returns the audio with the credentials sent as headers', async () => {
    dialer.answers.set('d000-0a1b2c3d-vce-0001', { body: MP3 });
    const result = await client.download('d000-0a1b2c3d-vce-0001');
    expect(result).toMatchObject({ kind: 'audio', contentType: 'audio/mpeg' });
    expect(dialer.asked.at(-1)).toEqual({
      id: 'd000-0a1b2c3d-vce-0001',
      headers: { hashKey: 'k', policy: 'p' },
    });
  });

  it('recognises audio without a content type by its first bytes', async () => {
    dialer.answers.set('d000-0a1b2c3d-vce-0002', { body: MP3, type: 'text/plain' });
    expect(await client.download('d000-0a1b2c3d-vce-0002')).toMatchObject({
      kind: 'audio',
      contentType: 'audio/mpeg',
    });
    expect(looksLikeAudio(new TextEncoder().encode('<html>no</html>'))).toBe(false);
    expect(
      looksLikeAudio(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])),
    ).toBe(true);
  });

  it('turns what is not audio into a reason and a code', async () => {
    dialer.answers.set('d000-0a1b2c3d-vce-0003', { body: '', type: 'audio/mpeg' });
    dialer.answers.set('d000-0a1b2c3d-vce-0004', { body: 'null', type: 'text/plain' });
    dialer.answers.set('d000-0a1b2c3d-vce-0005', {
      body: JSON.stringify({ message: 'No voicelog' }),
      type: 'application/json',
    });
    dialer.answers.set('d000-0a1b2c3d-vce-0006', {
      body: '<html><body>login</body></html>',
      type: 'text/html',
    });
    dialer.answers.set('d000-0a1b2c3d-vce-0007', { body: 'down', status: 503, type: 'text/plain' });
    expect(await client.download('d000-0a1b2c3d-vce-0003')).toMatchObject({ kind: 'no_recording' });
    expect(await client.download('d000-0a1b2c3d-vce-0004')).toMatchObject({
      kind: 'unavailable',
      reason: /key/,
    });
    expect(await client.download('d000-0a1b2c3d-vce-0005')).toMatchObject({
      kind: 'no_recording',
      reason: 'The dialer said: No voicelog',
    });
    expect(await client.download('d000-0a1b2c3d-vce-0006')).toMatchObject({
      kind: 'unavailable',
      reason: /sign-in/,
    });
    expect(await client.download('d000-0a1b2c3d-vce-0007')).toMatchObject({
      kind: 'unavailable',
      reason: /503/,
    });
    expect(await client.download('d000-0a1b2c3d-vce-0008')).toMatchObject({ kind: 'not_found' });
    expect(await client.download('bad id!')).toMatchObject({ kind: 'rejected' });
  });

  it('says so when the dialer cannot be reached or is not set', async () => {
    const nowhere = new AmeyoClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2_000 });
    expect(await nowhere.download('d000-0a1b2c3d-vce-0001')).toMatchObject({
      kind: 'unavailable',
      reason: /reached/,
    });
    const unset = new AmeyoClient({ baseUrl: '' });
    expect(await unset.download('d000-0a1b2c3d-vce-0001')).toMatchObject({
      kind: 'unavailable',
      reason: /AMEYO_VOICELOG_URL/,
    });
  });
});
