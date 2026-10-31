import { describe, expect, it } from 'vitest';

import { mountSpecSchema } from '@blackwing/contracts';

import { INPUTS_MOUNT_TARGET, SRC_MOUNT_TARGET, stagedInputMounts } from './mounts.js';

import type { StagedRunInputs } from './stage.js';

const STAGED: StagedRunInputs = {
  inputsDir: '/var/lib/blackwing/staging/tenant/run/inputs',
  srcDir: '/var/lib/blackwing/staging/tenant/run/src',
  inputBytes: 10,
  sourceBytes: 20,
  objectKeys: ['tenant/specs/openapi.json'],
};

describe('stagedInputMounts', () => {
  it('mounts the spec objects at /inputs and the checkout at /src, both read-only', () => {
    const mounts = stagedInputMounts(STAGED);
    expect(mounts).toEqual([
      {
        kind: 'inputs',
        source: `file://${STAGED.inputsDir}`,
        target: INPUTS_MOUNT_TARGET,
        readOnly: true,
      },
      {
        kind: 'source',
        source: `file://${STAGED.srcDir}`,
        target: SRC_MOUNT_TARGET,
        readOnly: true,
      },
    ]);
    for (const mount of mounts) {
      expect(() => mountSpecSchema.parse(mount)).not.toThrow();
    }
  });

  it('mounts no source when the run has no repository', () => {
    const mounts = stagedInputMounts({ ...STAGED, srcDir: null });
    expect(mounts.map((mount) => mount.target)).toEqual([INPUTS_MOUNT_TARGET]);
  });

  it('refuses a staging path the sandbox contract cannot carry (fails closed)', () => {
    expect(() =>
      stagedInputMounts({ ...STAGED, inputsDir: '/var/lib/with space/inputs' }),
    ).toThrow();
  });

  it('never produces a writable mount, even though the stage is read-only by construction', () => {
    for (const mount of stagedInputMounts(STAGED)) {
      expect(mount.readOnly).toBe(true);
      expect(mount.kind).not.toBe('tmpfs');
    }
  });
});
