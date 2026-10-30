import { SbxDriverUnavailableError } from '../errors.js';
import { DockerDriver } from './docker.js';
import {
  DEFAULT_SANDBOX_CPU,
  DEFAULT_SANDBOX_MEMORY_MIB,
  DEFAULT_SANDBOX_PIDS,
  DEFAULT_SANDBOX_WORKSPACE_MIB,
} from '../config.js';
import { KubernetesDriver } from './kubernetes.js';
import { hardeningConfigFrom } from '../spec/hardening.js';

import type { SandboxDriver } from './driver.js';
import type { SandboxDriverKind } from '@blackwing/contracts';

export type { SandboxDriver } from './driver.js';
export { FakeDriver, type FakeDriverOptions } from './fake.js';
export type { CaProvisioner, IssueRunCaInput, RunCaRef, RunScope } from './types.js';

/**
 * Stand-in for a driver kind this build does not ship. Every operation rejects, so `/readyz` stays 503 and
 * nothing is created. Both shipped kinds (kubernetes, docker) are real drivers, so the factory never uses it.
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
  readonly SBX_NAMESPACE?: string;
  readonly SBX_CPU?: number;
  readonly SBX_MEM_MIB?: number;
  readonly SBX_PIDS?: number;
  readonly SBX_WORKSPACE_MIB?: number;
}

export type DriverFactory = (kind: SandboxDriverKind, config?: DriverConfig) => SandboxDriver;

/**
 * Default factory. Both drivers are lazy (no cluster or daemon contact until first use). DockerDriver
 * accepts `runc` only outside production (dev/test hosts without gVisor) and never as a fallback for a
 * missing `runsc`. KubernetesDriver always runs under the `runsc` RuntimeClass.
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
  return new KubernetesDriver({
    namespace: config?.SBX_NAMESPACE ?? 'bw-runs',
    hardening: hardeningConfigFrom({
      SBX_CPU: config?.SBX_CPU ?? DEFAULT_SANDBOX_CPU,
      SBX_MEM_MIB: config?.SBX_MEM_MIB ?? DEFAULT_SANDBOX_MEMORY_MIB,
      SBX_PIDS: config?.SBX_PIDS ?? DEFAULT_SANDBOX_PIDS,
      SBX_WORKSPACE_MIB: config?.SBX_WORKSPACE_MIB ?? DEFAULT_SANDBOX_WORKSPACE_MIB,
    }),
  });
};
