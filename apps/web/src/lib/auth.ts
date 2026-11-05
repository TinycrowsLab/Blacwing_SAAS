// Google sign-in (Auth.js, JWT session in an encrypted httpOnly cookie, no database and no session service).
// Only verified Google accounts listed in BW_ADMIN_EMAILS may sign in; each of them is an administrator.
import NextAuth, { type NextAuthResult } from 'next-auth';
import Google from 'next-auth/providers/google';

/** Every role in Blackwing. An administrator holds all of them (names as the API checks them). */
const ADMIN_ROLES: readonly string[] = [
  'appsec-engineer',
  'asset-owner',
  'developer',
  'org-admin',
  'auditor',
];

/** The administrators' e-mails from BW_ADMIN_EMAILS (comma separated, case-insensitive). */
function adminEmails(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e !== ''),
  );
}

export function isAdmin(email: string | null | undefined): email is string {
  return (
    typeof email === 'string' && adminEmails(process.env.BW_ADMIN_EMAILS).has(email.toLowerCase())
  );
}

// The Google claims the console uses besides name, e-mail and picture: the given name (greetings) and `hd`, the
// Google Workspace domain (the proposed workspace name on /welcome).
declare module 'next-auth' {
  interface Session {
    givenName?: string;
    hd?: string;
  }
}

const claim = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

const nextAuth = NextAuth({
  // select_account lets someone who picked the wrong Google account choose again.
  providers: [Google({ authorization: { params: { prompt: 'select_account' } } })],
  session: { strategy: 'jwt' },
  pages: { signIn: '/login', error: '/login' },
  callbacks: {
    signIn({ account, profile }) {
      return (
        account?.provider === 'google' && profile?.email_verified === true && isAdmin(profile.email)
      );
    },
    jwt({ token, profile }) {
      if (profile !== undefined) {
        const givenName = claim(profile.given_name);
        const hd = claim(profile.hd);
        if (givenName !== undefined) token.givenName = givenName;
        if (hd !== undefined) token.hd = hd;
      }
      return token;
    },
    session({ session, token }) {
      if (typeof token.sub === 'string') session.user.id = token.sub;
      const givenName = claim(token.givenName);
      const hd = claim(token.hd);
      if (givenName !== undefined) session.givenName = givenName;
      if (hd !== undefined) session.hd = hd;
      return session;
    },
    // Used by the middleware: every console page needs an administrator's session.
    authorized({ auth: session }) {
      return isAdmin(session?.user?.email);
    },
  },
});

// Annotated so the declaration build can name the types (they live in next-auth's internal modules).
export const handlers: NextAuthResult['handlers'] = nextAuth.handlers;
export const auth: NextAuthResult['auth'] = nextAuth.auth;
export const signIn: NextAuthResult['signIn'] = nextAuth.signIn;
export const signOut: NextAuthResult['signOut'] = nextAuth.signOut;

/** The signed-in administrator as the pages and the API bridge see it. Holds no token. */
export interface Viewer {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
    /** Google's given name, else the first word of the name. */
    readonly givenName: string;
    readonly image: string | null;
    /** The Google Workspace domain (`hd` claim), when the account belongs to one. */
    readonly hd: string | null;
  };
  readonly roles: readonly string[];
}

/** The current administrator, or null when signed out or no longer listed in BW_ADMIN_EMAILS. */
export async function getViewer(): Promise<Viewer | null> {
  const session = await auth();
  const user = session?.user;
  if (user === undefined || !isAdmin(user.email)) return null;
  const email = user.email;
  const name = user.name ?? email;
  return {
    user: {
      id: user.id ?? email,
      email,
      name,
      givenName: session?.givenName ?? name.trim().split(/\s+/)[0] ?? name,
      image: user.image ?? null,
      hd: session?.hd ?? null,
    },
    roles: ADMIN_ROLES,
  };
}
