import { ApiProblemError, type ApiProblemErrorOptions } from '../errors/problem-errors.js';
import { problemRegistry } from '../errors/registry.js';

/**
 * Input-manifest upload errors (SCOPE-006). Each is an HTTP-layer wire code registered in the problem registry, so the
 * problem+json filter answers the status and the stable `code` without a mapping table here.
 */
const CODES = {
  scope_empty_upload: { status: 422, title: 'Upload is empty' },
  scope_upload_too_large: { status: 413, title: 'Upload is too large' },
  scope_upload_type_not_allowed: { status: 415, title: 'Upload type is not allowed' },
  scope_manifest_full: { status: 409, title: 'Input manifest has too many objects' },
  scope_upload_not_pending: { status: 409, title: 'Upload is no longer pending scan' },
  scope_object_missing: { status: 409, title: 'Uploaded object is missing' },
} as const;

for (const [code, registration] of Object.entries(CODES))
  problemRegistry.register(code, registration);

export type UploadProblemCode = keyof typeof CODES;

/** A typed upload problem: `code` is one of the registered `scope_*` wire codes. */
export function uploadProblem(
  code: UploadProblemCode,
  detail: string,
  options: ApiProblemErrorOptions = {},
): ApiProblemError {
  return new ApiProblemError(code, CODES[code].title, { detail, ...options });
}
