import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { DialerService } from '@likho-ai/contracts/dialer/v1/dialer_pb';
import { connect, StringCodec, type NatsConnection } from 'nats';
import pg from 'pg';
import { App } from '../src/app.js';
import { dialerClock, hangupBy } from '../src/lists.js';
import { newId } from '../src/ids.js';
import { silent } from '../src/log.js';
import { FakeAmeyo, FakeLikho } from './fakes.js';
import { requireStack, testConfig, testDb, type TestDb } from './harness.js';

const stackUp = await requireStack();
const codec = StringCodec();
const WORKSPACE = 'wsp_01TEST0000000000000000000A';

describe('the dialer’s clock', () => {
  it('turns a moment into the dialer’s own wall-clock text', () => {
    expect(dialerClock(new Date('2026-10-02T05:00:00Z'), 'Asia/Kolkata')).toBe('2026-10-02 10:30:00');
    expect(dialerClock(new Date('2026-10-02T23:59:59Z'), 'UTC')).toBe('2026-10-02 23:59:59');
    expect(hangupBy('CUSTOMER_HANGUP_PHONE')).toBe('customer');
    expect(hangupBy('AGENT_HANGUP_PHONE')).toBe('agent');
    expect(hangupBy('')).toBe('');
  });
});

describe.skipIf(!stackUp)('the dialer’s lists and the live settings', () => {
  let db: TestDb;
  let dialerDb: pg.Client;
  let dialerSchema = '';
  let ameyo: FakeAmeyo;
  let likho: FakeLikho;
  let app: App;
  let nats: NatsConnection;
  let client: ReturnType<typeof createClient<typeof DialerService>>;
  const window = (since: string, until: string) => ({
    since: timestampFromDate(new Date(since)),
    until: timestampFromDate(new Date(until)),
  });

  beforeAll(async () => {
    db = await testDb();
    // The made-up dialer table of the example queries, in a schema of its own (the connector's
    // state has a table named calls too).
    dialerSchema = `${db.schema}_dialer`;
    const base = new URL(db.url);
    base.searchParams.delete('options');
    dialerDb = new pg.Client({ connectionString: base.toString() });
    await dialerDb.connect();
    await dialerDb.query(`CREATE SCHEMA ${dialerSchema}`);
    await dialerDb.query(`CREATE TABLE ${dialerSchema}.calls (
      crt_object_id text, call_id text, call_time timestamp, campaign_name text, agent_id text,
      disposition text, talk_time_seconds int, customer_phone text, status text)`);
    const rows: [string, string, string, string, string, number, string][] = [
      ['crt-1', 'c-1', '2026-10-02 10:00:00', 'Sales', 'asha', 120, 'connected'],
      ['crt-2', 'c-2', '2026-10-02 10:05:00', 'Sales', 'ravi', 40, 'connected'],
      ['crt-3', 'c-3', '2026-10-02 10:10:00', 'Sales', 'asha', 0, 'no_answer'],
      ['crt-4', 'c-4', '2026-10-02 11:00:00', 'Support', 'asha', 300, 'connected'],
      ['crt-5', 'c-5', '2026-10-03 09:00:00', 'Sales', 'ravi', 90, 'connected'],
    ];
    for (const [crt, id, time, campaign, agent, talk, status] of rows) {
      await dialerDb.query(
        `INSERT INTO ${dialerSchema}.calls VALUES ($1, $2, $3, $4, $5, 'Sale', $6, '9876543210', $7)`,
        [crt, id, time, campaign, agent, talk, status],
      );
    }
    const dialerUrl = new URL(base.toString());
    dialerUrl.searchParams.set('options', `-c search_path=${dialerSchema}`);

    ameyo = await new FakeAmeyo().start();
    likho = await new FakeLikho().start();
    nats = await connect({ servers: testConfig(db).NATS_URL });
    app = await App.start(
      testConfig(db, {
        AMEYO_VOICELOG_URL: ameyo.url,
        LIKHO_API_URL: likho.url,
        DIALER_DATABASE_URL: dialerUrl.toString(),
        DIALER_TIMEZONE: 'Asia/Kolkata',
        CAMPAIGNS_LIST_QUERY_FILE: 'queries/campaigns.example.sql',
        AGENTS_QUERY_FILE: 'queries/agents.example.sql',
        WINDOW_QUERY_FILE: 'queries/window.example.sql',
        CALLS_QUERY_FILE: 'queries/calls.example.sql',
        CALL_QUERY_FILE: 'queries/call.example.sql',
      }),
      silent,
    );
    client = createClient(DialerService, createGrpcTransport({ baseUrl: `http://${app.rpcAddress()}` }));
  });
  afterAll(async () => {
    await app.events.forget();
    await app.stop();
    await nats.close();
    await ameyo.close();
    await likho.close();
    await dialerDb.query(`DROP SCHEMA ${dialerSchema} CASCADE`);
    await dialerDb.end();
    await db.drop();
  });

  // 2 October 2026 in the dialer's clock (India time) is 1 October 18:30 to 2 October 18:30 UTC.
  const day = window('2026-10-01T18:30:00Z', '2026-10-02T18:30:00Z');

  it('lists the campaigns and the agents of a window, read in the dialer’s own clock', async () => {
    const { campaigns } = await client.listCampaigns({ window: day });
    expect(
      campaigns.map((c) => [
        c.name,
        Number(c.calls),
        Number(c.connected),
        Number(c.interactions),
        Number(c.talkSeconds),
      ]),
    ).toEqual([
      ['Sales', 3, 2, 3, 160],
      ['Support', 1, 1, 1, 300],
    ]);
    const { agents } = await client.listAgents({ window: day, campaign: 'Sales' });
    expect(agents.map((a) => [a.name, Number(a.calls), Number(a.connected)])).toEqual([
      ['asha', 2, 1],
      ['ravi', 1, 1],
    ]);
    // Half an hour that, in UTC, is 04:30 to 05:00: 10:00 to 10:30 India time, three legs, two connected.
    const hour = await client.listCampaigns({
      window: window('2026-10-02T04:30:00Z', '2026-10-02T05:00:00Z'),
    });
    expect([Number(hour.campaigns[0]!.calls), Number(hour.campaigns[0]!.connected)]).toEqual([3, 2]);
  });

  it('lists the calls a page at a time, newest first, with the phone shortened', async () => {
    const first = await client.listCalls({ window: day, connectedOnly: true, limit: 2 });
    expect(first.calls.map((c) => c.crtObjectId)).toEqual(['crt-4', 'crt-2']);
    expect(first.calls[0]).toMatchObject({
      campaign: 'Support',
      agent: 'asha',
      talkSeconds: 300,
      connected: true,
      phone: '…3210',
    });
    expect(first.nextCursor).toBe('2');
    const next = await client.listCalls({
      window: day,
      connectedOnly: true,
      limit: 2,
      after: first.nextCursor,
    });
    expect(next.calls.map((c) => c.crtObjectId)).toEqual(['crt-1']);
    expect(next.nextCursor).toBe('');
    const all = await client.listCalls({ window: day, campaign: 'Sales', agent: 'asha' });
    expect(all.calls.map((c) => [c.crtObjectId, c.connected])).toEqual([
      ['crt-3', false],
      ['crt-1', true],
    ]);
    const long = await client.listCalls({ window: day, minTalkSeconds: 100 });
    expect(long.calls.map((c) => c.crtObjectId)).toEqual(['crt-4', 'crt-1']);
  });

  it('finds one call, and refuses what is wrong', async () => {
    const { call } = await client.getCall({ crtObjectId: 'crt-5' });
    expect(call).toMatchObject({ crtObjectId: 'crt-5', campaign: 'Sales', agent: 'ravi', talkSeconds: 90 });
    await expect(client.getCall({ crtObjectId: 'crt-none' })).rejects.toSatisfy(
      (e: unknown) => e instanceof ConnectError && e.code === Code.NotFound,
    );
    await expect(
      client.listCampaigns({ window: window('2026-10-03T00:00:00Z', '2026-10-02T00:00:00Z') }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConnectError && e.code === Code.InvalidArgument);
    await expect(client.listCalls({ window: day, after: 'x' })).rejects.toSatisfy(
      (e: unknown) => e instanceof ConnectError && e.code === Code.InvalidArgument,
    );
  });

  it('takes its settings from Likho, and again when they change', async () => {
    expect(likho.settingsAsked).toBeGreaterThan(0);
    expect(app.current()).toMatchObject({ from: 'likho', dailyLimit: 200, scheduleEnabled: false });
    let status = await client.getStatus({});
    expect(status).toMatchObject({
      databaseConfigured: true,
      scheduleEnabled: false,
      dailyLimit: 200,
      version: '0.4.0',
    });

    likho.settings.dialer = {
      ...likho.settings.dialer,
      campaigns: ['Sales'],
      dailyLimit: 7,
      minTalkSeconds: 45,
      phoneDigits: 2,
    };
    const id = newId('evt');
    await nats.jetstream().publish(
      'likho.settings.changed',
      codec.encode(
        JSON.stringify({
          specversion: '1.0',
          id,
          source: 'likho-api',
          type: 'likho.settings.changed.v1',
          time: new Date().toISOString(),
          subject: WORKSPACE,
          datacontenttype: 'application/json',
          data: { workspace_id: WORKSPACE, keys: ['dialer.campaigns', 'dialer.daily_limit'] },
        }),
      ),
      { msgID: id },
    );
    const deadline = Date.now() + 15_000;
    while (app.current().dailyLimit !== 7 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 100));
    expect(app.current()).toMatchObject({ dailyLimit: 7, campaigns: ['Sales'], minTalkSeconds: 45 });
    status = await client.getStatus({});
    expect(status).toMatchObject({ dailyLimit: 7, campaigns: ['Sales'], minTalkSeconds: 45 });
    // The phone digits apply to what is listed from now on.
    const { calls } = await client.listCalls({ window: day, limit: 1 });
    expect(calls[0]!.phone).toBe('…10');
  });

  it('asks Likho again until it answers, when it was not there at the start', async () => {
    const late = await new FakeLikho().start();
    late.settingsDown = true;
    late.settings.dialer = { ...late.settings.dialer, dailyLimit: 33 };
    const second = await App.start(
      testConfig(db, {
        LIKHO_API_URL: late.url,
        CONSUMER_GROUP: `${db.schema}-late`,
        SETTINGS_RETRY_SECONDS: 1,
      }),
      silent,
    );
    try {
      expect(second.current().from).toBe('env');
      late.settingsDown = false;
      const deadline = Date.now() + 10_000;
      while (second.current().from !== 'likho' && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 100));
      expect(second.current()).toMatchObject({ from: 'likho', dailyLimit: 33 });
    } finally {
      await second.events.forget();
      await second.stop();
      await late.close();
    }
  });
});
