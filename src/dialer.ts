/**
 * The dialer's reporting database (PostgreSQL), read only: which calls there are and what is
 * known about each. The SQL is a file of the installation (queries/calls.local.sql, …), because
 * the tables and the campaigns are the company's; this module only fixes the columns a query
 * must return:
 *
 *   crt_object_id   the interaction's id (one recording per interaction)      required
 *   call_id         the leg's id                                               optional
 *   call_time       when the call happened, as the dialer writes it (text)     optional
 *   campaign, agent, disposition, talk_seconds, phone                          optional
 *   any other column                                                           kept as an attribute
 *
 * calls.sql takes $1 = the cursor (the call_time the last batch ended at) and $2 = the batch
 * size, and returns calls after the cursor, oldest first. call.sql takes $1 = a crt_object_id.
 * crt.sql takes $1 = one leg's call_id and returns its interaction's crt_object_id (one column, one
 * row): reports show call ids, and the recording is filed under the interaction.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

export interface CallRecord {
  crtObjectId: string;
  callId: string;
  callTime: string;
  campaign: string;
  agent: string;
  disposition: string;
  talkSeconds: number;
  phone: string;
  /** Every other column of the row, as text. */
  extra: Record<string, string>;
}

const KNOWN = new Set([
  'crt_object_id',
  'call_id',
  'call_time',
  'campaign',
  'agent',
  'disposition',
  'talk_seconds',
  'phone',
]);

/** Turns a row of the contract above into a CallRecord. */
export function toCall(row: Record<string, unknown>): CallRecord | null {
  const id = text(row.crt_object_id);
  if (!id) return null;
  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    if (KNOWN.has(key) || value == null) continue;
    const t = text(value);
    if (t) extra[key] = t;
  }
  return {
    crtObjectId: id,
    callId: text(row.call_id),
    callTime: text(row.call_time),
    campaign: text(row.campaign),
    agent: text(row.agent),
    disposition: text(row.disposition),
    talkSeconds: Number(row.talk_seconds ?? 0) || 0,
    phone: text(row.phone),
    extra,
  };
}

function text(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

/** Keeps only the last `digits` of a phone number; 0 = nothing at all. */
export function maskPhone(phone: string, digits: number): string {
  const only = phone.replace(/\D/g, '');
  if (!only || digits <= 0) return '';
  return '…' + only.slice(-digits);
}

export interface DialerDb {
  callsSince(cursor: string, limit: number): Promise<CallRecord[]>;
  call(crtObjectId: string): Promise<CallRecord | null>;
  /** The interaction (crt_object_id) a leg's call_id belongs to, or null. */
  crtOfCall(callId: string): Promise<string | null>;
  close(): Promise<void>;
}

/** Opens the dialer's database with the queries read from their files. */
export function openDialerDb(
  url: string,
  callsQueryFile: string,
  callQueryFile: string,
  crtQueryFile: string,
): DialerDb {
  const pool = new pg.Pool({ connectionString: url, max: 2, statement_timeout: 60_000 });
  const callsQuery = readFileSync(callsQueryFile, 'utf8');
  const callQuery = readFileSync(callQueryFile, 'utf8');
  const crtQuery = readFileSync(crtQueryFile, 'utf8');
  return {
    async callsSince(cursor, limit) {
      const result = await pool.query(callsQuery, [cursor, limit]);
      return result.rows
        .map((row) => toCall(row as Record<string, unknown>))
        .filter((c): c is CallRecord => c !== null);
    },
    async call(crtObjectId) {
      const result = await pool.query(callQuery, [crtObjectId]);
      const row = result.rows[0];
      return row ? toCall(row as Record<string, unknown>) : null;
    },
    async crtOfCall(callId) {
      const result = await pool.query(crtQuery, [callId]);
      const value = result.rows[0] ? Object.values(result.rows[0])[0] : null;
      return value ? String(value).trim() || null : null;
    },
    close: () => pool.end(),
  };
}
