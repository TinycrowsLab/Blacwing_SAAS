import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Res,
} from '@nestjs/common';

import {
  assessmentRequestListResponseSchema,
  assessmentRequestPublicIdSchema,
  type AssessmentRequestListResponse,
  type AssessmentRequestResponse,
  createAssessmentRequestSchema,
  type PreflightDryRunResponse,
  patchAssessmentRequestSchema,
} from '@blackwing/contracts';
import { getTenantContextOrThrow } from '@blackwing/db/tenant-context';
import { NotFoundError } from '@blackwing/errors';

import { ASSESSMENT_REQUEST_SERVICE } from './tokens.js';
import { Idempotent } from '../idempotency/interceptor.js';
import { createZodDto, ZodBody } from '../validation/index.js';

import type { AssessmentRequestService, AssessmentRequestView } from './service.js';
import type { FastifyReply } from 'fastify';

class CreateAssessmentRequestDto extends createZodDto(createAssessmentRequestSchema) {}
class PatchAssessmentRequestDto extends createZodDto(patchAssessmentRequestSchema) {}

const HTTP_OK = 200;

/** Sends the ETag and `no-store`: a request is per-tenant and must not be cached. */
function answer(reply: FastifyReply, view: AssessmentRequestView): AssessmentRequestResponse {
  void reply.header('ETag', view.etag).header('cache-control', 'no-store');
  return view.body;
}

/** A request path parameter is validated at the boundary: anything but an `areq_…` id is a 404 before the service. */
function requestId(value: string): string {
  const parsed = assessmentRequestPublicIdSchema.safeParse(value);
  if (!parsed.success) throw new NotFoundError('assessment request not found');
  return parsed.data;
}

/**
 * Assessment-request routes (SCOPE-005): `POST /v1/assessment-requests` (draft), `GET` list and detail,
 * `PATCH /:id` (If-Match), `POST /:id/submit` (Idempotency-Key, the gate), `POST /:id/preflight` (the read-only
 * dry run) and `POST /:id/withdraw` (If-Match).
 * The tenant and the actor come from the guard-resolved context, never from the body.
 */
@Controller('assessment-requests')
export class AssessmentRequestController {
  constructor(
    @Inject(ASSESSMENT_REQUEST_SERVICE) private readonly service: AssessmentRequestService,
  ) {}

  @Post()
  async create(
    @ZodBody(CreateAssessmentRequestDto) body: CreateAssessmentRequestDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AssessmentRequestResponse> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return answer(reply, await this.service.create({ tenantId, actorId: actor.id }, body));
  }

  @Get()
  async list(): Promise<AssessmentRequestListResponse> {
    const { tenantId, actor } = getTenantContextOrThrow();
    const items = (await this.service.list({ tenantId, actorId: actor.id })).map((v) => v.body);
    return assessmentRequestListResponseSchema.parse({ items });
  }

  @Get(':id')
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AssessmentRequestResponse> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return answer(reply, await this.service.get({ tenantId, actorId: actor.id }, requestId(id)));
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @ZodBody(PatchAssessmentRequestDto) body: PatchAssessmentRequestDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AssessmentRequestResponse> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return answer(
      reply,
      await this.service.update({ tenantId, actorId: actor.id }, requestId(id), ifMatch, body),
    );
  }

  /** Needs `Idempotency-Key`: a replay answers the original result and creates nothing new. */
  @Post(':id/submit')
  @HttpCode(HTTP_OK)
  @Idempotent()
  async submit(
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AssessmentRequestResponse> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return answer(reply, await this.service.submit({ tenantId, actorId: actor.id }, requestId(id)));
  }

  /**
   * The pre-submit dry run (#579): read-only, so it needs no `Idempotency-Key` and no `If-Match`. It answers the
   * feasibility of a submit (the checks that read our own records) and changes nothing.
   */
  @Post(':id/preflight')
  @HttpCode(HTTP_OK)
  async preflight(
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<PreflightDryRunResponse> {
    const { tenantId, actor } = getTenantContextOrThrow();
    void reply.header('cache-control', 'no-store');
    return this.service.dryRun({ tenantId, actorId: actor.id }, requestId(id));
  }

  @Post(':id/withdraw')
  @HttpCode(HTTP_OK)
  async withdraw(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AssessmentRequestResponse> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return answer(
      reply,
      await this.service.withdraw({ tenantId, actorId: actor.id }, requestId(id), ifMatch),
    );
  }
}
