import { VerifyPanel } from '../_components/verify-panel';

import type { ReactNode } from 'react';

/** The emailed link lands here; the token is read from the fragment in the browser (TENANT-004). */
export default function SignupVerifyPage(): ReactNode {
  return <VerifyPanel />;
}
