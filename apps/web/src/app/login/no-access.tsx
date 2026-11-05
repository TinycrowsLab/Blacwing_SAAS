// Shown when a Google account is not one of the administrators in BW_ADMIN_EMAILS.
import { buttonClass, Icon } from '../../components/console/design';
import { signOutAction } from '../../lib/auth-actions';

export function NoAccess({ email }: { readonly email: string | null | undefined }) {
  return (
    <>
      <div className="flex flex-col items-start gap-4">
        <span className="flex size-12 items-center justify-center rounded-full bg-bad-soft text-bad">
          <Icon name="x" size={22} />
        </span>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[24px] font-semibold leading-8 text-foreground">
            This Google account can&apos;t sign in here
          </h1>
          <p className="text-[13.5px] leading-6 text-muted-foreground">
            {typeof email === 'string' ? (
              <>
                You signed in as <span className="font-medium text-foreground">{email}</span>.{' '}
              </>
            ) : null}
            Ask your administrator to add you, or use another account.
          </p>
        </div>
      </div>
      <form action={signOutAction}>
        <button
          type="submit"
          className={buttonClass('primary', 'h-11 w-full')}
        >
          Use another account
        </button>
      </form>
    </>
  );
}
