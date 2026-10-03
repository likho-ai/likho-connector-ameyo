import { AmeyoClient } from '../src/ameyo.js';
import type { CallRecord, DialerDb } from '../src/dialer.js';
import { Importer } from '../src/importer.js';
import { LikhoApi } from '../src/likho.js';
import { silent } from '../src/log.js';
import { Schedule } from '../src/schedule.js';
import { State } from '../src/state.js';
import { FakeAmeyo, FakeLikho, MP3 } from './fakes.js';
import { requireStack, testDb, type TestDb } from './harness.js';

const stackUp = await requireStack();
const WORKSPACE = 'wsp_01TEST0000000000000000000A';

const call = (id: string, extra: Partial<CallRecord> = {}): CallRecord => ({
  crtObjectId: id,
  callId: '1',
  callTime: '2026-10-03 09:00:00',
  campaign: 'Inbound',
  agent: 'agent-1',
  disposition: 'sale',
  talkSeconds: 60,
  phone: '9876543210',
  extra: {},
  ...extra,
});

/** A dialer database with a few calls in it. */
function dialerWith(calls: CallRecord[]): DialerDb {
  return {
    async callsSince(cursor, limit) {
      return calls
        .filter((c) => c.callTime > cursor)
        .sort((a, b) => a.callTime.localeCompare(b.callTime))
        .slice(0, limit);
    },
    async call(id) {
      return calls.find((c) => c.crtObjectId === id) ?? null;
    },
    async close() {},
  };
}

describe.skipIf(!stackUp)('fetching a call into Likho', () => {
  let db: TestDb;
  let state: State;
  let dialer: FakeAmeyo;
  let likho: FakeLikho;
  let importer: Importer;

  beforeAll(async () => {
    db = await testDb();
    state = new State(db.url);
    await state.migrate();
    dialer = await new FakeAmeyo().start();
    likho = await new FakeLikho().start();
    importer = new Importer(
      new AmeyoClient({ baseUrl: dialer.url, timeoutMs: 5_000 }),
      new LikhoApi(likho.url, 'lk_test'),
      state,
      dialerWith([call('d000-0a1b2c3d-vce-0001', { extra: { lead_source: 'tv' } })]),
      { source: 'ameyo', phoneDigits: 4 },
      silent,
    );
  });
  afterAll(async () => {
    await state.close();
    await dialer.close();
    await likho.close();
    await db.drop();
  });

  it('fetches the audio, makes the recording with the details, and remembers it', async () => {
    dialer.answers.set('d000-0a1b2c3d-vce-0001', { body: MP3 });
    const outcome = await importer.run({
      externalId: 'd000-0a1b2c3d-vce-0001',
      workspaceId: WORKSPACE,
      requestedBy: 'cli',
    });
    expect(outcome).toMatchObject({ ok: true, existing: false });
    const recording = likho.recordings[0]!;
    expect(recording).toMatchObject({
      originalName: 'd000-0a1b2c3d-vce-0001.mp3',
      externalId: 'd000-0a1b2c3d-vce-0001',
      source: 'ameyo',
      status: 'ready',
      attributes: {
        campaign: 'Inbound',
        agent: 'agent-1',
        disposition: 'sale',
        talkSeconds: '60',
        phone: '…3210',
        lead_source: 'tv',
      },
    });
    expect(likho.uploads).toEqual([{ id: recording.id, bytes: MP3.length, contentType: 'audio/mpeg' }]);
    expect(await state.call('d000-0a1b2c3d-vce-0001')).toMatchObject({
      status: 'imported',
      recordingId: recording.id,
      campaign: 'Inbound',
    });

    // Asked again: nothing is fetched twice; a recording that is ready and idle gets its job.
    dialer.asked.length = 0;
    const again = await importer.run({
      externalId: 'd000-0a1b2c3d-vce-0001',
      workspaceId: WORKSPACE,
      requestedBy: 'imp_1',
    });
    expect(again).toMatchObject({ ok: true, existing: true, recordingId: recording.id });
    expect(dialer.asked).toHaveLength(0);
    expect(likho.jobs).toEqual([recording.id]);
  });

  it('reports why a call could not be fetched, and whether to try later', async () => {
    dialer.answers.set('d000-0a1b2c3d-vce-0002', { body: '', type: 'audio/mpeg' });
    expect(
      await importer.run({
        externalId: 'd000-0a1b2c3d-vce-0002',
        workspaceId: WORKSPACE,
        requestedBy: 'cli',
      }),
    ).toMatchObject({
      ok: false,
      code: 'no_recording',
      retry: false,
    });
    expect(await state.call('d000-0a1b2c3d-vce-0002')).toMatchObject({
      status: 'failed',
      code: 'no_recording',
    });

    dialer.down = true;
    expect(
      await importer.run({
        externalId: 'd000-0a1b2c3d-vce-0003',
        workspaceId: WORKSPACE,
        requestedBy: 'cli',
      }),
    ).toMatchObject({
      ok: false,
      code: 'unavailable',
      retry: true,
    });
    dialer.down = false;

    // The same audio under another id: likho-media knows it; the earlier recording is reused.
    dialer.answers.set('d000-0a1b2c3d-vce-0004', { body: MP3 });
    const duplicate = await importer.run({
      externalId: 'd000-0a1b2c3d-vce-0004',
      workspaceId: WORKSPACE,
      requestedBy: 'cli',
    });
    expect(duplicate).toMatchObject({ ok: true, existing: true, recordingId: likho.recordings[0]!.id });
  });

  it('forgets a recording deleted in Likho, so the call can be fetched again', async () => {
    const id = likho.recordings[0]!.id;
    await state.forgetRecording(id);
    expect(await state.call('d000-0a1b2c3d-vce-0001')).toMatchObject({ status: 'deleted' });
    likho.recordings.length = 0;
    const outcome = await importer.run({
      externalId: 'd000-0a1b2c3d-vce-0001',
      workspaceId: WORKSPACE,
      requestedBy: 'cli',
    });
    expect(outcome).toMatchObject({ ok: true, existing: false });
    expect((await state.call('d000-0a1b2c3d-vce-0001'))!.attempts).toBeGreaterThan(1);
  });

  it('the schedule takes the calls the policy allows, within the budget, and keeps its cursor', async () => {
    const calls = [
      call('d000-0a1b2c3d-vce-0101', { callTime: '2026-10-04 09:00:00' }),
      call('d000-0a1b2c3d-vce-0102', { callTime: '2026-10-04 09:01:00', talkSeconds: 5 }),
      call('d000-0a1b2c3d-vce-0103', { callTime: '2026-10-04 09:02:00', campaign: 'Other' }),
      call('d000-0a1b2c3d-vce-0104', { callTime: '2026-10-04 09:03:00' }),
      call('d000-0a1b2c3d-vce-0105', { callTime: '2026-10-04 09:04:00' }),
    ];
    for (const c of calls)
      dialer.answers.set(c.crtObjectId, {
        body: Uint8Array.from([...MP3, c.crtObjectId.charCodeAt(c.crtObjectId.length - 1)]),
      });
    const schedule = new Schedule(
      dialerWith(calls),
      importer,
      state,
      {
        workspaceId: WORKSPACE,
        batchLimit: 10,
        dailyLimit: (await state.importedToday()) + 2,
        start: '2026-10-04 00:00:00',
        policy: { campaigns: ['Inbound'], minTalkSeconds: 20 },
      },
      silent,
    );
    const first = await schedule.runOnce();
    expect(first).toMatchObject({ seen: 5, taken: 2, skipped: 2, failed: 0, budgetLeft: 0 });
    expect(await state.cursor('schedule')).toBe('2026-10-04 09:03:00');
    expect(await state.call('d000-0a1b2c3d-vce-0105')).toBeNull(); // over the budget: left for tomorrow
    const second = await schedule.runOnce();
    expect(second).toMatchObject({ seen: 0, taken: 0 }); // the budget is used up
  });
});
