/**
 * likho.dialer.v1.DialerService: what the dialer knows about its calls, for likho-api, and what
 * the connector is doing. Served over gRPC (HTTP/2 without TLS) on GRPC_PORT.
 */
import { createServer, type Http2Server } from 'node:http2';
import { timestampDate, timestampFromDate, type Timestamp } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { DialerService } from '@likho-ai/contracts/dialer/v1/dialer_pb';
import type { DialerDb } from './dialer.js';
import { dialerClock, fromCallRecord, type CallRow, type DialerLists } from './lists.js';
import { describe, type Logger } from './log.js';
import type { LiveSettings } from './settings.js';
import type { State } from './state.js';

const MAX_DAYS = 92;
const PAGE = { usual: 50, most: 500 };

export interface RpcParts {
  lists: DialerLists | null;
  dialer: DialerDb | null;
  state: State;
  zone: string;
  version: string;
  archiveEnabled: boolean;
  /** The settings in force right now, and whether the write-back really runs. */
  settings: () => LiveSettings;
  writebackRunning: () => boolean;
  lastRun: () => { at: Date; summary: string } | null;
}

export function dialerRoutes(parts: RpcParts, log: Logger) {
  const lists = (): DialerLists => {
    if (!parts.lists)
      throw new ConnectError(
        'the dialer’s reporting database is not configured (DIALER_DATABASE_URL)',
        Code.FailedPrecondition,
      );
    return parts.lists;
  };
  const window = (w: { since?: Timestamp; until?: Timestamp } | undefined) => {
    if (!w?.since || !w.until)
      throw new ConnectError('a window with since and until is required', Code.InvalidArgument);
    const since = timestampDate(w.since);
    const until = timestampDate(w.until);
    if (until <= since) throw new ConnectError('until must come after since', Code.InvalidArgument);
    if (until.getTime() - since.getTime() > MAX_DAYS * 86_400_000)
      throw new ConnectError(`a window spans at most ${MAX_DAYS} days`, Code.InvalidArgument);
    return { since: dialerClock(since, parts.zone), until: dialerClock(until, parts.zone) };
  };
  const failed = (what: string, error: unknown): never => {
    if (error instanceof ConnectError) throw error;
    log.error(`the dialer’s database did not answer (${what})`, { error: describe(error) });
    throw new ConnectError('the dialer’s database did not answer', Code.Unavailable);
  };

  return (router: ConnectRouter) =>
    router.service(DialerService, {
      async listCampaigns(req) {
        const w = window(req.window);
        try {
          const rows = await lists().campaigns(w.since, w.until);
          return {
            campaigns: rows.map((c) => ({
              name: c.name,
              calls: BigInt(c.calls),
              connected: BigInt(c.connected),
              interactions: BigInt(c.interactions),
              talkSeconds: BigInt(c.talkSeconds),
            })),
          };
        } catch (error) {
          return failed('campaigns', error);
        }
      },
      async listAgents(req) {
        const w = window(req.window);
        try {
          const rows = await lists().agents(w.since, w.until, req.campaign.trim());
          return {
            agents: rows.map((a) => ({
              id: a.id,
              name: a.name,
              calls: BigInt(a.calls),
              connected: BigInt(a.connected),
              talkSeconds: BigInt(a.talkSeconds),
            })),
          };
        } catch (error) {
          return failed('agents', error);
        }
      },
      async listCalls(req) {
        const w = window(req.window);
        const offset = req.after ? Number(req.after) : 0;
        if (!Number.isInteger(offset) || offset < 0)
          throw new ConnectError('after is the next_cursor of the previous page', Code.InvalidArgument);
        const limit = Math.min(Math.max(req.limit || PAGE.usual, 1), PAGE.most);
        try {
          const page = await lists().calls(
            {
              since: w.since,
              until: w.until,
              campaign: req.campaign.trim(),
              agent: req.agent.trim(),
              connectedOnly: req.connectedOnly,
              minTalkSeconds: req.minTalkSeconds,
              offset,
              limit,
            },
            parts.settings().phoneDigits,
          );
          return {
            calls: page.rows.map(toPb),
            nextCursor: page.more ? String(offset + page.rows.length) : '',
          };
        } catch (error) {
          return failed('calls', error);
        }
      },
      async getCall(req) {
        const id = req.crtObjectId.trim();
        if (!id) throw new ConnectError('crt_object_id is required', Code.InvalidArgument);
        if (!parts.dialer)
          throw new ConnectError(
            'the dialer’s reporting database is not configured',
            Code.FailedPrecondition,
          );
        let found;
        try {
          found = await parts.dialer.call(id);
        } catch (error) {
          return failed('call', error);
        }
        if (!found) throw new ConnectError(`the dialer has no call ${id}`, Code.NotFound);
        return { call: toPb(fromCallRecord(found, parts.settings().phoneDigits)) };
      },
      async getStatus() {
        const s = parts.settings();
        const last = parts.lastRun();
        return {
          databaseConfigured: parts.lists !== null,
          scheduleEnabled: s.scheduleEnabled && parts.lists !== null,
          cursor: (await parts.state.cursor('schedule')) ?? '',
          importedToday: await parts.state.importedToday(),
          dailyLimit: s.dailyLimit,
          campaigns: s.campaigns,
          minTalkSeconds: s.minTalkSeconds,
          writebackEnabled: parts.writebackRunning(),
          archiveEnabled: parts.archiveEnabled,
          version: parts.version,
          ...(last ? { lastRunAt: timestampFromDate(last.at), lastRunSummary: last.summary } : {}),
        };
      },
    });
}

function toPb(c: CallRow) {
  return { ...c };
}

/** The gRPC side: an HTTP/2 server without TLS (inside the cluster). */
export async function serveRpc(routes: (router: ConnectRouter) => void, port: number): Promise<Http2Server> {
  const server = createServer(connectNodeAdapter({ routes }));
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return server;
}
