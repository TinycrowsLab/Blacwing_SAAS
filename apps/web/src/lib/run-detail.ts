import { z } from 'zod';

import {
  isoDateTimeSchema,
  runModeSchema,
  runPauseReasonSchema,
  runStateSchema,
  runTriggerSchema,
} from '@blackwing/contracts';

/** Public run id as shown in URLs and the UI (`run_01JABC7Q3M`). Anything else is never sent upstream. */
export const PUBLIC_RUN_ID = /^run_[0-9A-Za-z]{4,64}$/;

/** What `GET /v1/runs/{runId}` returns for the detail page: display fields only, no manifests or secrets. */
export const runDetailSchema = z.strictObject({
  publicId: z.string().regex(PUBLIC_RUN_ID),
  state: runStateSchema,
  pauseReason: runPauseReasonSchema.nullable(),
  stateVersion: z.int().min(0),
  mode: runModeSchema,
  trigger: runTriggerSchema,
  requestedBy: z.string().min(1),
  assets: z.array(z.strictObject({ id: z.string().min(1), name: z.string().min(1) })),
  startedAt: isoDateTimeSchema.nullable(),
  endedAt: isoDateTimeSchema.nullable(),
  updatedAt: isoDateTimeSchema,
});
export type RunDetail = z.infer<typeof runDetailSchema>;
