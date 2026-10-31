import { Controller, Headers, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';

import {
  acceptRiskFindingSchema,
  duplicateFindingSchema,
  rejectFindingSchema,
  releaseFindingSchema,
} from '@blackwing/contracts';
import { getTenantContextOrThrow } from '@blackwing/db/tenant-context';

import { TRIAGE_SERVICE } from './tokens.js';
import { Idempotent } from '../idempotency/interceptor.js';
import { createZodDto, ZodBody } from '../validation/index.js';

import type { TriageService, TriageView } from './service.js';
import type { FastifyReply } from 'fastify';

class ReleaseFindingDto extends createZodDto(releaseFindingSchema) {}
class RejectFindingDto extends createZodDto(rejectFindingSchema) {}
class DuplicateFindingDto extends createZodDto(duplicateFindingSchema) {}
class AcceptRiskFindingDto extends createZodDto(acceptRiskFindingSchema) {}

const HTTP_OK = 200;

/** Sends the new ETag (the next `If-Match`) and `no-store`: a decision is per tenant and must not be cached. */
function answer(reply: FastifyReply, view: TriageView): TriageView['body'] {
  void reply.header('ETag', view.etag).header('cache-control', 'no-store');
  return view.body;
}

/**
 * Gate 3 decision routes (TRIAGE-004): `POST /v1/findings/{id}/release|reject|duplicate|accept-risk`. Thin: the tenant and
 * the actor come from the guard-resolved context, never from the body, and the service decides. Each needs an
 * `Idempotency-Key` (a replay returns the first answer) and an `If-Match` with the finding's ETag.
 */
@Controller('findings')
export class TriageController {
  constructor(@Inject(TRIAGE_SERVICE) private readonly service: TriageService) {}

  @Post(':id/release')
  @HttpCode(HTTP_OK)
  @Idempotent()
  async release(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @ZodBody(ReleaseFindingDto) body: ReleaseFindingDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return answer(reply, await this.service.decide(this.principal(), 'release', id, ifMatch, body));
  }

  @Post(':id/reject')
  @HttpCode(HTTP_OK)
  @Idempotent()
  async reject(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @ZodBody(RejectFindingDto) body: RejectFindingDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return answer(reply, await this.service.decide(this.principal(), 'reject', id, ifMatch, body));
  }

  @Post(':id/duplicate')
  @HttpCode(HTTP_OK)
  @Idempotent()
  async duplicate(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @ZodBody(DuplicateFindingDto) body: DuplicateFindingDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return answer(
      reply,
      await this.service.decide(this.principal(), 'duplicate', id, ifMatch, body),
    );
  }

  @Post(':id/accept-risk')
  @HttpCode(HTTP_OK)
  @Idempotent()
  async acceptRisk(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @ZodBody(AcceptRiskFindingDto) body: AcceptRiskFindingDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return answer(
      reply,
      await this.service.decide(this.principal(), 'accept-risk', id, ifMatch, {
        reason: body.reason,
        expiry: body.expiry,
      }),
    );
  }

  private principal() {
    const { tenantId, actor } = getTenantContextOrThrow();
    return { tenantId, actorId: actor.id };
  }
}
