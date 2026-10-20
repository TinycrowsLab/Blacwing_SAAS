// Resolves the Keycloak subject (`sub`) of each seed persona in the dev realm (DEVENV-004), so seeded
// `users.keycloak_sub` match the identities the console logs in with. Local Keycloak only.

import { z } from 'zod';

import { PERSONA_KEYS, type PersonaKey, SEED_PERSONAS } from './plan.js';

export interface KeycloakLookupOptions {
  /** e.g. `http://localhost:18080`. */
  readonly baseUrl: string;
  readonly realm: string;
  /** Master-realm admin (dev only). */
  readonly adminUser: string;
  readonly adminPassword: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface SubjectLookup {
  /** `sub` per persona Keycloak confirmed. */
  readonly subjects: Partial<Record<PersonaKey, string>>;
  /** Personas the realm does not contain, or every persona when Keycloak could not be asked. */
  readonly missing: readonly PersonaKey[];
  /** Why the lookup could not run, when it could not (no secrets). */
  readonly unavailable?: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const tokenSchema = z.object({ access_token: z.string().min(1) });
const usersSchema = z.array(z.object({ id: z.string().min(1), username: z.string() }));

/**
 * Looks each persona up via the admin API. Never throws: an unreachable Keycloak or an absent user is
 * reported in `missing`/`unavailable` so the caller can warn (the seed then keeps a `pending:` subject).
 */
export async function lookupSubjects(options: KeycloakLookupOptions): Promise<SubjectLookup> {
  const doFetch = options.fetch ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const base = options.baseUrl.replace(/\/+$/, '');
  try {
    const tokenResponse = await doFetch(`${base}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: options.adminUser,
        password: options.adminPassword,
      }),
      signal,
    });
    if (!tokenResponse.ok) {
      return {
        subjects: {},
        missing: PERSONA_KEYS,
        unavailable: `admin login returned HTTP ${tokenResponse.status}`,
      };
    }
    const { access_token: token } = tokenSchema.parse(await tokenResponse.json());
    const subjects: Partial<Record<PersonaKey, string>> = {};
    const missing: PersonaKey[] = [];
    for (const persona of SEED_PERSONAS) {
      const url = `${base}/admin/realms/${encodeURIComponent(options.realm)}/users?exact=true&username=${encodeURIComponent(persona.username)}`;
      const response = await doFetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal,
      });
      if (!response.ok) {
        return {
          subjects: {},
          missing: PERSONA_KEYS,
          unavailable: `user lookup returned HTTP ${response.status}`,
        };
      }
      const match = usersSchema
        .parse(await response.json())
        .find((u) => u.username === persona.username);
      if (match === undefined) missing.push(persona.key);
      else subjects[persona.key] = match.id;
    }
    return { subjects, missing };
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'unknown error';
    return {
      subjects: {},
      missing: PERSONA_KEYS,
      unavailable: `Keycloak not reachable (${reason})`,
    };
  }
}
