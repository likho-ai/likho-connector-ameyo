#!/usr/bin/env node
/**
 * likho-connector-ameyo
 *
 *   serve                      take import requests from the bus, run the schedule, write back
 *   import <crt_object_id>...  fetch these calls now (and transcribe them)
 *   backfill --from A --to B   fetch the calls of a window of the dialer's database (call_time text)
 *   status                     what the connector has done
 *   check                      can the dialer, Likho and the databases be reached?
 */
import { assemble, App } from './app.js';
import { campaignsOf, loadConfig } from './config.js';
import { describe, createLogger } from './log.js';
import { judge } from './policy.js';

function usage(): never {
  process.stderr.write(
    'usage: likho-connector-ameyo serve | import <crt_object_id>... [--no-transcribe] | backfill --from <call_time> --to <call_time> [--limit N] | status | check\n',
  );
  process.exit(2);
}

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) usage();
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL);

  if (command === 'serve') {
    const app = await App.start(config, log);
    const stop = () => {
      log.info('stopping');
      void app.stop().then(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return new Promise(() => {}); // runs until a signal
  }

  const parts = await assemble(config, log);
  try {
    switch (command) {
      case 'import': {
        const ids = args.filter((a) => !a.startsWith('--'));
        if (ids.length === 0) usage();
        let failed = 0;
        for (const id of ids) {
          const outcome = await parts.importer.run({
            externalId: id,
            workspaceId: config.WORKSPACE_ID,
            transcribe: !args.includes('--no-transcribe'),
            requestedBy: 'cli',
          });
          if (outcome.ok)
            process.stdout.write(
              `${id}\t${outcome.existing ? 'already in Likho' : 'fetched'}\t${outcome.recordingId}\n`,
            );
          else {
            failed += 1;
            process.stdout.write(`${id}\t${outcome.code}\t${outcome.reason}\n`);
          }
        }
        return failed ? 1 : 0;
      }
      case 'backfill': {
        const from = option(args, '--from');
        const to = option(args, '--to');
        const limit = Number(option(args, '--limit') ?? 1000);
        if (!from || !to) usage();
        if (!parts.dialer) throw new Error('backfill needs DIALER_DATABASE_URL (where the calls are listed)');
        const policy = { campaigns: campaignsOf(config), minTalkSeconds: config.MIN_TALK_SECONDS };
        let cursor = from;
        let seen = 0;
        let taken = 0;
        let skipped = 0;
        let failed = 0;
        while (seen < limit) {
          const calls = await parts.dialer.callsSince(cursor, Math.min(config.BATCH_LIMIT, limit - seen));
          if (calls.length === 0) break;
          for (const call of calls) {
            if (call.callTime && call.callTime > to) {
              seen = limit;
              break;
            }
            seen += 1;
            const verdict = judge(call, policy);
            if (!verdict.take) {
              skipped += 1;
              continue;
            }
            const outcome = await parts.importer.run({
              externalId: call.crtObjectId,
              workspaceId: config.WORKSPACE_ID,
              requestedBy: 'cli',
              details: call,
            });
            if (outcome.ok) taken += 1;
            else failed += 1;
            if (call.callTime > cursor) cursor = call.callTime;
          }
          if (calls.length < config.BATCH_LIMIT) break;
        }
        process.stdout.write(`seen ${seen}, fetched ${taken}, left out ${skipped}, failed ${failed}\n`);
        return failed ? 1 : 0;
      }
      case 'status': {
        const s = await parts.state.summary();
        process.stdout.write(
          `fetched ${s.imported} (today ${s.today} of ${config.DAILY_LIMIT}), failed ${s.failed}, deleted in Likho ${s.deleted}, written back ${s.writtenBack}\nschedule cursor: ${s.cursor ?? '(not started)'}\n`,
        );
        return 0;
      }
      case 'check': {
        const checks: [string, () => Promise<string>][] = [
          ['state database', async () => ((await parts.state.ping()) ? 'ok' : 'not reachable')],
          [
            'likho-api',
            async () => {
              await parts.likho.transcript('rec_00000000000000000000000000').catch((e: { code?: string }) => {
                if (e.code !== 'not_found') throw e;
              });
              return 'ok (the key is accepted)';
            },
          ],
          [
            'dialer API',
            async () => {
              const result = await parts.ameyo.download('check-0000');
              return result.kind === 'unavailable' ? result.reason : 'ok (it answers)';
            },
          ],
        ];
        if (parts.dialer) {
          const dialer = parts.dialer;
          checks.push([
            'dialer database',
            async () => {
              await dialer.callsSince('0000', 1);
              return 'ok';
            },
          ]);
        }
        let bad = 0;
        for (const [name, run] of checks) {
          try {
            process.stdout.write(`${name}: ${await run()}\n`);
          } catch (error) {
            bad += 1;
            process.stdout.write(`${name}: ${describe(error)}\n`);
          }
        }
        return bad ? 1 : 0;
      }
      default:
        usage();
    }
  } finally {
    await parts.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${describe(error)}\n`);
    process.exit(1);
  },
);
