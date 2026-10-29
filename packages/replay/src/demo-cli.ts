import { httpFetcher } from './fetcher.js';
import { buildJuiceShopSqliPlan, JUICE_SHOP_LAB_ORIGIN } from './juice-shop-sqli.js';
import { replayFinding } from './replay.js';

/**
 * Runs the Juice Shop SQL injection demo against a local lab and prints the replay result as JSON.
 *
 *   pnpm --filter @blackwing/replay demo:juice-sqli [--target http://127.0.0.1:13000]
 *
 * Exit 0 when the candidate is Confirmed, 1 when Suspected, 2 on a refused target or a usage error.
 */
function targetFromArgs(argv: readonly string[]): string {
  const flag = argv.indexOf('--target');
  if (flag === -1) return JUICE_SHOP_LAB_ORIGIN;
  const value = argv[flag + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error('--target needs a lab origin, for example http://127.0.0.1:13000');
  }
  return value;
}

try {
  const plan = buildJuiceShopSqliPlan(targetFromArgs(process.argv.slice(2)));
  const result = await replayFinding(plan, httpFetcher);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.outcome === 'confirmed' ? 0 : 1;
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown error';
  process.stderr.write(`demo refused: ${message}\n`);
  process.exitCode = 2;
}
