import { GlobalKillPanel } from '../../../../components/operator/global-kill-panel';

import type { ReactNode } from 'react';

/** `/operator/kill`: the platform operator's global and tenant kill control. */
export default function OperatorKillPage(): ReactNode {
  return <GlobalKillPanel />;
}
