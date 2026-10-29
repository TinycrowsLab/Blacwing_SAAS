import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';

import { ValidationError } from '@blackwing/errors';

import { assertLabTarget } from './lab-guard.js';

import type { Egress, Sandbox, SandboxProvider } from './engine.js';
import type { Fetcher } from './replay.js';
import type { ScopeRules } from '@blackwing/contracts';

/** Timeout for one lab TCP probe. */
export const LAB_PROBE_TIMEOUT_MS = 5_000;

/**
 * Egress for the local lab. Every target passes {@link assertLabTarget} (verified lab host, in scope) before any
 * byte is sent. Only GET is sent, because the lab fetcher is GET-only and refuses redirects. Other methods are
 * refused, so this adapter can never carry a state-changing request.
 */
export function createLabEgress(options: { scope: ScopeRules; fetcher: Fetcher }): Egress {
  const { scope, fetcher } = options;
  return {
    async request({ method, url, body }) {
      if (method !== 'GET') throw new ValidationError('the lab egress only sends GET requests');
      if (body !== null) throw new ValidationError('a GET request carries no body');
      assertLabTarget(url, scope);
      return fetcher(url);
    },
    async probe(host, port) {
      assertLabTarget(`http://${host}:${port}/`, scope);
      await tcpOpen(host, port);
    },
  };
}

/** Resolves once a TCP connection opens. Rejects on refusal or timeout. The socket is closed in both cases. */
function tcpOpen(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    socket.setTimeout(LAB_PROBE_TIMEOUT_MS, () => {
      socket.destroy(new Error('the probe timed out'));
    });
    socket.once('connect', () => {
      socket.end();
      resolve();
    });
    socket.once('error', (error) => {
      socket.destroy();
      reject(error);
    });
  });
}

/**
 * OFFLINE-STUB: an in-process sandbox for the local demo. It runs in the worker process and isolates nothing. It
 * records the pinned digest and returns it, so the engine's pin and fresh-sandbox rules are exercised. The Docker
 * sandbox that gives real isolation (§8.6) is the online port of this adapter.
 */
export function createLocalSandboxProvider(): SandboxProvider {
  return {
    provision({ imageDigest }) {
      const sandbox: Sandbox = {
        id: `local-${randomUUID()}`,
        imageDigest,
        terminate: () => Promise.resolve(),
      };
      return Promise.resolve(sandbox);
    },
  };
}
