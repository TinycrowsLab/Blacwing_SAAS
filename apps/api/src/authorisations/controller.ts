import {
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';

import {
  createStandingAuthorisationSchema,
  type Page,
  patchStandingAuthorisationSchema,
  rejectStandingAuthorisationSchema,
  type StandingAuthorisationDto,
  standingAuthorisationListQuerySchema,
} from '@blackwing/contracts';
import { getTenantContextOrThrow } from '@blackwing/db/tenant-context';

import { AUTHORISATION_EVIDENCE, AUTHORISATION_SERVICE } from './tokens.js';
import { Idempotent } from '../idempotency/interceptor.js';
import { createZodDto, ZodBody, ZodQuery } from '../validation/index.js';

import type { AuthorisationService, AuthorisationView } from './service.js';
import type { StepUpEvidence } from './step-up.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

const HTTP_CREATED = 201;
const HTTP_OK = 200;

class CreateStandingAuthorisationDto extends createZodDto(createStandingAuthorisationSchema) {}
class PatchStandingAuthorisationDto extends createZodDto(patchStandingAuthorisationSchema) {}
class StandingAuthorisationListQueryDto extends createZodDto(
  standingAuthorisationListQuerySchema,
) {}
class RejectStandingAuthorisationDto extends createZodDto(rejectStandingAuthorisationSchema) {}

/** Reads the step-up evidence of a request: the validated token's `acr` and `auth_time` (AUTHZ-008). */
export type AuthEvidenceSource = (request: FastifyRequest) => StepUpEvidence | undefined;

/** Sends the ETag and `no-store`: a standing authorisation is per-tenant and must not be cached (§9). */
function answer(reply: FastifyReply, view: AuthorisationView): StandingAuthorisationDto {
  void reply.header('ETag', view.etag).header('cache-control', 'no-store');
  return view.body;
}

/**
 * `/v1/standing-authorisations` (AUTHZ-002). Thin: the tenant and actor come from the guard-resolved
 * context, never from the body, and the service does the authorisation, the lifecycle and the write.
 * Every mutation returns the new ETag; the next change must send it back in `If-Match`.
 */
@Controller('standing-authorisations')
export class AuthorisationController {
  constructor(
    @Inject(AUTHORISATION_SERVICE) private readonly service: AuthorisationService,
    @Inject(AUTHORISATION_EVIDENCE) private readonly evidenceOf: AuthEvidenceSource,
  ) {}

  @Post()
  @HttpCode(HTTP_CREATED)
  @Idempotent()
  async create(
    @ZodBody(CreateStandingAuthorisationDto) body: CreateStandingAuthorisationDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StandingAuthorisationDto> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return answer(reply, await this.service.create({ tenantId, actorId: actor.id }, body));
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(
    @ZodQuery(StandingAuthorisationListQueryDto) query: StandingAuthorisationListQueryDto,
  ): Promise<Page<StandingAuthorisationDto>> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return this.service.list({ tenantId, actorId: actor.id }, query);
  }

  @Get(':id')
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StandingAuthorisationDto> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return answer(reply, await this.service.get({ tenantId, actorId: actor.id }, id));
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @ZodBody(PatchStandingAuthorisationDto) body: PatchStandingAuthorisationDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StandingAuthorisationDto> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return answer(
      reply,
      await this.service.update({ tenantId, actorId: actor.id }, id, ifMatch, body),
    );
  }

  @Post(':id/submit')
  @HttpCode(HTTP_OK)
  async submit(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StandingAuthorisationDto> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return answer(reply, await this.service.submit({ tenantId, actorId: actor.id }, id, ifMatch));
  }

  /** Approves a pending SA: needs a fresh strong authentication (`AUTHZ_STEPUP_REQUIRED`) and a different approver. */
  @Post(':id/approve')
  @HttpCode(HTTP_OK)
  async approve(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StandingAuthorisationDto> {
    const { tenantId, actor } = getTenantContextOrThrow();
    const auth = this.evidenceOf(request);
    return answer(
      reply,
      await this.service.approve(
        { tenantId, actorId: actor.id, ...(auth === undefined ? {} : { auth }) },
        id,
        ifMatch,
      ),
    );
  }

  /** Rejects a pending SA: it returns to draft for its requester, with the reason recorded. */
  @Post(':id/reject')
  @HttpCode(HTTP_OK)
  async reject(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @ZodBody(RejectStandingAuthorisationDto) body: RejectStandingAuthorisationDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StandingAuthorisationDto> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return answer(
      reply,
      await this.service.reject({ tenantId, actorId: actor.id }, id, ifMatch, body),
    );
  }
}
