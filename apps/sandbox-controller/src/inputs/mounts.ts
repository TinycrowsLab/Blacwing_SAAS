import { readOnlyMountSpecSchema, type ReadOnlyMountSpec } from '@blackwing/contracts';

import type { StagedRunInputs } from './stage.js';

/** Where the spec objects appear inside the sandbox (read-only). */
export const INPUTS_MOUNT_TARGET = '/inputs';
/** Where the source checkout appears inside the sandbox (read-only). */
export const SRC_MOUNT_TARGET = '/src';

/**
 * Read-only mounts for one run's staged inputs, in the sandbox spec's shape. The sources are `file://` references
 * to the controller's staging dirs, which the Docker driver binds with `:ro`. Each spec is re-parsed against the
 * contract, so a staging path the contract refuses (for example one with whitespace) fails closed here.
 *
 * OFFLINE-STUB(online-porting #913): the Kubernetes driver mounts only `secret://` and `configmap://` sources,
 * so these mounts are refused there until staged inputs ride a shared read-only volume (PVC or CSI) online.
 */
export function stagedInputMounts(staged: StagedRunInputs): ReadOnlyMountSpec[] {
  const mounts: ReadOnlyMountSpec[] = [
    {
      kind: 'inputs',
      source: `file://${staged.inputsDir}`,
      target: INPUTS_MOUNT_TARGET,
      readOnly: true,
    },
  ];
  if (staged.srcDir !== null) {
    mounts.push({
      kind: 'source',
      source: `file://${staged.srcDir}`,
      target: SRC_MOUNT_TARGET,
      readOnly: true,
    });
  }
  return mounts.map((mount) => readOnlyMountSpecSchema.parse(mount));
}
