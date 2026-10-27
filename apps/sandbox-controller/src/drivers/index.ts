import { SbxDriverUnavailableError } from '../errors.js';
import { DockerDriver } from './docker.js';

import type { SandboxDriver } from './driver.js';
import type { SandboxDriverKind } from '@blackwing/contracts';

export type { SandboxDriver } from './driver.js';
export { FakeDriver, type FakeDriverOptions } from './fake.js';
export type { CaProvisioner, RunCaRef, RunScope } from './types.js';

/**
 * Stand-in for a driver this build does not ship yet (KubernetesDriver: SANDBOX-003). It fails closed: every operation rejects, so `/readyz` stays 503 and nothing is created.
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

/** Driver-relevant slice of the controller config. */
interface DriverConfig {
  readonly NODE_ENV: string;
  readonly SBX_DOCKER_RUNTIME?: string;
  readonly SBX_DOCKER_SOCKET?: string;
  readonly SBX_DOCKER_PULL?: boolean;
}

export type DriverFactory = (kind: SandboxDriverKind, config?: DriverConfig) => SandboxDriver;

/**
 * Default factory. DockerDriver is lazy (no daemon contact until first use). `runc` is accepted only
 * outside production (dev/test hosts without gVisor) and is never a fallback for a missing `runsc`.
 * SANDBOX-003 replaces the kubernetes branch.
 */
export const createDriver: DriverFactory = (kind, config) => {
  if (kind === 'docker') {
    const runtime = config?.SBX_DOCKER_RUNTIME ?? 'runsc';
    return new DockerDriver({
      runtime,
      allowInsecureRuntime: runtime !== 'runsc' && config?.NODE_ENV !== 'production',
      socketPath: config?.SBX_DOCKER_SOCKET ?? '/var/run/docker.sock',
      pullMissingImages: config?.SBX_DOCKER_PULL ?? false,
    });
  }
  return new UnavailableDriver(kind);
};
