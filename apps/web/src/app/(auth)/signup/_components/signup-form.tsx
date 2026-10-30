'use client';

import { type ReactNode, type SyntheticEvent, useState } from 'react';

import { signupAcceptedSchema } from '@blackwing/contracts';
import { Button, Input, Label } from '@blackwing/ui';

import { type ApiClient, createApiClient } from '../../../../lib/api-client';
import { ApiError } from '../../../../lib/api-error';

export interface SignupFormProps {
  /** Test seam; the page uses the shared API client. */
  readonly api?: Pick<ApiClient, 'post'>;
}

const defaultApi = createApiClient();

/**
 * Self-service signup (TENANT-004). The API answers the same way whether or not the address already has an
 * account, so the only success state is "check your inbox": nothing here says whether the address is known.
 */
export function SignupForm({ api = defaultApi }: SignupFormProps): ReactNode {
  const [email, setEmail] = useState('');
  const [orgName, setOrgName] = useState('');
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      await api.post('/signup', signupAcceptedSchema, {
        email: email.trim(),
        orgName: orgName.trim(),
      });
      setSent(true);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setPending(false);
    }
  }

  if (sent) {
    return (
      <p role="status" className="text-[14px] leading-6 text-foreground">
        If this address can start a new Blackwing organisation, we have sent a verification link. It
        works for 24 hours.
      </p>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        void onSubmit(event);
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="signup-email">Work email</Label>
        <Input
          id="signup-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          maxLength={254}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="signup-org">Organisation name</Label>
        <Input
          id="signup-org"
          name="orgName"
          autoComplete="organization"
          required
          minLength={2}
          maxLength={100}
          value={orgName}
          onChange={(event) => {
            setOrgName(event.target.value);
          }}
        />
      </div>
      {error === undefined ? null : (
        <p role="alert" className="text-[13px] text-bad">
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? 'Sending link...' : 'Send verification link'}
      </Button>
    </form>
  );
}

function messageFor(cause: unknown): string {
  if (cause instanceof ApiError && cause.detail !== undefined) return cause.detail;
  return 'We could not send the verification link. Check the details and try again.';
}
