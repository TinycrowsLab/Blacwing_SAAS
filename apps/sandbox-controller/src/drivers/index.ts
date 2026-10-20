import { SbxDriverUnavailableError } from '../errors.js';

import type { SandboxDriver } from './driver.js';
import type { SandboxDriverKind } from '@blackwing/contracts';

export type { SandboxDriver } from './driver.js';
export { FakeDriver, type FakeDriverOptions } from './fake.js';
export type { CaProvisioner, RunCaRef, RunScope } from './types.js';

/**
 * Stand-in for a driver this build does not ship yet (KubernetesDriver: SANDBOX-003, DockerDriver:
 * SANDBOX-004). It fails closed: every operation rejects, so `/readyz` stays 503 and nothing is created.
 */
export class UnavailableDriver implements SandboxDriver {
  readonly kind: SandboxDriverKind;

  constructor(kind: SandboxDriverKind) {
    this.kind = kind;
  }

  private unavailable(): SbxDriverUnavailableError {
    return new SbxDriverUnavailableError(`${this.kind} driver is not available in this build`);
  }

  ping(): Promise<void> {
    return Promise.reject(this.unavailable());
  }

  ensureNetwork(): Promise<never> {
    return Promise.reject(this.unavailable());
  }

  removeNetwork(): Promise<void> {
    return Promise.reject(this.unavailable());
  }

  create(): Promise<never> {
    return Promise.reject(this.unavailable());
  }

  start(): Promise<void> {
    return Promise.reject(this.unavailable());
  }

  health(): Promise<never> {
    return Promise.reject(this.unavailable());
  }

  logs(): AsyncIterable<never> {
    const error = this.unavailable();
    return {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }),
    };
  }

  stop(): Promise<void> {
    return Promise.reject(this.unavailable());
  }

  destroy(): Promise<void> {
    return Promise.reject(this.unavailable());
  }

  list(): Promise<never> {
    return Promise.reject(this.unavailable());
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export type DriverFactory = (kind: SandboxDriverKind) => SandboxDriver;

/** Default factory. SANDBOX-003/004 replace the branches with lazily-initialised real drivers. */
export const createDriver: DriverFactory = (kind) => new UnavailableDriver(kind);
