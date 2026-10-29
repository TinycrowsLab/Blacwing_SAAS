'use client';

import { useState, type ReactNode } from 'react';

import { KillButton } from './kill-button';
import { KillStatusPanel } from './kill-status-panel';

import type { TenantKillApi } from '../../lib/tenant-kill-api';
import type { KillApiScope } from '@blackwing/contracts';

export interface KillControlProps {
  readonly scope: KillApiScope;
  readonly scopeRefId?: string | undefined;
  readonly roles: readonly string[];
  readonly ownsAsset?: boolean;
  /** Test seam; defaults to the console's kill client. */
  readonly api?: TenantKillApi;
}

/**
 * The stop control for one scope: the button and confirm dialog until a kill is accepted, then the
 * live status of that kill. Renders nothing for a role that may not kill this scope (cosmetic gate).
 */
export function KillControl({
  scope,
  scopeRefId,
  roles,
  ownsAsset,
  api,
}: KillControlProps): ReactNode {
  const [killEventId, setKillEventId] = useState<string | null>(null);
  if (killEventId !== null) {
    return (
      <KillStatusPanel
        killEventId={killEventId}
        {...(api === undefined ? {} : { api })}
        onReset={() => {
          setKillEventId(null);
        }}
      />
    );
  }
  return (
    <KillButton
      scope={scope}
      {...(scopeRefId === undefined ? {} : { scopeRefId })}
      roles={roles}
      {...(ownsAsset === undefined ? {} : { ownsAsset })}
      {...(api === undefined ? {} : { api })}
      onAccepted={setKillEventId}
    />
  );
}
