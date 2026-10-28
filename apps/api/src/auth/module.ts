import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { createAuthenticator, type AuthEventSink } from './authenticate.js';
import { type BearerTokenValidator, UNCONFIGURED_BEARER_VALIDATOR } from './bearer.js';
import { API_AUTHENTICATOR, AuthGuard } from './guard.js';

import type { KeycloakJwtValidator } from './keycloak-jwt.js';
import type { AuthMetrics } from './metrics.js';
import type { SessionCookieValidator } from './session-cookie.js';
import type { Logger } from '@blackwing/logger';
import type { Tracer } from '@opentelemetry/api';

/** What the global auth guard is built from. Each credential path is optional: an absent one refuses its shape. */
export interface AuthOptions {
  /** Keycloak JWT validator (absent: JWTs are refused). */
  readonly keycloak?: KeycloakJwtValidator | undefined;
  /** BFF session-cookie validator (absent: cookies are refused). */
  readonly session?: SessionCookieValidator | undefined;
  /** `bw_pat_`/`bw_ci_` validator owned by RBAC-007 (absent: opaque tokens are refused). */
  readonly bearer?: BearerTokenValidator | undefined;
  readonly metrics: AuthMetrics;
  readonly logger: Logger;
  /** Audit sink for every decision (IAM-012 attaches its writer). */
  readonly events?: AuthEventSink | undefined;
  /** Tracer for the `auth.validate` span; the global tracer when absent. */
  readonly tracer?: Tracer | undefined;
}

/** Installs the one global authentication guard (APP_GUARD). Not `@Global`: nothing else provides auth. */
@Module({})
export class AuthModule {
  static forRoot(options: AuthOptions): DynamicModule {
    const authenticator = createAuthenticator({
      keycloak: options.keycloak,
      session: options.session,
      bearer: options.bearer ?? UNCONFIGURED_BEARER_VALIDATOR,
      metrics: options.metrics,
      logger: options.logger,
      events: options.events,
      tracer: options.tracer,
    });
    return {
      module: AuthModule,
      providers: [
        { provide: API_AUTHENTICATOR, useValue: authenticator },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
      exports: [API_AUTHENTICATOR],
    };
  }
}
