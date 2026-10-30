/** Workspace package name of this package. */
export const name = '@blackwing/oob';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export { type OobClientOptions, OobClient } from './client.js';
export {
  OOB_PROTOCOLS,
  type OobInteraction,
  type OobProtocol,
  oobInteractionSchema,
} from './interaction.js';
export {
  CORRELATION_ID_LENGTH,
  INTERACTSH_PROTOCOL_VERSION,
  MAX_RECORDS_PER_POLL,
} from './protocol.js';
