import { Controller, Header, HttpCode, Inject, Post } from '@nestjs/common';

import {
  type SignupAccepted,
  signupRequestSchema,
  type SignupVerified,
  signupVerifyRequestSchema,
} from '@blackwing/contracts';

import { SIGNUP_SERVICE } from './tokens.js';
import { Idempotent } from '../idempotency/interceptor.js';
import { RateLimit } from '../rate-limit/policy.js';
import { PublicRoute } from '../tenant/public-route.js';
import { createZodDto, ZodBody } from '../validation/index.js';

import type { SignupService } from './service.js';

const HTTP_ACCEPTED = 202;
const HTTP_OK = 200;

/** Route class of both signup routes: one per-IP bucket for the unauthenticated caller (TENANT-011 tunes it). */
const SIGNUP_RATE_LIMIT = { routeClass: 'signup', rps: 1, burst: 5 } as const;

class SignupRequestDto extends createZodDto(signupRequestSchema) {}
class SignupVerifyDto extends createZodDto(signupVerifyRequestSchema) {}

/**
 * Self-service signup (TENANT-004). Public by design: the caller has no account and no tenant yet, so both
 * routes are `@PublicRoute()` and charged to the client IP. Bodies carry an e-mail address or a token, so
 * neither response may be cached.
 */
@PublicRoute()
@Controller('signup')
export class SignupController {
  constructor(@Inject(SIGNUP_SERVICE) private readonly service: SignupService) {}

  /** `POST /v1/signup`: 202 with one fixed body, whatever the address is. Needs `Idempotency-Key`. */
  @Post()
  @HttpCode(HTTP_ACCEPTED)
  @Header('Cache-Control', 'no-store')
  @RateLimit(SIGNUP_RATE_LIMIT)
  @Idempotent({ anonymous: true })
  request(@ZodBody(SignupRequestDto) body: SignupRequestDto): Promise<SignupAccepted> {
    return this.service.request(body);
  }

  /** `POST /v1/signup/verify`: creates the tenant, or `400 SIGNUP_TOKEN_INVALID`. */
  @Post('verify')
  @HttpCode(HTTP_OK)
  @Header('Cache-Control', 'no-store')
  @RateLimit(SIGNUP_RATE_LIMIT)
  verify(@ZodBody(SignupVerifyDto) body: SignupVerifyDto): Promise<SignupVerified> {
    return this.service.verify(body.token);
  }
}
