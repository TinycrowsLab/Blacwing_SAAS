// Shown when a Google account is not one of the administrators in BW_ADMIN_EMAILS.
import { Icon } from '../../components/console/design';
import { signOutAction } from '../../lib/auth-actions';

export function NoAccess({ email }: { readonly email: string | null | undefined }) {
  return (
    <>
      <div className="flex flex-col items-start gap-4">
        <span className="flex size-12 items-center justify-center rounded-full bg-bad-soft text-bad">
          <Icon name="x" size={22} />
        </span>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[24px] font-semibold leading-8 text-foreground">No access</h1>
          <p className="text-[13.5px] leading-6 text-muted-foreground">
            {typeof email === 'string' ? (
              <>
                <span className="font-medium text-foreground">{email}</span> is not an administrator
                of this Blackwing workspace.
              </>
            ) : (
              'This Google account is not an administrator of this Blackwing workspace.'
            )}{' '}
            Ask an administrator to add you, or use another account.
          </p>
        </div>
      </div>
      <form action={signOutAction}>
        <button
          type="submit"
          className="inline-flex h-11 w-full items-center justify-center rounded-[10px] bg-primary px-4 text-[14px] font-medium text-on-primary hover:brightness-90 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
        >
          Use another account
        </button>
      </form>
    </>
  );
}
