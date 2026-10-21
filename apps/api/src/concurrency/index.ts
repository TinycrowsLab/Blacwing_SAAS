export { canonicalize, computeEtag, stateVersionOf, versionEtag, versionFromEtag } from './etag.js';
export { EtagInterceptor, UseEtag } from './etag.interceptor.js';
export {
  assertRowUpdated,
  type IfMatch,
  type IfMatchResult,
  parseIfMatch,
  requireIfMatch,
} from './if-match.js';
