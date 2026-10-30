import './instrument.js';

import { CONFIG_EXIT_CODE } from '@blackwing/config';

import { loadSandboxControllerConfig, type SandboxControllerConfig } from './config.js';
import { startSandboxController } from './controller.js';
import { SbxConfigInvalidError } from './errors.js';

/** Exit status when the drain did not finish within `SBX_DRAIN_TIMEOUT`. */
const DRAIN_TIMEOUT_EXIT_CODE = 1;

function loadOrExit(): Readonly<SandboxControllerConfig> {
  try {
    return loadSandboxControllerConfig();
  } catch (error) {
    if (error instanceof SbxConfigInvalidError) {
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
  const controller = await startSandboxController(config);
  const onSignal = (signal: NodeJS.Signals): void => {
    controller.shutdown(signal).then(
      ({ drained }) => process.exit(drained ? 0 : DRAIN_TIMEOUT_EXIT_CODE),
      () => process.exit(DRAIN_TIMEOUT_EXIT_CODE),
    );
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
}

await main();
