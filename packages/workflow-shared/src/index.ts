/** Workspace package name of this package. */
export const name = '@blackwing/workflow-shared';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export { createDataConverter, type DataConverterOptions } from './data-converter.js';
export {
  CONNECT_MAX_ATTEMPTS,
  closeTemporal,
  getTemporalClient,
  getTemporalConnection,
  type TemporalClientOptions,
} from './temporal-client.js';
