/**
 * The connector's own state (PostgreSQL, database likho_connector): which calls were fetched
 * and what came of them, the schedule's cursor, and the events already acted on.
 */
import pg from 'pg';

export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: '0001_calls',
    sql: `
      CREATE TABLE IF NOT EXISTS calls (
        external_id      text PRIMARY KEY,
        workspace_id     text NOT NULL,
        status           text NOT NULL,          -- imported, failed, deleted
        recording_id     text NOT NULL DEFAULT '',
        code             text NOT NULL DEFAULT '',
        reason           text NOT NULL DEFAULT '',
        attempts         integer NOT NULL DEFAULT 0,
        call_time        text NOT NULL DEFAULT '',
        campaign         text NOT NULL DEFAULT '',
        requested_by     text NOT NULL DEFAULT '', -- 'schedule', 'cli', or the import request id
        written_back_at  timestamptz,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS calls_recording ON calls (recording_id);
      CREATE INDEX IF NOT EXISTS calls_created ON calls (created_at);
      CREATE TABLE IF NOT EXISTS cursors (
        name   text PRIMARY KEY,
        value  text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS handled_events (
        id         text PRIMARY KEY,
        handled_at timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
];

export type CallStatus = 'imported' | 'failed' | 'deleted';

export interface CallRow {
  externalId: string;
  workspaceId: string;
  status: CallStatus;
  recordingId: string;
  code: string;
  reason: string;
  attempts: number;
  callTime: string;
  campaign: string;
  requestedBy: string;
  writtenBackAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toRow(r: Record<string, unknown>): CallRow {
  return {
    externalId: String(r.external_id),
    workspaceId: String(r.workspace_id),
    status: r.status as CallStatus,
    recordingId: String(r.recording_id),
    code: String(r.code),
    reason: String(r.reason),
    attempts: Number(r.attempts),
    callTime: String(r.call_time),
    campaign: String(r.campaign),
    requestedBy: String(r.requested_by),
    writtenBackAt: (r.written_back_at as Date | null) ?? null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  };
}

export class State {
  private readonly pool: pg.Pool;

  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 4 });
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        'CREATE TABLE IF NOT EXISTS migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      for (const migration of MIGRATIONS) {
        const done = await client.query('SELECT 1 FROM migrations WHERE name = $1', [migration.name]);
        if (done.rowCount) continue;
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query('INSERT INTO migrations (name) VALUES ($1)', [migration.name]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    } finally {
      client.release();
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async call(externalId: string): Promise<CallRow | null> {
    const result = await this.pool.query('SELECT * FROM calls WHERE external_id = $1', [externalId]);
    return result.rows[0] ? toRow(result.rows[0]) : null;
  }

  async byRecording(recordingId: string): Promise<CallRow | null> {
    const result = await this.pool.query(
      'SELECT * FROM calls WHERE recording_id = $1 ORDER BY updated_at DESC LIMIT 1',
      [recordingId],
    );
    return result.rows[0] ? toRow(result.rows[0]) : null;
  }

  /** Records the outcome of an attempt (a new row, or the row of an earlier attempt). */
  async record(call: {
    externalId: string;
    workspaceId: string;
    status: CallStatus;
    recordingId?: string;
    code?: string;
    reason?: string;
    callTime?: string;
    campaign?: string;
    requestedBy?: string;
  }): Promise<CallRow> {
    const result = await this.pool.query(
      `INSERT INTO calls (external_id, workspace_id, status, recording_id, code, reason, attempts, call_time, campaign, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9)
       ON CONFLICT (external_id) DO UPDATE SET
         workspace_id = EXCLUDED.workspace_id, status = EXCLUDED.status, recording_id = EXCLUDED.recording_id,
         code = EXCLUDED.code, reason = EXCLUDED.reason, attempts = calls.attempts + 1,
         call_time = CASE WHEN EXCLUDED.call_time = '' THEN calls.call_time ELSE EXCLUDED.call_time END,
         campaign = CASE WHEN EXCLUDED.campaign = '' THEN calls.campaign ELSE EXCLUDED.campaign END,
         requested_by = EXCLUDED.requested_by, updated_at = now()
       RETURNING *`,
      [
        call.externalId,
        call.workspaceId,
        call.status,
        call.recordingId ?? '',
        call.code ?? '',
        call.reason ?? '',
        call.callTime ?? '',
        call.campaign ?? '',
        call.requestedBy ?? '',
      ],
    );
    return toRow(result.rows[0]);
  }

  /** The recording is gone from Likho: the call may be fetched again. */
  async forgetRecording(recordingId: string): Promise<void> {
    await this.pool.query(
      `UPDATE calls SET status = 'deleted', updated_at = now() WHERE recording_id = $1 AND status = 'imported'`,
      [recordingId],
    );
  }

  async markWrittenBack(recordingId: string): Promise<void> {
    await this.pool.query(
      'UPDATE calls SET written_back_at = now(), updated_at = now() WHERE recording_id = $1',
      [recordingId],
    );
  }

  /** How many calls were fetched today (UTC), for the daily budget. */
  async importedToday(): Promise<number> {
    const result = await this.pool.query(
      `SELECT count(*)::int AS n FROM calls WHERE status = 'imported' AND created_at >= date_trunc('day', now())`,
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async cursor(name: string): Promise<string | null> {
    const result = await this.pool.query('SELECT value FROM cursors WHERE name = $1', [name]);
    return result.rows[0] ? String(result.rows[0].value) : null;
  }

  async setCursor(name: string, value: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO cursors (name, value) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [name, value],
    );
  }

  /** True the first time an event id is seen; false when it was acted on before. */
  async firstTime(eventId: string): Promise<boolean> {
    const result = await this.pool.query(
      'INSERT INTO handled_events (id) VALUES ($1) ON CONFLICT DO NOTHING',
      [eventId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async unhandle(eventId: string): Promise<void> {
    await this.pool.query('DELETE FROM handled_events WHERE id = $1', [eventId]);
  }

  /** A short account of the state, for `status`. */
  async summary(): Promise<{
    imported: number;
    failed: number;
    deleted: number;
    today: number;
    cursor: string | null;
    writtenBack: number;
  }> {
    const counts = await this.pool.query(`SELECT status, count(*)::int AS n FROM calls GROUP BY status`);
    const by: Record<string, number> = {};
    for (const row of counts.rows) by[String(row.status)] = Number(row.n);
    const written = await this.pool.query(
      `SELECT count(*)::int AS n FROM calls WHERE written_back_at IS NOT NULL`,
    );
    return {
      imported: by.imported ?? 0,
      failed: by.failed ?? 0,
      deleted: by.deleted ?? 0,
      today: await this.importedToday(),
      cursor: await this.cursor('schedule'),
      writtenBack: Number(written.rows[0]?.n ?? 0),
    };
  }
}
