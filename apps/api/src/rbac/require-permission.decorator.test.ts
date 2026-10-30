import { describe, expect, it } from 'vitest';

import { PERMISSIONS } from '@blackwing/contracts';

import {
  AUTHENTICATED_ONLY_KEY,
  AuthenticatedOnly,
  RBAC_REQUIREMENT_KEY,
  RequireAnyPermission,
  RequirePermission,
} from './require-permission.decorator.js';

class Handlers {
  @RequirePermission('run:create', 'sa:approve')
  all(): { ok: true } {
    return { ok: true };
  }

  @RequireAnyPermission('asset:read')
  any(): { ok: true } {
    return { ok: true };
  }

  @AuthenticatedOnly()
  me(): { ok: true } {
    return { ok: true };
  }

  undeclared(): { ok: true } {
    return { ok: true };
  }
}

/** The decorated method itself: method metadata is stored on the function, not on the prototype. */
const handler = (method: keyof Handlers): object =>
  Object.getOwnPropertyDescriptor(Handlers.prototype, method)?.value as object;

const requirementOf = (method: keyof Handlers): unknown =>
  Reflect.getMetadata(RBAC_REQUIREMENT_KEY, handler(method));

describe('RBAC decorators (RBAC-003)', () => {
  it('records @RequirePermission as an all-of requirement on the handler', () => {
    expect(requirementOf('all')).toEqual({
      mode: 'all',
      permissions: ['run:create', 'sa:approve'],
    });
  });

  it('records @RequireAnyPermission as an any-of requirement on the handler', () => {
    expect(requirementOf('any')).toEqual({ mode: 'any', permissions: ['asset:read'] });
  });

  it('marks @AuthenticatedOnly() and leaves an undecorated handler with no metadata (deny by default)', () => {
    expect(Reflect.getMetadata(AUTHENTICATED_ONLY_KEY, handler('me'))).toBe(true);
    expect(requirementOf('undeclared')).toBeUndefined();
    expect(Reflect.getMetadata(AUTHENTICATED_ONLY_KEY, handler('undeclared'))).toBeUndefined();
  });

  it('rejects a permission outside the closed catalogue at decoration time', () => {
    // The type system refuses this at build time; the runtime check covers untyped callers.
    expect(() => RequirePermission('nope:nope' as never)).toThrow(TypeError);
    expect(() => RequireAnyPermission('run:create', 'superuser:all' as never)).toThrow(
      /outside the catalogue: superuser:all/,
    );
  });

  it('accepts every catalogue permission', () => {
    for (const permission of PERMISSIONS) {
      expect(() => RequirePermission(permission)).not.toThrow();
    }
  });

  it('is a compile error to name a permission outside the catalogue', () => {
    // @ts-expect-error 'run:nope' is not in the permission catalogue
    expect(() => RequirePermission('run:nope')).toThrow(TypeError);
  });
});
