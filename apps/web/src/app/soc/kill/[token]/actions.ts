'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { triggerKillLink } from '../../../../lib/soc-kill';

/** The confirm button: fires the kill, then shows the outcome on a page that carries no token. */
export async function confirmKill(token: string): Promise<never> {
  const forwardedFor = (await headers()).get('x-forwarded-for');
  const outcome = await triggerKillLink(token, forwardedFor);
  return redirect(`/soc/kill/result?r=${outcome}`);
}
