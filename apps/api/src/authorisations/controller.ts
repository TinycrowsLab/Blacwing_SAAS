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
  Res,
} from '@nestjs/common';

import {
  createStandingAuthorisationSchema,
  type Page,
  patchStandingAuthorisationSchema,
  type StandingAuthorisationDto,
  standingAuthorisationListQuerySchema,
} from '@blackwing/contracts';
import { getTenantContextOrThrow } from '@blackwing/db/tenant-context';

import { AUTHORISATION_SERVICE } from './tokens.js';
import { Idempotent } from '../idempotency/interceptor.js';
import { createZodDto, ZodBody, ZodQuery } from '../validation/index.js';

import type { AuthorisationService, AuthorisationView } from './service.js';
import type { FastifyReply } from 'fastify';

const HTTP_CREATED = 201;
const HTTP_OK = 200;

class CreateStandingAuthorisationDto extends createZodDto(createStandingAuthorisationSchema) {}
class PatchStandingAuthorisationDto extends createZodDto(patchStandingAuthorisationSchema) {}
class StandingAuthorisationListQueryDto extends createZodDto(
  standingAuthorisationListQuerySchema,
) {}

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
  constructor(@Inject(AUTHORISATION_SERVICE) private readonly service: AuthorisationService) {}

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
}
