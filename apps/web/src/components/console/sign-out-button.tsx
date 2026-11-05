// Ends the Auth.js session (the cookie is cleared server-side) and returns to the sign-in page.
import { signOutAction } from '../../lib/auth-actions';

export function SignOutButton({ label = 'Sign out', className }: { readonly label?: string; readonly className?: string }) {
  return (
    <form action={signOutAction}>
      <button
        type="submit"
        className={
          className ??
          'inline-flex h-9 items-center whitespace-nowrap rounded-lg px-2 text-[12.5px] font-medium text-gold-ink hover:bg-gold-soft focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus'
        }
      >
        {label}
      </button>
    </form>
  );
}
