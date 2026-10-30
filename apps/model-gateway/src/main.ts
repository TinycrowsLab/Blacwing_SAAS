import './instrument.js';

import { runGateway } from './boot.js';

/** Process entry point: see `runGateway`. A refused configuration exits before anything listens. */
await runGateway({
  exit: (code) => process.exit(code),
  write: (text) => {
    process.stderr.write(text);
  },
});
