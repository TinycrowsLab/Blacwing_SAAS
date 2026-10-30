import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from '@blackwing/contracts';

import { createTenantPolicyAuditHook, tenantPolicyAuditInput } from './audit.js';

import type { AuditEmitter, AuditEventInput } from '@blackwing/audit';
import type { TenantPolicyAuditEvent } from '@blackwing/db';

const TENANT = '0190a000-0000-7000-8000-00000000000a';
const ACTOR = '0190a000-0000-7000-8000-0000000000aa';

describe('tenantPolicyAuditInput (POLICY-001 §8.8)', () => {
  it('records a created version with its number and digest, never the policy text', () => {
    const event: TenantPolicyAuditEvent = {
      action: 'policy.version.created',
      tenantId: TENANT,
      actorId: ACTOR,
      version: 4,
      sha256: 'a'.repeat(64),
    };
    expect(tenantPolicyAuditInput(event)).toEqual({
      tenantId: TENANT,
      action: 'policy.version.created',
      actor: { type: 'user', id: ACTOR },
      target: { type: 'tenant', id: TENANT },
      outcome: 'success',
      metadata: { version: 4, sha256: 'a'.repeat(64) },
    });
  });

  it('records an activation and a rollback with the versions they moved between', () => {
    expect(
      tenantPolicyAuditInput({
        action: 'policy.activated',
        tenantId: TENANT,
        actorId: ACTOR,
        version: 3,
        previousVersion: null,
      }),
    ).toMatchObject({
      action: 'policy.activated',
      metadata: { version: 3, previousVersion: null },
    });
    expect(
      tenantPolicyAuditInput({
        action: 'policy.rolled_back',
        tenantId: TENANT,
        actorId: ACTOR,
        toVersion: 2,
        previousVersion: 3,
      }),
    ).toMatchObject({
      action: 'policy.rolled_back',
      metadata: { toVersion: 2, previousVersion: 3 },
    });
  });

  it('only ever names actions that exist in the audit catalogue', () => {
    for (const action of [
      'policy.version.created',
      'policy.activated',
      'policy.rolled_back',
    ] as const) {
      expect(AUDIT_ACTIONS).toContain(action);
    }
  });
});

describe('createTenantPolicyAuditHook', () => {
  it('appends each event through the emitter, on the mutation transaction', async () => {
    const appended: AuditEventInput[] = [];
    const emitter = {
      emitAuditInTx: (_tx: unknown, input: AuditEventInput) => {
        appended.push(input);
        return Promise.resolve(undefined as never);
      },
    } as unknown as Pick<AuditEmitter, 'emitAuditInTx'>;
    const hook = createTenantPolicyAuditHook(emitter);
    const tx = { execute: () => Promise.resolve({ rows: [] }) } as unknown as Parameters<
      ReturnType<typeof createTenantPolicyAuditHook>
    >[1];
    await hook(
      {
        action: 'policy.activated',
        tenantId: TENANT,
        actorId: ACTOR,
        version: 2,
        previousVersion: null,
      },
      tx,
    );
    expect(appended).toEqual([
      tenantPolicyAuditInput({
        action: 'policy.activated',
        tenantId: TENANT,
        actorId: ACTOR,
        version: 2,
        previousVersion: null,
      }),
    ]);
  });
});
