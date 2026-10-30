import './instrument.js';

import { runApi } from './run.js';

/** Process entry point: see `runApi`. Invalid configuration exits before anything listens. */
await runApi({
  exit: (code) => process.exit(code),
  write: (text) => {
    process.stderr.write(text);
  },
});
