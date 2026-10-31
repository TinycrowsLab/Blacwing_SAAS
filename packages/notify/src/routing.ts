import {
  NOTIFICATION_SEVERITIES,
  type NotificationEventType,
  type NotificationRouteEvent,
  type NotificationRouteRecipientSpec,
  type NotificationSeverity,
} from '@blackwing/contracts';

/**
 * Routing rules (NOTIFY-011). Pure: a rule is a row of `notification_routes` read by the notifier, and matching
 * is a function of the request and the rules, so it is tested without a database and gives the same answer for
 * the same inputs.
 *
 * Matching: a rule applies when it is enabled, its event is the request's event or `*`, its asset is `null` or
 * the request's asset, and the request's severity is at least its `severityMin`.
 *
 * Override: when an enabled rule names the request's asset, the wildcard-asset rules (asset `null`) are dropped
 * for that request. This is the "asset-specific rule overrides a wildcard rule for that asset" rule. Event-specific
 * and wildcard-event rules both still apply, so a tenant-wide rule and an event rule can fan out together.
 *
 * Order: most specific first (asset-specific counts 2, an exact event counts 1), then higher `priority`, then the
 * rule id, so two rules never tie.
 */

/** A rule as the matcher reads it. */
export interface RouteRule {
  readonly id: string;
  readonly event: NotificationRouteEvent;
  /** `null` matches every asset. */
  readonly assetId: string | null;
  readonly severityMin: NotificationSeverity;
  readonly channelId: string;
  readonly recipientSpec: NotificationRouteRecipientSpec;
  readonly enabled: boolean;
  readonly priority: number;
}

/** What the matcher needs from a notice. */
export interface RouteQuery {
  readonly event: NotificationEventType;
  readonly assetId?: string | undefined;
  readonly severity: NotificationSeverity;
}

/** A matching rule and how specific it is (its position in the order is decided by `matchRoutes`). */
export interface MatchedRoute {
  readonly rule: RouteRule;
  readonly specificity: number;
}

/** Position of a severity on the ladder (`info` lowest, `critical` highest). */
function severityRank(severity: NotificationSeverity): number {
  return NOTIFICATION_SEVERITIES.indexOf(severity);
}

/** Rules that apply to `query`, in resolution order. An empty result means no rule matched. */
export function matchRoutes(
  query: RouteQuery,
  rules: readonly RouteRule[],
): readonly MatchedRoute[] {
  const applicable = rules.filter(
    (rule) =>
      rule.enabled &&
      (rule.event === '*' || rule.event === query.event) &&
      (rule.assetId === null || rule.assetId === query.assetId) &&
      severityRank(query.severity) >= severityRank(rule.severityMin),
  );
  const assetSpecific = applicable.some((rule) => rule.assetId !== null);
  return applicable
    .filter((rule) => !(assetSpecific && rule.assetId === null))
    .map((rule) => ({
      rule,
      specificity: (rule.assetId === null ? 0 : 2) + (rule.event === '*' ? 0 : 1),
    }))
    .sort(
      (a, b) =>
        b.specificity - a.specificity ||
        b.rule.priority - a.rule.priority ||
        a.rule.id.localeCompare(b.rule.id),
    );
}

/**
 * The e-mail addresses a rule narrows a delivery to: its listed addresses plus the members of its on-call group,
 * lower-cased and de-duplicated. `undefined` when the rule names nobody (or its group has no members), which
 * means the channel's own audience applies.
 */
export function ruleRecipients(
  spec: NotificationRouteRecipientSpec,
  groups: Readonly<Record<string, readonly string[]>> | undefined,
): readonly string[] | undefined {
  const addresses = new Set<string>();
  for (const address of spec.emails ?? []) addresses.add(address.toLowerCase());
  if (spec.onCallGroup !== undefined) {
    for (const member of groups?.[spec.onCallGroup] ?? []) addresses.add(member.toLowerCase());
  }
  return addresses.size === 0 ? undefined : [...addresses];
}
