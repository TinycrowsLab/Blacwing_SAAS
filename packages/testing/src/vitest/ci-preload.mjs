/**
 * Node preload (`node --import`) for the CI unit-test job (`pnpm test:ci`, scripts/ci-unit.mjs; CI-003, #137).
 * Added to NODE_OPTIONS so every Vitest worker process starts deterministic: the time zone is UTC and
 * fast-check draws from a fixed seed (BW_FC_SEED) instead of a random one. A failing property test
 * therefore fails identically on re-run; set BW_FC_SEED locally to explore other seeds.
 */
import fc from 'fast-check';

process.env.TZ = 'UTC';

const raw = process.env.BW_FC_SEED ?? '';
const seed = Number(raw);
if (raw !== '' && Number.isSafeInteger(seed)) {
  fc.configureGlobal({ seed });
}
