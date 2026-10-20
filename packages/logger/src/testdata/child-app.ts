// Fixture: a minimal service run in a child process by logger.process.test.ts. It boots exactly like an
// app (config first, then the logger) and writes to the real stdout, so the parent sees the bytes a log
// pipeline would see. The scenario is the first CLI argument.
import { createServer } from 'node:http';

import { baseEnvSchema, defineConfig, zSecret } from '@blackwing/config';

import { configureLogging, createLogger, withContext } from '../index.js';

import type { AddressInfo } from 'node:net';

const config = defineConfig(baseEnvSchema.extend({ API_TOKEN: zSecret(), CLIENT_PAT: zSecret() }));
configureLogging({ level: config.LOG_LEVEL, nodeEnv: config.NODE_ENV });
const log = createLogger('child-app');

/** Lines written before the fatal one, to show ordering survives the immediate exit. */
const LINES_BEFORE_FATAL = 500;
/** Exit status of the fatal scenario (sysexits EX_SOFTWARE). */
const FATAL_EXIT_CODE = 70;

function fatalThenExit(): void {
  for (let attempt = 1; attempt <= LINES_BEFORE_FATAL; attempt += 1) {
    log.info(
      { attempt, upstream: `https://svc.local/?key=${config.API_TOKEN}` },
      'retrying upstream',
    );
  }
  log.fatal(`cannot continue: upstream rejected ${config.API_TOKEN}`);
  // Exit at once: the fatal line must already be on stdout.
  process.exit(FATAL_EXIT_CODE);
}

function serveOneRequest(): void {
  const server = createServer((req, res) => {
    const requestLog = withContext(log, { tenantId: 'tnt_demo', runId: 'run_demo' });
    requestLog.info({ req }, 'request received');
    res.statusCode = 204;
    res.setHeader('set-cookie', 'bw_session=server-issued-session-0201; HttpOnly');
    res.end();
    requestLog.info({ res }, 'request completed');
  });
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as AddressInfo;
    void fetch(`http://127.0.0.1:${String(port)}/v1/runs?api_token=${config.API_TOKEN}`, {
      headers: {
        authorization: `Bearer ${config.CLIENT_PAT}`,
        cookie: 'bw_session=client-session-0201',
        'x-request-note': `forwarded ${config.CLIENT_PAT}`,
      },
    }).finally(() => {
      server.close();
    });
  });
}

function prettyLine(): void {
  log.info(
    { proxy: `http://${config.API_TOKEN}@egress:13128`, password: 'dev-password-0301' },
    'pretty line',
  );
}

const scenarios: Record<string, () => void> = {
  'fatal-exit': fatalThenExit,
  http: serveOneRequest,
  pretty: prettyLine,
};

const scenario = scenarios[process.argv[2] ?? ''];
if (scenario === undefined) {
  process.exitCode = 64;
} else {
  scenario();
}
