/**
 * The schedule: every so often, the new calls since the cursor are read from the dialer's
 * database, judged by the policy, and fetched - up to a batch per run and a budget per day.
 * The cursor is the call_time text of the last call taken, so a run that stops halfway
 * continues where it was.
 */
import type { DialerDb } from './dialer.js';
import type { Importer } from './importer.js';
import { describe, type Logger } from './log.js';
import { judge, type Policy } from './policy.js';
import type { State } from './state.js';

export interface ScheduleOptions {
  workspaceId: string;
  batchLimit: number;
  dailyLimit: number;
  start: string;
  policy: Policy;
}

export interface RunReport {
  seen: number;
  taken: number;
  skipped: number;
  failed: number;
  cursor: string | null;
  budgetLeft: number;
}

export class Schedule {
  private running = false;

  constructor(
    private readonly dialer: DialerDb,
    private readonly importer: Importer,
    private readonly state: State,
    private readonly options: ScheduleOptions,
    private readonly log: Logger,
  ) {}

  /** One pass over the new calls. Safe to call while a pass runs: the second one does nothing. */
  async runOnce(): Promise<RunReport | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.pass();
    } finally {
      this.running = false;
    }
  }

  private async pass(): Promise<RunReport> {
    const cursor = (await this.state.cursor('schedule')) ?? this.options.start;
    const today = await this.state.importedToday();
    const budget = Math.max(0, this.options.dailyLimit - today);
    const report: RunReport = { seen: 0, taken: 0, skipped: 0, failed: 0, cursor, budgetLeft: budget };
    if (budget === 0) {
      this.log.info('daily budget used up; waiting for tomorrow', {
        imported: today,
        limit: this.options.dailyLimit,
      });
      return report;
    }
    let calls;
    try {
      calls = await this.dialer.callsSince(cursor, this.options.batchLimit);
    } catch (error) {
      this.log.error('the dialer’s database did not answer', { error: describe(error) });
      return report;
    }
    report.seen = calls.length;
    let last = cursor;
    for (const call of calls) {
      if (report.taken >= budget) break;
      const verdict = judge(call, this.options.policy);
      if (!verdict.take) {
        report.skipped += 1;
        this.log.debug('call left out', { call: call.crtObjectId, reason: verdict.reason });
      } else {
        const outcome = await this.importer.run({
          externalId: call.crtObjectId,
          workspaceId: this.options.workspaceId,
          requestedBy: 'schedule',
          details: call,
        });
        if (outcome.ok) report.taken += 1;
        else {
          report.failed += 1;
          if (outcome.retry) break; // the dialer is down: stop here, the cursor stays before this call
        }
      }
      if (call.callTime && call.callTime > last) last = call.callTime;
    }
    if (last !== cursor) {
      await this.state.setCursor('schedule', last);
      report.cursor = last;
    }
    report.budgetLeft = budget - report.taken;
    this.log.info('schedule ran', { ...report });
    return report;
  }

  /** Runs a pass now and then every `everyMs`, until stop is called. */
  start(everyMs: number): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (stopped) return;
      try {
        await this.runOnce();
      } catch (error) {
        this.log.error('schedule pass failed', { error: describe(error) });
      }
      if (!stopped) timer = setTimeout(tick, everyMs);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }
}
