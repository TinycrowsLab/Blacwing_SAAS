import { CircleDashed, Hourglass, ShieldCheck, ShieldX, type LucideIcon } from 'lucide-react';

import { Badge, type BadgeProps } from '@blackwing/ui';

import { VERIFICATION_LABELS } from './asset-model';

import type { VerificationStatus } from '@blackwing/contracts';

const PRESENTATION: Readonly<
  Record<
    VerificationStatus,
    { readonly variant: NonNullable<BadgeProps['variant']>; readonly icon: LucideIcon }
  >
> = {
  unverified: { variant: 'outline', icon: CircleDashed },
  pending: { variant: 'warning', icon: Hourglass },
  verified: { variant: 'success', icon: ShieldCheck },
  rejected: { variant: 'danger', icon: ShieldX },
};

export interface VerificationStatusBadgeProps {
  readonly status: VerificationStatus;
}

/**
 * The verification state of an asset (§8.10). The text label always carries the meaning and the icon is decorative,
 * so the state never depends on colour alone. Colours are the design tokens' soft/strong pairs (AA contrast).
 */
export function VerificationStatusBadge({ status }: VerificationStatusBadgeProps) {
  const { variant, icon: Icon } = PRESENTATION[status];
  return (
    <Badge variant={variant} data-status={status} className="inline-flex items-center gap-1">
      <Icon aria-hidden="true" className="size-3.5" />
      {VERIFICATION_LABELS[status]}
    </Badge>
  );
}
