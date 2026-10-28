import { type DynamicModule, Module } from '@nestjs/common';

import { SignupController } from './controller.js';
import { createSignupMetrics } from './metrics.js';
import { SignupService } from './service.js';
import { SIGNUP_SERVICE } from './tokens.js';
import { API_CONFIG, API_LOGGER } from '../bootstrap/tokens.js';

import type { SignupStore, TenantProvisioningQueue } from './ports.js';
import type { ApiConfig } from '../config.js';
import type { Logger } from '@blackwing/logger';
import type { EmailSender } from '@blackwing/notify';
import type { Registry } from 'prom-client';

export interface SignupModuleOptions {
  /** Registry the `bw_signup_*` metrics live on (the app's `HttpMetrics.registry`). */
  readonly registry: Registry;
  /** The Postgres adapter in production. */
  readonly store: SignupStore;
  /** NOTIFY's e-mail sender (SMTP; Mailpit in dev). */
  readonly mailer: EmailSender;
  /** Hands a new tenant to Keycloak Organization provisioning (TENANT-005). */
  readonly provisioning: TenantProvisioningQueue;
}

/** Mounts `POST /v1/signup` and `POST /v1/signup/verify` (TENANT-004). Pass it as an extra `imports` entry. */
@Module({})
export class SignupModule {
  static forRoot(options: SignupModuleOptions): DynamicModule {
    return {
      module: SignupModule,
      controllers: [SignupController],
      providers: [
        {
          provide: SIGNUP_SERVICE,
          inject: [API_CONFIG, API_LOGGER],
          useFactory: (config: Readonly<ApiConfig>, logger: Logger): SignupService =>
            new SignupService({
              store: options.store,
              mailer: options.mailer,
              provisioning: options.provisioning,
              logger,
              metrics: createSignupMetrics(options.registry),
              settings: {
                tokenTtlHours: config.SIGNUP_TOKEN_TTL_HOURS,
                region: config.SIGNUP_DEFAULT_REGION,
                verifyUrl:
                  config.SIGNUP_VERIFY_URL ??
                  new URL('/signup/verify', config.WEB_ORIGIN[0]).toString(),
                emailMaxPerHour: config.SIGNUP_EMAIL_MAX_PER_HOUR,
              },
            }),
        },
      ],
    };
  }
}
