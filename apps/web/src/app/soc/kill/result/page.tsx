import * as React from 'react';

import type { ReactNode } from 'react';

const MESSAGES = {
  done: {
    title: 'Testing is being stopped',
    body: 'The stop request was accepted. Everything running against this system is being halted.',
  },
  limited: {
    title: 'Too many attempts',
    body: 'Please wait a minute and use the link again.',
  },
  invalid: {
    title: 'This link is no longer valid',
    body: 'Ask the team that shared it for a new one.',
  },
} as const;

export default async function SocKillResultPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ r?: string | string[] }>;
}): Promise<ReactNode> {
  const { r } = await searchParams;
  const key = r === 'done' || r === 'limited' ? r : 'invalid';
  const message = MESSAGES[key];
  return (
    <section className="space-y-3" role={key === 'done' ? 'status' : 'alert'}>
      <h1 className="text-xl font-semibold">{message.title}</h1>
      <p>{message.body}</p>
    </section>
  );
}
