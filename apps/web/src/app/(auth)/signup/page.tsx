import { SignupForm } from './_components/signup-form';

import type { ReactNode } from 'react';

/** Self-service signup (TENANT-004): asks for an e-mail address and an organisation name, then mails the link. */
export default function SignupPage(): ReactNode {
  return (
    <>
      <div className="flex flex-col items-start gap-4">
        <h1 className="text-[26px] font-semibold leading-8 text-foreground">
          Create your <span className="text-kill">Blackwing</span> organisation
        </h1>
        <p className="text-[13.5px] leading-6 text-muted-foreground">
          We will email you a link to confirm your address. Nothing is created until you open it.
        </p>
      </div>
      <SignupForm />
    </>
  );
}
