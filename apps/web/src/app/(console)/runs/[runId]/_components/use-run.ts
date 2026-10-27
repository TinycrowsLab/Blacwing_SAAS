'use client';

import { useQuery } from '@tanstack/react-query';

import { createApiClient } from '../../../../../lib/api-client';
import { getRunPollMs } from '../../../../../lib/config';
import { qk } from '../../../../../lib/query-keys';
import { runDetailSchema, type RunDetail } from '../../../../../lib/run-detail';
import { isTerminalState } from '../../../../../lib/run-states';

const api = createApiClient();

export interface UseRunOptions {
  /** The run as the server rendered it; shown immediately. */
  readonly initialData?: RunDetail;
  /** True while the SSE stream (LIVERUN-003) is connected; polling then stays off. */
  readonly streamConnected?: boolean;
}

/**
 * The run behind the detail page. Without a live stream it polls every `RUN_POLL_MS` so the state is
 * never left stale; polling stops once the run is terminal (nothing can change any more).
 */
export function useRun(runId: string, options: UseRunOptions = {}) {
  const pollMs = getRunPollMs();
  const query = useQuery({
    queryKey: qk.runs.detail(runId),
    queryFn: ({ signal }) => api.get(`/runs/${runId}`, runDetailSchema, { signal }),
    ...(options.initialData === undefined ? {} : { initialData: options.initialData }),
    meta: { suppressGlobalError: true },
    refetchInterval: (q) =>
      options.streamConnected === true ||
      (q.state.data !== undefined && isTerminalState(q.state.data.state))
        ? false
        : pollMs,
  });
  return {
    run: query.data,
    error: query.error,
    isPending: query.isPending,
    updatedAt: query.dataUpdatedAt,
    mode: options.streamConnected === true ? ('stream' as const) : ('poll' as const),
  };
}
