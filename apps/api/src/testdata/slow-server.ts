// Child process for shutdown.process.test.ts: the real entry point (`runApi`) plus one slow route, so the
// test can send SIGTERM while a request is in flight. Never imported by product code.
import { setTimeout as sleep } from 'node:timers/promises';

import { Controller, Get, Module, Query } from '@nestjs/common';

import { runApi } from '../run.js';
import { PublicRoute } from '../tenant/public-route.js';

const MAX_DELAY_MS = 60_000;

// Public: the tenant guard is on by default and this probe route carries no tenant data.
@PublicRoute()
@Controller('slow')
class SlowController {
  @Get()
  async wait(@Query('ms') ms?: string): Promise<{ readonly waitedMs: number }> {
    const delay = Math.min(Number(ms ?? '0') || 0, MAX_DELAY_MS);
    await sleep(delay);
    return { waitedMs: delay };
  }
}

@Module({ controllers: [SlowController] })
class SlowModule {}

await runApi({
  exit: (code) => process.exit(code),
  write: (text) => {
    process.stderr.write(text);
  },
  imports: [SlowModule],
});
