/**
 * What the dialer knows about a window of its calls, from its reporting database, read only:
 * the campaigns and the agents with their counts, and the calls a page at a time. Like the
 * schedule's queries, the SQL is a file of the installation (queries/*.local.sql), because the
 * table and its columns are the company's; this module fixes the columns each query returns.
 *
 *   campaigns   $1 since, $2 until (the dialer's own clock, 'YYYY-MM-DD HH:MM:SS')
 *               → name, calls, connected, interactions, talk_seconds
 *   agents      $1 since, $2 until, $3 campaign ('' = any)
 *               → id, name, calls, connected, talk_seconds
 *   window      $1 since, $2 until, $3 campaign, $4 agent ('' = any), $5 connected only (boolean),
 *               $6 shortest talk in seconds, $7 offset, $8 how many
 *               → crt_object_id, call_id, call_time, campaign, transferred_campaign, agent,
 *                 agent_id, disposition, call_type, connected, talk_seconds, phone, hangup_by, queue
 *               newest first
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { maskPhone, type CallRecord } from './dialer.js';

export interface CampaignRow {
  name: string;
  calls: number;
  connected: number;
  interactions: number;
  talkSeconds: number;
}

export interface AgentRow {
  id: string;
  name: string;
  calls: number;
  connected: number;
  talkSeconds: number;
}

export interface CallRow {
  crtObjectId: string;
  callId: string;
  callTime: string;
  campaign: string;
  transferredCampaign: string;
  agent: string;
  agentId: string;
  disposition: string;
  callType: string;
  connected: boolean;
  talkSeconds: number;
  phone: string;
  hangupBy: string;
  queue: string;
}

export interface CallsFilter {
  since: string;
  until: string;
  campaign: string;
  agent: string;
  connectedOnly: boolean;
  minTalkSeconds: number;
  offset: number;
  limit: number;
}

export interface DialerLists {
  campaigns(since: string, until: string): Promise<CampaignRow[]>;
  agents(since: string, until: string, campaign: string): Promise<AgentRow[]>;
  /** One page, and whether there is another. */
  calls(filter: CallsFilter, phoneDigits: number): Promise<{ rows: CallRow[]; more: boolean }>;
  close(): Promise<void>;
}

export interface ListQueryFiles {
  campaigns: string;
  agents: string;
  window: string;
}

/** Opens the dialer's database with the three list queries read from their files. */
export function openDialerLists(url: string, files: ListQueryFiles): DialerLists {
  const pool = new pg.Pool({ connectionString: url, max: 2, statement_timeout: 60_000 });
  const sql = {
    campaigns: readFileSync(files.campaigns, 'utf8'),
    agents: readFileSync(files.agents, 'utf8'),
    window: readFileSync(files.window, 'utf8'),
  };
  return {
    async campaigns(since, until) {
      const result = await pool.query(sql.campaigns, [since, until]);
      return result.rows.map((r) => ({
        name: text(r.name),
        calls: count(r.calls),
        connected: count(r.connected),
        interactions: count(r.interactions),
        talkSeconds: count(r.talk_seconds),
      }));
    },
    async agents(since, until, campaign) {
      const result = await pool.query(sql.agents, [since, until, campaign]);
      return result.rows.map((r) => ({
        id: text(r.id),
        name: text(r.name),
        calls: count(r.calls),
        connected: count(r.connected),
        talkSeconds: count(r.talk_seconds),
      }));
    },
    async calls(filter, phoneDigits) {
      const result = await pool.query(sql.window, [
        filter.since,
        filter.until,
        filter.campaign,
        filter.agent,
        filter.connectedOnly,
        filter.minTalkSeconds,
        filter.offset,
        filter.limit + 1, // one more than asked: whether a next page exists
      ]);
      const rows = result.rows.slice(0, filter.limit).map((r) => toCallRow(r, phoneDigits));
      return { rows, more: result.rows.length > filter.limit };
    },
    close: () => pool.end(),
  };
}

export function toCallRow(r: Record<string, unknown>, phoneDigits: number): CallRow {
  return {
    crtObjectId: text(r.crt_object_id),
    callId: text(r.call_id),
    callTime: text(r.call_time),
    campaign: text(r.campaign),
    transferredCampaign: text(r.transferred_campaign),
    agent: text(r.agent),
    agentId: text(r.agent_id),
    disposition: text(r.disposition),
    callType: text(r.call_type),
    connected: r.connected === true || r.connected === 't' || r.connected === 'true',
    talkSeconds: count(r.talk_seconds),
    phone: maskPhone(text(r.phone), phoneDigits),
    hangupBy: hangupBy(text(r.hangup_by)),
    queue: text(r.queue),
  };
}

/** A call the single-call query found (call.sql), in the shape of the lists. */
export function fromCallRecord(call: CallRecord, phoneDigits: number): CallRow {
  const x = call.extra;
  return {
    crtObjectId: call.crtObjectId,
    callId: call.callId,
    callTime: call.callTime,
    campaign: call.campaign,
    transferredCampaign: x.transferred_campaign ?? '',
    agent: call.agent,
    agentId: x.user_id ?? x.agent_id ?? '',
    disposition: call.disposition,
    callType: x.call_type ?? '',
    connected: (x.system_disposition ?? x.status ?? '').toLowerCase() === 'connected',
    talkSeconds: call.talkSeconds,
    phone: maskPhone(call.phone, phoneDigits),
    hangupBy: hangupBy(x.hangup_details ?? ''),
    queue: x.queue_name ?? '',
  };
}

/** The dialer's hang-up words, shortened to who hung up. */
export function hangupBy(raw: string): string {
  const upper = raw.toUpperCase();
  if (upper.startsWith('CUSTOMER')) return 'customer';
  if (upper.startsWith('AGENT')) return 'agent';
  if (upper.startsWith('SYSTEM')) return 'system';
  return raw;
}

/** A moment as the dialer's own clock writes it ('YYYY-MM-DD HH:MM:SS' in its zone). */
export function dialerClock(moment: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .format(moment)
    .replace('T', ' ');
}

function text(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function count(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}
