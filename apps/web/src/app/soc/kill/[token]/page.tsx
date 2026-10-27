import { headers } from 'next/headers';
import * as React from 'react';

import { Button } from '@blackwing/ui';

import { confirmKill } from './actions';
import { previewKillLink } from '../../../../lib/soc-kill';

import type { ReactNode } from 'react';

// The link is a credential: never cached or prerendered.
export const dynamic = 'force-dynamic';

export default async function SocKillPage({
  params,
}: {
  readonly params: Promise<{ token: string }>;
}): Promise<ReactNode> {
  const { token } = await params;
  const preview = await previewKillLink(token, (await headers()).get('x-forwarded-for'));
  if (preview.kind === 'limited') {
    return (
      <section className="space-y-3" role="alert">
        <h1 className="text-xl font-semibold">Too many attempts</h1>
        <p>Please wait a minute and reload this page.</p>
      </section>
    );
  }
  if (preview.kind === 'invalid') {
    return (
      <section className="space-y-3">
        <h1 className="text-xl font-semibold">This link is no longer valid</h1>
        <p>Ask the team that shared it for a new one.</p>
      </section>
    );
  }
  const confirm = confirmKill.bind(null, token);
  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Stop testing of {preview.label}</h1>
      <p>
        Confirming immediately stops all Blackwing testing of this {preview.scope}. You can ask the
        team to start testing again later.
      </p>
      <form action={confirm}>
        <Button type="submit" variant="destructive">
          Stop testing now
        </Button>
      </form>
    </section>
  );
}
