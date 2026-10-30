import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';

import { getTenantContextOrThrow } from '@blackwing/db/tenant-context';

import { PLAN_VALIDATION_SERVICE, TEST_PLAN_SERVICE } from './tokens.js';
import { Idempotent } from '../idempotency/index.js';

import type { Versioned, TestPlanService } from './service.js';
import type { PlanValidationService } from './validation/service.js';
import type {
  PlanValidationResult,
  TestCaseView,
  TestPlanPage,
  TestPlanView,
} from '@blackwing/contracts';
import type { FastifyReply } from 'fastify';

const HTTP_CREATED = 201;

/** Sends the ETag and `no-store`: a plan answer is per-tenant and must not be cached. */
function answer<T>(reply: FastifyReply, view: Versioned<T>, status = 200): T {
  void reply.status(status).header('ETag', view.etag).header('cache-control', 'no-store');
  return view.body;
}

/**
 * Editable test plans (PLAN-005). Thin: the tenant and the actor come from the guard-resolved context, never
 * from the body, and the service does the authorisation, the preconditions and the write.
 */
@Controller()
export class TestPlanController {
  constructor(
    @Inject(TEST_PLAN_SERVICE) private readonly service: TestPlanService,
    @Inject(PLAN_VALIDATION_SERVICE) private readonly validation: PlanValidationService,
  ) {}

  @Post('runs/:runId/test-plans')
  @Idempotent()
  async createVersion(
    @Param('runId') runId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<TestPlanView> {
    const { tenantId, actor } = getTenantContextOrThrow();
    const view = await this.service.createVersion({ tenantId, actorId: actor.id }, runId);
    void reply.header('location', `/v1/runs/${runId}/test-plans/${String(view.body.version)}`);
    return answer(reply, view, HTTP_CREATED);
  }

  @Get('runs/:runId/test-plans')
  async listVersions(
    @Param('runId') runId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<TestPlanPage> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return this.service.listVersions({ tenantId, actorId: actor.id }, runId, query);
  }

  @Get('runs/:runId/test-plans/:version')
  async getVersion(
    @Param('runId') runId: string,
    @Param('version') version: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<TestPlanView> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return answer(
      reply,
      await this.service.getVersion({ tenantId, actorId: actor.id }, runId, version),
    );
  }

  /** Validates a plan version (PLAN-006). A verdict with violations is a 200; only a missing plan is an error. */
  @Get('test-plans/:planId/validation')
  async validatePlan(@Param('planId') planId: string): Promise<PlanValidationResult> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return this.validation.validatePlan({ tenantId, actorId: actor.id }, planId);
  }

  @Post('test-plans/:planId/cases')
  @Idempotent()
  async addCase(
    @Param('planId') planId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<TestCaseView> {
    const { tenantId, actor } = getTenantContextOrThrow();
    const written = await this.service.addCase(
      { tenantId, actorId: actor.id },
      planId,
      ifMatch,
      body,
    );
    void reply.header('ETag', written.case.etag).header('cache-control', 'no-store');
    void reply.header('x-plan-etag', written.planEtag);
    return answer(reply, written.case, HTTP_CREATED);
  }

  @Patch('test-cases/:caseId')
  async updateCase(
    @Param('caseId') caseId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<TestCaseView> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return answer(
      reply,
      await this.service.updateCase({ tenantId, actorId: actor.id }, caseId, ifMatch, body),
    );
  }

  @Delete('test-cases/:caseId')
  async removeCase(
    @Param('caseId') caseId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<TestCaseView> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return answer(
      reply,
      await this.service.removeCase({ tenantId, actorId: actor.id }, caseId, ifMatch),
    );
  }
}
