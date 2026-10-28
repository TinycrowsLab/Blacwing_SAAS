import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { z } from 'zod';

import { killEgressIdentitySchema, type KillEgressIdentity } from '@blackwing/contracts';

import { egressIdentityKey } from '../activities.js';
import { EGRESS_KILL_PATH } from '../egress-client.js';
import { KEYS_REVOKE_PATH } from '../key-client.js';
import { SANDBOX_TERMINATE_PATH } from '../sandbox-client.js';

import type { AddressInfo } from 'node:net';

// In-process stand-in for the egress gateway control API, the sandbox controller and the model gateway
// key API. It speaks the exact paths and JSON the real HTTP adapters use, so the adapters run unmodified.
// OFFLINE-STUB(online-porting #902): the live gateway, controller and model gateway run in `real` mode only.

/**
 * What a control call does before it answers:
 * - `none`: applies the change and answers 200;
 * - `fail_before_apply`: answers 503 without applying. For egress the gateway then fails closed for every
 *   identity (§8.2: it cannot reach its policy, so it blocks);
 * - `apply_then_fail_ack`: applies the change, then answers 503, so the ack is lost but the effect stands;
 * - `delay_ack`: applies the change at once, then holds the 200 for `ms`.
 */
export type ControlFault =
  | { readonly kind: 'none' }
  | { readonly kind: 'fail_before_apply' }
  | { readonly kind: 'apply_then_fail_ack' }
  | { readonly kind: 'delay_ack'; readonly ms: number };

export interface ControlFaults {
  readonly egress: ControlFault;
  readonly sandbox: ControlFault;
  readonly keys: ControlFault;
}

export const NO_FAULTS: ControlFaults = {
  egress: { kind: 'none' },
  sandbox: { kind: 'none' },
  keys: { kind: 'none' },
};

const egressBodySchema = z.object({
  killEventId: z.string().min(1),
  identities: z.array(killEgressIdentitySchema),
});
const sandboxBodySchema = z.object({
  killEventId: z.string().min(1),
  sandboxIds: z.array(z.string().min(1)),
});
const keysBodySchema = z.object({
  killEventId: z.string().min(1),
  keyIds: z.array(z.string().min(1)),
});

const SERVICE_UNAVAILABLE = 503;
const OK = 200;

type Route = 'egress' | 'sandbox' | 'keys';

export class MockControlPlane {
  /** Per-route call counts, for assertions about retries. */
  readonly calls: Record<Route, number> = { egress: 0, sandbox: 0, keys: 0 };
  faults: ControlFaults = NO_FAULTS;
  private readonly blocked = new Set<string>();
  private readonly terminated = new Set<string>();
  private readonly revoked = new Set<string>();
  private failClosed = false;
  private readonly held = new Set<ServerResponse>();
  private constructor(
    private readonly server: Server,
    readonly baseUrl: string,
  ) {}

  static async start(): Promise<MockControlPlane> {
    const holder: { plane?: MockControlPlane } = {};
    const server = createServer((req, res) => {
      if (holder.plane === undefined) {
        res.statusCode = SERVICE_UNAVAILABLE;
        res.end();
        return;
      }
      holder.plane.route(req, res);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    const plane = new MockControlPlane(server, `http://127.0.0.1:${String(port)}`);
    holder.plane = plane;
    return plane;
  }

  async stop(): Promise<void> {
    for (const res of this.held) res.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** §8.2: may this identity send target traffic right now? The gateway denies while it is fail-closed. */
  allowsTraffic(identity: KillEgressIdentity): boolean {
    return !this.failClosed && !this.blocked.has(egressIdentityKey(identity));
  }

  isTerminated(sandboxId: string): boolean {
    return this.terminated.has(sandboxId);
  }

  isRevoked(keyId: string): boolean {
    return this.revoked.has(keyId);
  }

  private route(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.end();
        return;
      }
      const body: unknown = safeJson(Buffer.concat(chunks).toString());
      switch (req.url) {
        case EGRESS_KILL_PATH:
          this.handleEgress(body, res);
          return;
        case SANDBOX_TERMINATE_PATH:
          this.handleSandbox(body, res);
          return;
        case KEYS_REVOKE_PATH:
          this.handleKeys(body, res);
          return;
        default:
          res.statusCode = 404;
          res.end();
      }
    });
  }

  private handleEgress(body: unknown, res: ServerResponse): void {
    this.calls.egress += 1;
    const parsed = egressBodySchema.safeParse(body);
    if (!parsed.success) {
      badRequest(res);
      return;
    }
    const { identities } = parsed.data;
    const apply = (): { identity: KillEgressIdentity; outcome: string }[] =>
      identities.map((identity) => {
        const key = egressIdentityKey(identity);
        const outcome = this.blocked.has(key) ? 'already_blocked' : 'blocked';
        this.blocked.add(key);
        return { identity, outcome };
      });
    this.respond(
      'egress',
      this.faults.egress,
      res,
      apply,
      (acks) => ({ acks }),
      () => {
        this.failClosed = true;
      },
    );
  }

  private handleSandbox(body: unknown, res: ServerResponse): void {
    this.calls.sandbox += 1;
    const parsed = sandboxBodySchema.safeParse(body);
    if (!parsed.success) {
      badRequest(res);
      return;
    }
    const apply = (): { sandboxId: string; outcome: string }[] =>
      parsed.data.sandboxIds.map((sandboxId) => {
        const outcome = this.terminated.has(sandboxId) ? 'already_gone' : 'terminated';
        this.terminated.add(sandboxId);
        return { sandboxId, outcome };
      });
    this.respond('sandbox', this.faults.sandbox, res, apply, (acks) => ({ acks }));
  }

  private handleKeys(body: unknown, res: ServerResponse): void {
    this.calls.keys += 1;
    const parsed = keysBodySchema.safeParse(body);
    if (!parsed.success) {
      badRequest(res);
      return;
    }
    const apply = (): { keyId: string; outcome: string }[] =>
      parsed.data.keyIds.map((keyId) => {
        const outcome = this.revoked.has(keyId) ? 'already_revoked' : 'revoked';
        this.revoked.add(keyId);
        return { keyId, outcome };
      });
    this.respond('keys', this.faults.keys, res, apply, (acks) => ({ acks }));
  }

  private respond<A>(
    route: Route,
    fault: ControlFault,
    res: ServerResponse,
    apply: () => A,
    wrap: (acks: A) => unknown,
    onFailBeforeApply?: () => void,
  ): void {
    const answer = (status: number, payload: unknown): void => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    };
    switch (fault.kind) {
      case 'none':
        answer(OK, wrap(apply()));
        return;
      case 'fail_before_apply':
        onFailBeforeApply?.();
        answer(SERVICE_UNAVAILABLE, { error: `${route} unavailable` });
        return;
      case 'apply_then_fail_ack':
        apply();
        answer(SERVICE_UNAVAILABLE, { error: `${route} ack lost` });
        return;
      case 'delay_ack': {
        const acks = apply();
        this.held.add(res);
        const timer = setTimeout(() => {
          this.held.delete(res);
          if (!res.writableEnded) answer(OK, wrap(acks));
        }, fault.ms);
        res.on('close', () => {
          clearTimeout(timer);
          this.held.delete(res);
        });
        return;
      }
    }
  }
}

function badRequest(res: ServerResponse): void {
  res.statusCode = 400;
  res.end();
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
