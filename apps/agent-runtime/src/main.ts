import './instrument.js';

import { runMain } from './app.js';

/** Process entry point. The logic lives in `app.ts`; this file only maps its result to the exit status. */
process.exit(await runMain(process.env));
