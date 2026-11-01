import type { ReactNode } from 'react';

// Every refusal of a link lands here, whatever the reason: the page never says which check failed.
export default function SocPortalExpiredPage(): ReactNode {
  return (
    <section className="space-y-3">
      <h1 className="text-xl font-semibold">This link is no longer valid</h1>
      <p>Ask the team that shared it for a new one.</p>
    </section>
  );
}
