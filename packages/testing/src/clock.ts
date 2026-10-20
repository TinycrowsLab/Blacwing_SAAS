/**
 * Test time. `@blackwing/time` (FOUND-011) owns the `Clock` abstraction and `FixedClock`; this
 * module re-exports them for test code and fixes the instant deterministic tests start from.
 */
export { type Clock, FixedClock, type InstantInput } from '@blackwing/time';

/** Default start instant for deterministic tests: a fixed, recognisable UTC epoch. */
export const DEFAULT_TEST_EPOCH = '2026-01-01T00:00:00.000Z';
