import { connect, StringCodec, type NatsConnection } from 'nats';
import { App } from '../src/app.js';
import { newId } from '../src/ids.js';
import { silent } from '../src/log.js';
import { FakeAmeyo, FakeLikho, MP3 } from './fakes.js';
import { requireStack, testConfig, testDb, type TestDb } from './harness.js';

const stackUp = await requireStack();
const codec = StringCodec();
const WORKSPACE = 'wsp_01TEST0000000000000000000A';

describe.skipIf(!stackUp)('the connector on the bus', () => {
  let db: TestDb;
  let dialer: FakeAmeyo;
  let likho: FakeLikho;
  let app: App;
  let source = '';
  let nats: NatsConnection;
  const seen: { subject: string; body: Record<string, any> }[] = [];

  const publish = async (subject: string, type: string, data: Record<string, unknown>) => {
    const id = newId('evt');
    const body = {
      specversion: '1.0',
      id,
      source: 'likho-api',
      type,
      time: new Date().toISOString(),
      subject: String(data.request_id ?? data.recording_id ?? ''),
      datacontenttype: 'application/json',
      data,
    };
    await nats.jetstream().publish(subject, codec.encode(JSON.stringify(body)), { msgID: id });
  };
  const until = async <T>(check: () => T | undefined, what: string, ms = 15_000): Promise<T> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = check();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  beforeAll(async () => {
    db = await testDb();
    dialer = await new FakeAmeyo().start();
    likho = await new FakeLikho().start();
    nats = await connect({ servers: testConfig(db).NATS_URL });
    nats.subscribe('likho.import.>', {
      callback: (_error, message) => {
        try {
          seen.push({ subject: message.subject, body: JSON.parse(codec.decode(message.data)) });
        } catch {
          /* not JSON */
        }
      },
    });
    const config = testConfig(db, { AMEYO_VOICELOG_URL: dialer.url, LIKHO_API_URL: likho.url });
    source = config.SOURCE;
    app = await App.start(config, silent);
  });
  afterAll(async () => {
    await app.events.forget();
    await app.stop();
    await nats.close();
    await dialer.close();
    await likho.close();
    await db.drop();
  });

  it('answers /healthz and /readyz', async () => {
    expect((await fetch(`http://${app.address()}/healthz`)).status).toBe(200);
    expect((await fetch(`http://${app.address()}/readyz`)).status).toBe(200);
    const metrics = await fetch(`http://${app.address()}/metrics`);
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain('likho_connector_');
  });

  it('takes an import request, fetches the call, and answers on the bus', async () => {
    dialer.answers.set('d000-0a1b2c3d-vce-0001', { body: MP3 });
    const requestId = newId('imp');
    await publish('likho.import.requested', 'likho.import.requested.v1', {
      request_id: requestId,
      workspace_id: WORKSPACE,
      source,
      external_id: 'd000-0a1b2c3d-vce-0001',
      transcribe: true,
    });
    const answer = await until(
      () => seen.find((e) => e.subject === 'likho.import.completed' && e.body.data.request_id === requestId),
      'the import to complete',
    );
    expect(answer.body).toMatchObject({
      type: 'likho.import.completed.v1',
      source: 'likho-connector-ameyo',
      data: {
        workspace_id: WORKSPACE,
        source,
        external_id: 'd000-0a1b2c3d-vce-0001',
        existing: false,
      },
    });
    expect(likho.recordings[0]).toMatchObject({ externalId: 'd000-0a1b2c3d-vce-0001', source });
    expect(answer.body.data.recording_id).toBe(likho.recordings[0]!.id);
  });

  it('answers with the reason when the dialer has no recording, and ignores other workspaces', async () => {
    dialer.answers.set('d000-0a1b2c3d-vce-0002', { body: '', type: 'audio/mpeg' });
    const requestId = newId('imp');
    await publish('likho.import.requested', 'likho.import.requested.v1', {
      request_id: requestId,
      workspace_id: WORKSPACE,
      source,
      external_id: 'd000-0a1b2c3d-vce-0002',
    });
    const failed = await until(
      () => seen.find((e) => e.subject === 'likho.import.failed' && e.body.data.request_id === requestId),
      'the import to fail',
    );
    expect(failed.body.data).toMatchObject({
      code: 'no_recording',
      reason: 'The dialer has no recording for this call.',
    });

    const other = newId('imp');
    dialer.asked.length = 0;
    await publish('likho.import.requested', 'likho.import.requested.v1', {
      request_id: other,
      workspace_id: 'wsp_01OTHER000000000000000000B',
      source,
      external_id: 'd000-0a1b2c3d-vce-0001',
    });
    await new Promise((r) => setTimeout(r, 1_000));
    expect(dialer.asked).toHaveLength(0);
    expect(
      seen.find((e) => e.subject !== 'likho.import.requested' && e.body.data.request_id === other),
    ).toBeUndefined();
  });

  it('forgets a deleted recording and fetches the call again when asked', async () => {
    const recording = likho.recordings[0]!;
    await publish('likho.recording.deleted', 'likho.recording.deleted.v1', {
      recording_id: recording.id,
      workspace_id: WORKSPACE,
    });
    likho.recordings.length = 0;
    dialer.asked.length = 0;
    const requestId = newId('imp');
    await new Promise((r) => setTimeout(r, 500)); // the deletion is silent; give it a moment to be taken
    await publish('likho.import.requested', 'likho.import.requested.v1', {
      request_id: requestId,
      workspace_id: WORKSPACE,
      source,
      external_id: 'd000-0a1b2c3d-vce-0001',
    });
    const answer = await until(
      () => seen.find((e) => e.subject === 'likho.import.completed' && e.body.data.request_id === requestId),
      'the call to be fetched again',
    );
    expect(answer.body.data.existing).toBe(false);
    expect(dialer.asked.map((a) => a.id)).toEqual(['d000-0a1b2c3d-vce-0001']);
  });
});
