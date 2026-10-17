// Auto-pause rules (BF-056, Specification): data, not code paths — a workspace may only tighten them. A mailbox is
// paused when its hard bounce rate over the last 50 sends passes 3% (with at least 20 sends), when a warming mailbox
// gets 3 hard bounces in a day, or when its unsubscribe rate over 7 days passes 10% (5% warns), with at least 40
// sends. Quota or "suspicious activity" errors pause it through the mailbox lifecycle (BF-050); an authentication
// regression stops its sends through the readiness gate.

export interface HealthWindow {
  readonly last50Sends: number;
  readonly last50Bounces: number;
  readonly bounces24h: number;
  readonly sends7d: number;
  readonly unsubscribes7d: number;
  readonly warming: boolean;
}

export interface DeliverabilityRules {
  readonly bounceRate: number;
  readonly bounceMinSends: number;
  readonly warmingBounces24h: number;
  readonly unsubscribeWarnRate: number;
  readonly unsubscribePauseRate: number;
  readonly unsubscribeMinSends: number;
}

export const DEFAULT_RULES: DeliverabilityRules = {
  bounceRate: 0.03,
  bounceMinSends: 20,
  warmingBounces24h: 3,
  unsubscribeWarnRate: 0.05,
  unsubscribePauseRate: 0.1,
  unsubscribeMinSends: 40,
};

export interface RuleVerdict {
  readonly pause: string | null;
  readonly warnings: string[];
}

export function evaluateRules(health: HealthWindow, rules: DeliverabilityRules = DEFAULT_RULES): RuleVerdict {
  const warnings: string[] = [];
  let pause: string | null = null;
  if (
    health.last50Sends >= rules.bounceMinSends &&
    health.last50Bounces / health.last50Sends > rules.bounceRate
  )
    pause = 'bounce_rate';
  if (!pause && health.warming && health.bounces24h >= rules.warmingBounces24h) pause = 'bounces_warming';
  if (health.sends7d >= rules.unsubscribeMinSends) {
    const rate = health.unsubscribes7d / health.sends7d;
    if (rate > rules.unsubscribePauseRate) pause ??= 'unsubscribe_rate';
    else if (rate > rules.unsubscribeWarnRate) warnings.push('unsubscribe_rate_high');
  }
  if (!pause && health.last50Sends > 0 && health.last50Bounces / health.last50Sends > rules.bounceRate / 2)
    warnings.push('bounce_rate_rising');
  return { pause, warnings };
}
