// Emergency stop links (design 3b): admin-only create/revoke/contact, hash-only storage, dead tokens indistinguishable,
// the per-client rate limit, and the stop itself (every live run halted, one ledger append).
import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { emergencyContactSchema, emergencyLinkSchema } from './controller.js';
import { ALL_ROLES, DemoService, EMERGENCY_TOKEN } from './service.js';

import type { DemoStore, EmergencyLinkRow } from './store.js';

const admin = { id: 'u1', email: 'a@x.test', name: 'Admin', roles: [...ALL_ROLES], admin: true };
const member = { id: 'u2', email: 'b@x.test', name: 'Member', roles: ['appsec-engineer'] };
const HOUR_MS = 3_600_000;
const sha = (s: string): Buffer => createHash('sha256').update(s).digest();

function linkRow(token: string, over: Partial<EmergencyLinkRow> = {}): EmergencyLinkRow {
  return {
    id: 'l1',
    token_hash: sha(token),
    label: 'SOC on-call',
    created_by: 'u1',
    created_by_name: 'Admin',
    created_at: new Date(Date.now() - HOUR_MS),
    expires_at: new Date(Date.now() + HOUR_MS),
    revoked_at: null,
    last_used_at: null,
    ...over,
  };
}

const run = (id: string, state: string) => ({ id, state, asset_name: `Target ${id}`, halt_ms: null });

function emergencyService(link: EmergencyLinkRow | null = null) {
  const store = {
    insertEmergencyLink: vi.fn((row: Record<string, unknown>) => Promise.resolve({ ...linkRow('x'), ...row })),
    listActiveEmergencyLinks: vi.fn().mockResolvedValue([]),
    revokeEmergencyLink: vi.fn().mockResolvedValue(linkRow('x')),
    findEmergencyLink: vi.fn().mockResolvedValue(link),
    touchEmergencyLink: vi.fn(),
    getEmergencyContact: vi.fn().mockResolvedValue({ name: 'On-call lead', phone: '+1 555 0100' }),
    setEmergencyContact: vi.fn(),
    getTenant: vi.fn().mockResolvedValue({ id: 't1', name: 'Workspace' }),
    listLiveRuns: vi.fn().mockResolvedValue([
      run('0197a5d0-aaaa-7000-8000-000000000001', 'queued'),
      run('0197a5d0-aaaa-7000-8000-000000000002', 'running'),
    ]),
    getRun: vi.fn().mockResolvedValue(null),
    killQueuedRun: vi.fn((_t: string, id: string) =>
      Promise.resolve(id.endsWith('1') ? new Date('2026-11-08T10:00:00Z') : null),
    ),
    requestKill: vi.fn().mockResolvedValue(new Date('2026-11-08T10:00:00Z')),
    appendEvent: vi.fn(),
    appendAudit: vi.fn().mockResolvedValue({ eventId: 'e1', hash: 'h1' }),
    appendAudits: vi.fn((_t: string, entries: unknown[]) =>
      Promise.resolve(entries.map((_e, i) => ({ eventId: `e${i}`, hash: `h${i}` }))),
    ),
  };
  return { store, service: new DemoService(store as unknown as DemoStore, 't1') };
}

describe('emergency links: administration', () => {
  it('creates a 32-byte token, stores only its SHA-256 and records the ledger without the token', async () => {
    const { store, service } = emergencyService();
    const before = Date.now();
    const created = await service.createEmergencyLink(admin, '24h', 'SOC on-call');
    expect(created.token).toMatch(EMERGENCY_TOKEN);
    expect(Buffer.from(created.token, 'base64url')).toHaveLength(32);
    const inserted = store.insertEmergencyLink.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(inserted.token_hash).toEqual(sha(created.token));
    expect(JSON.stringify(inserted)).not.toContain(created.token);
    expect((inserted.expires_at as Date).getTime() - before).toBeGreaterThanOrEqual(24 * HOUR_MS - 1000);
    expect(store.appendAudit).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ action: 'emergency_link.created', payload: expect.objectContaining({ label: 'SOC on-call', validity: '24h' }) }),
    );
    expect(JSON.stringify(store.appendAudit.mock.calls)).not.toContain(created.token);
  });

  it('two links never share a token', async () => {
    const { service } = emergencyService();
    const a = await service.createEmergencyLink(admin, '1h', null);
    const b = await service.createEmergencyLink(admin, '1h', null);
    expect(a.token).not.toBe(b.token);
  });

  it('refuses everyone but an administrator to create, list, revoke or set the contact', async () => {
    const { store, service } = emergencyService();
    await expect(service.createEmergencyLink(member, '1h', null)).rejects.toMatchObject({ response: { code: 'admin_required' } });
    await expect(service.emergencyLinks(member)).rejects.toMatchObject({ response: { code: 'admin_required' } });
    await expect(service.revokeEmergencyLink(member, 'l1')).rejects.toMatchObject({ response: { code: 'admin_required' } });
    await expect(service.setEmergencyContact(member, null)).rejects.toMatchObject({ response: { code: 'admin_required' } });
    expect(store.insertEmergencyLink).not.toHaveBeenCalled();
    expect(store.appendAudit).not.toHaveBeenCalled();
  });

  it('revokes a working link once and records it; a dead one is 404', async () => {
    const { store, service } = emergencyService();
    await service.revokeEmergencyLink(admin, 'l1');
    expect(store.appendAudit).toHaveBeenCalledWith('t1', expect.objectContaining({ action: 'emergency_link.revoked' }));
    store.revokeEmergencyLink.mockResolvedValueOnce(null);
    await expect(service.revokeEmergencyLink(admin, 'l1')).rejects.toMatchObject({ response: { code: 'not_found' } });
  });

  it('records setting and clearing the emergency contact', async () => {
    const { store, service } = emergencyService();
    await service.setEmergencyContact(admin, { name: 'On-call lead', phone: '+1 555 0100' });
    await service.setEmergencyContact(admin, null);
    expect(store.setEmergencyContact).toHaveBeenNthCalledWith(2, 't1', null);
    expect(store.appendAudit).toHaveBeenLastCalledWith(
      't1',
      expect.objectContaining({ action: 'workspace.emergency_contact', payload: { name: null } }),
    );
  });
});

describe('emergency links: the no-login page', () => {
  const token = 'A'.repeat(43);

  it('a working link shows the workspace, the live audits and the validity', async () => {
    const { service } = emergencyService(linkRow(token));
    await expect(service.emergencyView(token, 'ip1')).resolves.toMatchObject({
      status: 'active',
      workspace: 'Workspace',
      liveRuns: 2,
      link: { label: 'SOC on-call' },
    });
  });

  it.each([
    ['unknown', null],
    ['expired', linkRow(token, { expires_at: new Date(Date.now() - 1) })],
    ['revoked', linkRow(token, { revoked_at: new Date() })],
    ['a different hash', linkRow(token, { token_hash: sha('other') })],
  ])('an %s token reads as expired with only the contact', async (_name, row) => {
    const { service } = emergencyService(row);
    const view = await service.emergencyView(token, 'ip1');
    expect(view).toEqual({ status: 'expired', contact: { name: 'On-call lead', phone: '+1 555 0100' } });
  });

  it('a malformed token never reaches the database', async () => {
    const { store, service } = emergencyService(linkRow(token));
    await expect(service.emergencyView('short', 'ip1')).resolves.toMatchObject({ status: 'expired' });
    expect(store.findEmergencyLink).not.toHaveBeenCalled();
  });

  it('rate-limits each client, not the others', async () => {
    const { service } = emergencyService(null);
    for (let i = 0; i < 30; i += 1) await service.emergencyView(token, 'scanner');
    await expect(service.emergencyView(token, 'scanner')).rejects.toMatchObject({ response: { code: 'rate_limited' } });
    await expect(service.emergencyView(token, 'someone-else')).resolves.toMatchObject({ status: 'expired' });
  });

  it('stops every live run (queued killed here, running flagged) and writes one ledger append', async () => {
    const { store, service } = emergencyService(linkRow(token));
    const result = await service.emergencyStop(token, 'ip1');
    expect(store.killQueuedRun).toHaveBeenCalledTimes(2);
    expect(store.requestKill).toHaveBeenCalledTimes(1);
    expect(store.requestKill).toHaveBeenCalledWith('t1', '0197a5d0-aaaa-7000-8000-000000000002', null);
    expect(result.runs).toHaveLength(2);
    expect(store.touchEmergencyLink).toHaveBeenCalledWith('t1', 'l1');
    expect(store.appendAudits).toHaveBeenCalledTimes(1);
    const entries = store.appendAudits.mock.calls[0]?.[1] as { action: string; actorId: unknown; actorName: string }[];
    expect(entries.map((e) => e.action)).toEqual(['emergency_link.used', 'run.kill', 'run.kill']);
    expect(entries.every((e) => e.actorId === null && e.actorName === 'Emergency stop link (SOC on-call)')).toBe(true);
  });

  it('a dead link stops nothing', async () => {
    const { store, service } = emergencyService(linkRow(token, { revoked_at: new Date() }));
    await expect(service.emergencyStop(token, 'ip1')).rejects.toMatchObject({ response: { code: 'emergency_link_expired' } });
    await expect(service.emergencyRuns(token, 'ip1', [])).rejects.toMatchObject({ response: { code: 'emergency_link_expired' } });
    expect(store.killQueuedRun).not.toHaveBeenCalled();
    expect(store.requestKill).not.toHaveBeenCalled();
    expect(store.appendAudits).not.toHaveBeenCalled();
  });
});

describe('emergency link bodies', () => {
  it('accepts only the offered validities and a short label', () => {
    expect(emergencyLinkSchema.safeParse({ validity: '7d', label: 'SOC' }).success).toBe(true);
    expect(emergencyLinkSchema.safeParse({ validity: '30d' }).success).toBe(false);
    expect(emergencyLinkSchema.safeParse({ validity: '1h', label: 'x'.repeat(81) }).success).toBe(false);
  });

  it('a contact needs a name and a phone number, or null to clear it', () => {
    expect(emergencyContactSchema.safeParse({ contact: { name: 'Lead', phone: '+44 20 7946 0000' } }).success).toBe(true);
    expect(emergencyContactSchema.safeParse({ contact: { name: 'Lead', phone: 'call me' } }).success).toBe(false);
    expect(emergencyContactSchema.safeParse({ contact: null }).success).toBe(true);
  });
});
