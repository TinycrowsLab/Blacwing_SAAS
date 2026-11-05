'use client';

// Home's error state (spec §8): the field still works; the lists can be fetched again in place.
import { useRouter } from 'next/navigation';

import { InlineMessage } from '../design';

export function HomeRetry() {
  const router = useRouter();
  return (
    <InlineMessage tone="bad">
      We couldn&apos;t load your audits.{' '}
      <button
        type="button"
        onClick={() => {
          router.refresh();
        }}
        className="font-semibold underline underline-offset-2"
      >
        Retry
      </button>
    </InlineMessage>
  );
}
