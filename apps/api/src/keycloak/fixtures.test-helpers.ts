import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';

import { createLogger, type Logger } from '@blackwing/logger';

import { createKeycloakAdminClient, type KeycloakAdminClient } from './admin-client.js';
import { createOpenBaoClientSecretReader } from './client-secret.js';
import { createKeycloakMetrics, type KeycloakMetrics } from './metrics.js';
import {
  type OrganizationAuditEvent,
  type OrganizationAuditSink,
  OrganizationsService,
} from './organizations.service.js';

import type { KeycloakAdminSettings } from './settings.js';
import type { OpenBaoClient } from '@blackwing/secrets';
import type { Tracer } from '@opentelemetry/api';

// OFFLINE-STUB(online-porting #901): the Keycloak Admin API is a fake `fetch` and OpenBao a fake reader, because
// no Keycloak 26 or container runtime runs on this machine. Port the integration tests to a dev Keycloak.
const BASE = 'https://id.test.example';
const REALM = 'blackwing';
const CLIENT_ID = 'bw-org-admin';
export const SECRET_PATH = 'secret/data/platform/keycloak/org-admin';
export const SETTINGS: KeycloakAdminSettings = {
  baseUrl: BASE,
  realm: REALM,
  clientId: CLIENT_ID,
  secretPath: SECRET_PATH,
};

const HTTP = {
  ok: 200,
  created: 201,
  noContent: 204,
  unauthorized: 401,
  notFound: 404,
  methodNotAllowed: 405,
  conflict: 409,
} as const;
const TOKEN_LIFETIME_S = 300;
const DEFAULT_ATTEMPTS = 3;
const START_MS = 1_000_000;

interface StoredOrg {
  id: string;
  name: string;
  attributes: Record<string, string[]>;
  domains: { name: string; verified: boolean }[];
  members: Set<string>;
}

interface DomainRef {
  name: string;
  verified: boolean;
}

type Json = Record<string, unknown>;

/** The request body as text; only a string body is ever sent by the client under test. */
const bodyText = (init: RequestInit | undefined): string =>
  typeof init?.body === 'string' ? init.body : '';

/**
 * An in-memory stand-in for the Keycloak token and Admin REST endpoints. It reproduces the statuses the
 * service depends on (201 + Location, 404 for missing, 409 for duplicates and claimed domains, 401 for a
 * bad or revoked token) and records every call so tests can assert what was sent.
 */
class FakeKeycloak {
  readonly orgs = new Map<string, StoredOrg>();
  readonly calls: { method: string; path: string; search: string }[] = [];
  /** Current client secret; a test rotates it to model OpenBao rotation. */
  clientSecret = 'secret-v1';
  /** Tokens issued so far, and the set still accepted. */
  readonly issued: string[] = [];
  readonly revoked = new Set<string>();
  tokenLifetimeS = TOKEN_LIFETIME_S;
  /** When set, the token endpoint answers 200 with this body instead of a token (malformed-response tests). */
  tokenResponse: unknown = undefined;
  /** Queued statuses returned (and consumed) before normal handling, e.g. `[503]` for one transient failure. */
  readonly queuedStatuses: number[] = [];
  /** Queued network failures (fetch rejects), consumed before handling. */
  queuedNetworkFailures = 0;

  readonly fetch = (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    this.calls.push({ method, path: url.pathname, search: url.search });
    if (this.queuedNetworkFailures > 0) {
      this.queuedNetworkFailures -= 1;
      return Promise.reject(new TypeError('fetch failed'));
    }
    const queued = this.queuedStatuses.shift();
    if (queued !== undefined) return Promise.resolve(json(queued, { error: 'queued' }));
    return Promise.resolve(this.respond(url, method, init));
  };

  private respond(url: URL, method: string, init: RequestInit | undefined): Response {
    if (url.pathname === `/realms/${REALM}/protocol/openid-connect/token`) {
      return this.token(init);
    }
    const adminPrefix = `/admin/realms/${REALM}/organizations`;
    if (!url.pathname.startsWith(adminPrefix)) return json(HTTP.notFound, {});
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const bearer = auth.replace(/^Bearer /, '');
    if (!this.issued.includes(bearer) || this.revoked.has(bearer)) {
      return json(HTTP.unauthorized, {});
    }
    return this.organizations(method, url, adminPrefix, init);
  }

  private token(init: RequestInit | undefined): Response {
    const form = new URLSearchParams(bodyText(init));
    if (
      form.get('grant_type') !== 'client_credentials' ||
      form.get('client_id') !== CLIENT_ID ||
      form.get('client_secret') !== this.clientSecret
    ) {
      return json(HTTP.unauthorized, { error: 'unauthorized_client' });
    }
    if (this.tokenResponse !== undefined) return json(HTTP.ok, this.tokenResponse);
    const token = `tok-${this.issued.length + 1}`;
    this.issued.push(token);
    return json(HTTP.ok, { access_token: token, expires_in: this.tokenLifetimeS });
  }

  private organizations(
    method: string,
    url: URL,
    prefix: string,
    init: RequestInit | undefined,
  ): Response {
    // rest is '' | '/<id>' | '/<id>/members' | '/<id>/members/<user>'
    const rest = url.pathname.slice(prefix.length);
    if (rest === '' && method === 'GET') return json(HTTP.ok, this.search(url.searchParams));
    if (rest === '' && method === 'POST') return this.create(init);

    const [, id, members, userId] = rest.split('/');
    const org = id === undefined ? undefined : this.orgs.get(id);
    if (org === undefined) return json(HTTP.notFound, {});

    if (members === undefined) {
      if (method === 'GET') return json(HTTP.ok, this.rep(org));
      if (method === 'PUT') return this.update(org, init);
      if (method === 'DELETE') {
        this.orgs.delete(org.id);
        return new Response(null, { status: HTTP.noContent });
      }
    }
    if (members === 'members' && userId === undefined && method === 'POST') {
      const user = JSON.parse(bodyText(init) || '""') as string;
      if (org.members.has(user)) return json(HTTP.conflict, {});
      org.members.add(user);
      return new Response(null, { status: HTTP.noContent });
    }
    if (members === 'members' && userId !== undefined && method === 'DELETE') {
      if (!org.members.has(userId)) return json(HTTP.notFound, {});
      org.members.delete(userId);
      return new Response(null, { status: HTTP.noContent });
    }
    return json(HTTP.methodNotAllowed, {});
  }

  private search(params: URLSearchParams): Json[] {
    const search = params.get('search') ?? '';
    const exact = params.get('exact') === 'true';
    // Like older Keycloak releases, a non-exact search is a substring match.
    return [...this.orgs.values()]
      .filter((org) => (exact ? org.name === search : org.name.includes(search)))
      .map((org) => this.rep(org));
  }

  private create(init: RequestInit | undefined): Response {
    const body = JSON.parse(bodyText(init) || '{}') as Json;
    const name = String(body.name);
    if ([...this.orgs.values()].some((org) => org.name === name)) {
      return json(HTTP.conflict, {});
    }
    const domains = (body.domains as DomainRef[] | undefined) ?? [];
    if (this.domainClaimed(domains, undefined)) return json(HTTP.conflict, {});
    const id = randomUUID();
    this.orgs.set(id, {
      id,
      name,
      attributes: (body.attributes as Record<string, string[]> | undefined) ?? {},
      domains,
      members: new Set(),
    });
    return new Response(null, {
      status: HTTP.created,
      headers: { location: `${BASE}/admin/realms/${REALM}/organizations/${id}` },
    });
  }

  private update(org: StoredOrg, init: RequestInit | undefined): Response {
    const body = JSON.parse(bodyText(init) || '{}') as Json;
    const domains = (body.domains as DomainRef[] | undefined) ?? [];
    if (this.domainClaimed(domains, org.id)) return json(HTTP.conflict, {});
    org.attributes = (body.attributes as Record<string, string[]> | undefined) ?? {};
    org.domains = domains;
    return new Response(null, { status: HTTP.noContent });
  }

  private domainClaimed(domains: readonly DomainRef[], selfId: string | undefined): boolean {
    return [...this.orgs.values()].some(
      (org) => org.id !== selfId && org.domains.some((d) => domains.some((n) => n.name === d.name)),
    );
  }

  private rep(org: StoredOrg): Json {
    return {
      id: org.id,
      name: org.name,
      attributes: org.attributes,
      domains: org.domains,
      description: 'kept-by-passthrough',
    };
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Captures every log line so tests can assert that no token or secret was written. */
function captureLogs(): { logger: Logger; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  const logger = createLogger('keycloak-test', {
    level: 'debug',
    nodeEnv: 'test',
    destination: stream,
  });
  return { logger, text: () => chunks.join('') };
}

/** An OpenBao client whose KV v2 read returns the given secret under `data.data.client_secret`. */
export function fakeOpenBao(read: { secret: string | undefined }): OpenBaoClient & {
  readonly reads: string[];
} {
  const reads: string[] = [];
  return {
    reads,
    request(method, path) {
      reads.push(`${method} ${path}`);
      if (read.secret === undefined) {
        return Promise.resolve({ status: HTTP.notFound, data: undefined });
      }
      return Promise.resolve({
        status: HTTP.ok,
        data: { data: { client_secret: read.secret }, metadata: { version: 1 } },
      });
    },
  };
}

/** The audit port with its records kept for assertions. */
class RecordingAudit implements OrganizationAuditSink {
  readonly events: OrganizationAuditEvent[] = [];
  failWith: Error | undefined;

  record(event: OrganizationAuditEvent): Promise<void> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    this.events.push(event);
    return Promise.resolve();
  }
}

export interface Harness {
  readonly keycloak: FakeKeycloak;
  readonly metrics: KeycloakMetrics;
  readonly audit: RecordingAudit;
  readonly client: KeycloakAdminClient;
  readonly logs: () => string;
  readonly openBao: ReturnType<typeof fakeOpenBao>;
  /** The secret OpenBao currently holds; tests change it to model a rotation. */
  readonly openBaoSecret: { secret: string | undefined };
  readonly sleeps: number[];
  readonly now: { value: number };
  readonly service: (deps?: { audit?: OrganizationAuditSink }) => OrganizationsService;
}

/** Wires the real admin client and organisations service to the fake Keycloak, OpenBao, audit and logs. */
export function harness(options: { attempts?: number; tracer?: Tracer } = {}): Harness {
  const keycloak = new FakeKeycloak();
  const metrics = createKeycloakMetrics();
  const audit = new RecordingAudit();
  const { logger, text } = captureLogs();
  const openBaoSecret: { secret: string | undefined } = { secret: 'secret-v1' };
  const openBao = fakeOpenBao(openBaoSecret);
  const sleeps: number[] = [];
  const now = { value: START_MS };
  const client = createKeycloakAdminClient({
    settings: SETTINGS,
    readClientSecret: createOpenBaoClientSecretReader(openBao, SECRET_PATH),
    metrics,
    logger,
    fetch: keycloak.fetch,
    now: () => now.value,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    attempts: options.attempts ?? DEFAULT_ATTEMPTS,
    ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
  });
  return {
    keycloak,
    metrics,
    audit,
    client,
    logs: text,
    openBao,
    openBaoSecret,
    sleeps,
    now,
    service: (deps) => new OrganizationsService({ client, audit: deps?.audit ?? audit, logger }),
  };
}
