// Lint fixture: skipped, focused and todo tests (expected: vitest/no-disabled-tests,
// vitest/no-focused-tests, vitest/warn-todo).
import { describe, expect, it } from 'vitest';

describe('fixture', () => {
  it.skip('is skipped', () => {
    expect(1).toBe(1);
  });

  it.only('is focused', () => {
    expect(1).toBe(1);
  });

  it.todo('is not written yet');
});
