// DEMO-STORY HTTP surface, mounted at /v1/demo only when BW_DEMO_MODE=1. The browser never calls it: the demo
// web server calls it server-side with the shared internal token and the identity of the Keycloak session.
// Fail closed: a missing or wrong token is 401, an unknown user is 401, and nothing else is reachable.
import { timingSafeEqual } from 'node:crypto';

import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  UseFilters,
} from '@nestjs/common';
import { z } from 'zod';

import { DEMO_INTRUSIVENESS, DEMO_TEST_CASE } from './catalogue.js';
import { DemoRefusalFilter } from './filter.js';
import { isGoogleDemoSignIn } from './google-signin.js';
import { REPORT_FORMATS, renderReport, type ReportFormat } from './report.js';
import { DemoRefusal, type DemoActor, type DemoService } from './service.js';
import { DEMO_CONFIG, DEMO_SERVICE, DEMO_STORE } from './tokens.js';
import { PublicRoute } from '../tenant/public-route.js';
import { createZodDto, ZodBody, ZodQuery } from '../validation/index.js';

import type { DemoConfig } from './config.js';
import type { DemoStore } from './store.js';

const LIMITS = {
  testCase: 200,
  intrusiveness: 40,
  budgetRequests: 20,
  budgetSecondsMin: 60,
  budgetSecondsMax: 900,
  host: 255,
  pathPrefix: 512,
  reason: 500,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createRequestSchema = z.strictObject({
  assetId: z.string().regex(UUID),
  testCaseId: z.string().min(1).max(LIMITS.testCase),
  intrusiveness: z.string().min(1).max(LIMITS.intrusiveness),
  budgetRequests: z.int().min(1).max(LIMITS.budgetRequests),
  budgetSeconds: z.int().min(LIMITS.budgetSecondsMin).max(LIMITS.budgetSecondsMax),
  scope: z.strictObject({
    host: z.string().min(1).max(LIMITS.host),
    pathPrefix: z.string().min(1).max(LIMITS.pathPrefix).startsWith('/'),
  }),
});

const decisionSchema = z.strictObject({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().max(LIMITS.reason).nullable().default(null),
});

const runQuerySchema = z.object({ afterSeq: z.coerce.number().int().min(0).default(0) });
const reportQuerySchema = z.object({ format: z.enum(REPORT_FORMATS).default('html') });

class CreateRequestDto extends createZodDto(createRequestSchema) {}
class DecisionDto extends createZodDto(decisionSchema) {}
class RunQueryDto extends createZodDto(runQuerySchema) {}
class ReportQueryDto extends createZodDto(reportQuerySchema) {}

/** Constant-time comparison of the internal token (never logged). */
function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (presented === undefined || expected === '') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

@PublicRoute()
@UseFilters(DemoRefusalFilter)
@Controller('demo')
export class DemoController {
  constructor(
    @Inject(DEMO_CONFIG) private readonly config: DemoConfig,
    @Inject(DEMO_STORE) private readonly store: DemoStore,
    @Inject(DEMO_SERVICE) private readonly service: DemoService,
  ) {}

  /** Resolves the acting user from the internal hop: token, then the Keycloak-verified e-mail. */
  private async actor(headers: Record<string, string | string[] | undefined>): Promise<DemoActor> {
    const token = headers['x-bw-demo-token'];
    if (!tokenMatches(typeof token === 'string' ? token : undefined, this.config.internalToken)) {
      throw new DemoRefusal(
        HttpStatus.UNAUTHORIZED,
        'demo_token_invalid',
        'The demo internal token is missing or wrong.',
      );
    }
    const email = headers['x-bw-demo-user'];
    if (typeof email !== 'string' || email === '') {
      throw new DemoRefusal(
        HttpStatus.UNAUTHORIZED,
        'demo_user_missing',
        'No demo user was presented.',
      );
    }
    const rolesHeader = headers['x-bw-demo-roles'];
    const roles =
      typeof rolesHeader === 'string' && rolesHeader !== '' ? rolesHeader.split(',') : [];
    let user = await this.store.findActiveUserByEmail(email);
    // DEMO MODE ONLY: a first-time Google sign-in (marker role from the Google IdP mappers) gets its user and a
    // membership in the demo tenant. Every other unknown user is still refused.
    const sub = headers['x-bw-demo-sub'];
    const subject = typeof sub === 'string' ? sub : undefined;
    if (user === null && isGoogleDemoSignIn({ roles, sub: subject, email })) {
      user = await this.store.provisionGoogleUser(this.config.tenantId, {
        sub: subject ?? '',
        email,
        name: typeof headers['x-bw-demo-name'] === 'string' ? headers['x-bw-demo-name'] : null,
        roles,
      });
    }
    if (user === null)
      throw new DemoRefusal(
        HttpStatus.UNAUTHORIZED,
        'demo_user_unknown',
        'The user is not active in the demo tenant.',
      );
    return { id: user.id, email: user.email, name: user.name, roles };
  }

  @Get('dashboard')
  async dashboard(
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<unknown> {
    return this.service.dashboard(await this.actor(headers));
  }

  @Get('assets')
  async assets(
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<unknown> {
    await this.actor(headers);
    return { items: await this.service.assets() };
  }

  @Get('catalogue')
  async catalogue(
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<unknown> {
    await this.actor(headers);
    return {
      testCase: DEMO_TEST_CASE,
      intrusiveness: DEMO_INTRUSIVENESS,
      refused: ['state_changing', 'destructive'],
    };
  }

  @Post('requests')
  async createRequest(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @ZodBody(CreateRequestDto) body: CreateRequestDto,
  ): Promise<unknown> {
    const actor = await this.actor(headers);
    return this.service.createRequest(actor, {
      assetId: body.assetId,
      testCaseId: body.testCaseId,
      intrusiveness: body.intrusiveness,
      budgetRequests: body.budgetRequests,
      budgetSeconds: body.budgetSeconds,
      scope: body.scope,
    });
  }

  @Get('requests/:id')
  async request(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Param('id') id: string,
  ): Promise<unknown> {
    const actor = await this.actor(headers);
    if (!UUID.test(id))
      throw new DemoRefusal(HttpStatus.NOT_FOUND, 'not_found', 'No such request.');
    return this.service.request(id, actor.id);
  }

  @Post('requests/:id/decision')
  @HttpCode(HttpStatus.OK)
  async decide(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Param('id') id: string,
    @ZodBody(DecisionDto) body: DecisionDto,
  ): Promise<unknown> {
    const actor = await this.actor(headers);
    if (!UUID.test(id))
      throw new DemoRefusal(HttpStatus.NOT_FOUND, 'not_found', 'No such request.');
    return this.service.decideGate1(actor, id, body.decision, body.reason);
  }

  @Post('requests/:id/runs')
  async startRun(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Param('id') id: string,
  ): Promise<unknown> {
    const actor = await this.actor(headers);
    if (!UUID.test(id))
      throw new DemoRefusal(HttpStatus.NOT_FOUND, 'not_found', 'No such request.');
    return this.service.startRun(actor, id);
  }

  @Get('runs/:id')
  async run(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Param('id') id: string,
    @ZodQuery(RunQueryDto) query: RunQueryDto,
  ): Promise<unknown> {
    await this.actor(headers);
    if (!UUID.test(id)) throw new DemoRefusal(HttpStatus.NOT_FOUND, 'not_found', 'No such run.');
    return this.service.run(id, query.afterSeq);
  }

  @Get('findings')
  async findings(
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<unknown> {
    await this.actor(headers);
    return { items: await this.service.listFindings() };
  }

  @Get('findings/:id')
  async finding(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Param('id') id: string,
  ): Promise<unknown> {
    await this.actor(headers);
    if (!UUID.test(id))
      throw new DemoRefusal(HttpStatus.NOT_FOUND, 'not_found', 'No such finding.');
    return this.service.finding(id).then((row) => ({
      id: row.id,
      runId: row.run_id,
      title: row.title,
      status: row.status,
      cwe: row.cwe_id,
      owasp: row.owasp_category,
      severity: row.severity,
      location: row.location,
      oracle: row.oracle,
      evidence: row.evidence,
      replay: row.replay,
      reproCurl: row.repro_curl,
      createdAt: row.created_at.toISOString(),
    }));
  }

  @Get('findings/:id/report')
  async report(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Param('id') id: string,
    @ZodQuery(ReportQueryDto) query: ReportQueryDto,
  ): Promise<unknown> {
    await this.actor(headers);
    if (!UUID.test(id))
      throw new DemoRefusal(HttpStatus.NOT_FOUND, 'not_found', 'No such finding.');
    const ctx = await this.service.reportContext(id);
    const format: ReportFormat = query.format;
    return renderReport(ctx, format);
  }
}
