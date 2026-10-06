/**
 * What the connector does, as the workspace's admins set it in Likho (Admin → Dialer): the
 * schedule, the policy, the budget, the write-back. Read from likho-api at start and again
 * whenever likho.settings.changed says the dialer's keys changed. Until likho-api answers, and
 * when SETTINGS_FROM_LIKHO is off, the values of the .env files stand.
 */
import { campaignsOf, type Config } from './config.js';
import type { LikhoApi } from './likho.js';

export interface LiveSettings {
  scheduleEnabled: boolean;
  campaigns: string[];
  minTalkSeconds: number;
  dailyLimit: number;
  batchLimit: number;
  pollIntervalSeconds: number;
  phoneDigits: number;
  writebackEnabled: boolean;
  /** Where these values came from. */
  from: 'likho' | 'env';
}

/** The .env files' values: what stands until likho-api answers. */
export function fromConfig(config: Config): LiveSettings {
  return {
    scheduleEnabled: config.SCHEDULE_ENABLED,
    campaigns: campaignsOf(config),
    minTalkSeconds: config.MIN_TALK_SECONDS,
    dailyLimit: config.DAILY_LIMIT,
    batchLimit: config.BATCH_LIMIT,
    pollIntervalSeconds: config.POLL_INTERVAL_SECONDS,
    phoneDigits: config.PHONE_DIGITS,
    writebackEnabled: config.WRITEBACK_ENABLED,
    from: 'env',
  };
}

/** The workspace's settings from likho-api (GET /api/v1/settings with the connector's key). */
export async function fromLikho(likho: LikhoApi): Promise<LiveSettings> {
  const { dialer } = await likho.settings();
  return {
    scheduleEnabled: dialer.scheduleEnabled,
    campaigns: dialer.campaigns,
    minTalkSeconds: dialer.minTalkSeconds,
    dailyLimit: dialer.dailyLimit,
    batchLimit: dialer.batchLimit,
    pollIntervalSeconds: dialer.pollIntervalSeconds,
    phoneDigits: dialer.phoneDigits,
    writebackEnabled: dialer.writebackEnabled,
    from: 'likho',
  };
}

/** Whether two settings differ in what the schedule runs by (so it is started again). */
export function scheduleChanged(a: LiveSettings, b: LiveSettings): boolean {
  return (
    a.scheduleEnabled !== b.scheduleEnabled ||
    a.minTalkSeconds !== b.minTalkSeconds ||
    a.dailyLimit !== b.dailyLimit ||
    a.batchLimit !== b.batchLimit ||
    a.pollIntervalSeconds !== b.pollIntervalSeconds ||
    a.campaigns.join('\n') !== b.campaigns.join('\n')
  );
}
