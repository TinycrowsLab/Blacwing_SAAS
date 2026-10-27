import { classifyApiError, errorCopy, toast } from '@blackwing/ui';

import type { ApiError } from './api-error.js';

/**
 * Global API failure toast (CONSOLE-010). Shows fixed copy for the error kind plus the trace id, never
 * the server's title or detail, so no internals or payloads reach the screen (CONTEXT_PACK §8.7).
 */
export function toastApiError(error: ApiError): void {
  const copy = errorCopy(classifyApiError(error));
  toast.error({ title: copy.title, description: copy.description, traceId: error.traceId });
}
