import './instrument.js';

import { CONFIG_EXIT_CODE } from '@blackwing/config';

import { loadSessionManagerConfig, type SessionManagerConfig } from './config.js';
import { startSessionManager } from './controller.js';
import { SmConfigInvalidError } from './errors.js';
import { internalSessionRoutes } from './routes.js';

/** Exit status when the drain did not finish within `SM_DRAIN_TIMEOUT`. */
const DRAIN_TIMEOUT_EXIT_CODE = 1;

function loadOrExit(): Readonly<SessionManagerConfig> {
  try {
    return loadSessionManagerConfig();
  } catch (error) {
    if (error instanceof SmConfigInvalidError) {
      // No logger exists yet (its level comes from this config). The message names keys only.
      process.stderr.write(`${error.code}: ${error.message}\n`);
      process.exit(CONFIG_EXIT_CODE);
    }
    throw error;
  }
}

/** Process entry point: validate config (no socket is bound on failure), boot, drain on SIGTERM/SIGINT. */
async function main(): Promise<void> {
  const config = loadOrExit();
  const manager = await startSessionManager(config, { internalRoutes: internalSessionRoutes });
  const onSignal = (signal: NodeJS.Signals): void => {
    manager.shutdown(signal).then(
      ({ drained }) => process.exit(drained ? 0 : DRAIN_TIMEOUT_EXIT_CODE),
      () => process.exit(DRAIN_TIMEOUT_EXIT_CODE),
    );
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
}

await main();
