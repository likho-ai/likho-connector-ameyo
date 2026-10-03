/**
 * Which calls the schedule takes. One CPU transcribes a small share of a day's calls, so the
 * policy is explicit: the campaigns that matter, a shortest talk time, and a daily budget.
 */
import type { CallRecord } from './dialer.js';

export interface Policy {
  /** Campaign names to take; empty = every campaign. */
  campaigns: string[];
  /** Calls shorter than this are not worth a transcription. */
  minTalkSeconds: number;
}

export type Verdict = { take: true } | { take: false; reason: string };

export function judge(call: CallRecord, policy: Policy): Verdict {
  if (
    policy.campaigns.length > 0 &&
    !policy.campaigns.some((c) => c.toLowerCase() === call.campaign.toLowerCase())
  )
    return { take: false, reason: `campaign ${call.campaign || '(none)'} is not in the policy` };
  if (call.talkSeconds < policy.minTalkSeconds)
    return { take: false, reason: `talk time ${call.talkSeconds}s is under ${policy.minTalkSeconds}s` };
  return { take: true };
}
