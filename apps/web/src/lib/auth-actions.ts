'use server';

// Sign-in and sign-out as Server Actions, so the pages need no client-side auth code.
import { signIn, signOut } from './auth';

export async function signInWithGoogle(form: FormData): Promise<void> {
  const callbackUrl = form.get('callbackUrl');
  // Auth.js's redirect callback keeps only same-origin targets; anything else lands on the dashboard.
  await signIn('google', { redirectTo: typeof callbackUrl === 'string' ? callbackUrl : '/' });
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: '/login' });
}
