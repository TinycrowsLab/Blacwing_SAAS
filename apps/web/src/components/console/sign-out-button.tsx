// Ends the Auth.js session (the cookie is cleared server-side) and returns to the sign-in page.
import { signOutAction } from '../../lib/auth-actions';

export function SignOutButton() {
  return (
    <form action={signOutAction}>
      <button
        type="submit"
        className="inline-flex h-8 items-center whitespace-nowrap rounded-lg px-2 text-xs font-medium text-muted-foreground hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
      >
        Sign out
      </button>
    </form>
  );
}
