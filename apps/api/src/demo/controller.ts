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

import { DemoRefusalFilter } from './filter.js';
import { isGoogleDemoSignIn } from './google-signin.js';
import { REPORT_FORMATS, renderReport, type ReportFormat } from './report.js';
import { DemoRefusal, INTRUSIVENESS, findingDto, type DemoActor, type DemoService } from './service.js';
import { DEMO_CONFIG, DEMO_SERVICE, DEMO_STORE } from './tokens.js';
import { PublicRoute } from '../tenant/public-route.js';
import { createZodDto, ZodBody, ZodQuery } from '../validation/index.js';

import type { DemoConfig } from './config.js';
import type { DemoStore } from './store.js';

const LIMITS = {
  name: 120,
  url: 2048,
  path: 512,
  listItems: 50,
  objective: 2000,
  reason: 500,
  statement: 1000,
  budgetRequestsMin: 10,
  budgetRequestsMax: 5000,
  budgetSecondsMin: 60,
  budgetSecondsMax: 7200,
  costCapMin: 0.5,
  costCapMax: 100,
  statementMin: 10,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const webUrl = z.url({ protocol: /^https?$/ }).max(LIMITS.url);
const excludedPaths = z.array(z.string().min(1).max(LIMITS.path).startsWith('/')).max(LIMITS.listItems).default([]);

const createAssetSchema = z.strictObject({
  name: z.string().trim().min(1).max(LIMITS.name),
  baseUrl: webUrl,
  extraOrigins: z.array(webUrl).max(LIMITS.listItems).default([]),
  excludedPaths,
});

const verifyAssetSchema = z
  .strictObject({
    method: z.enum(['http_token', 'owner_attestation']),
    statement: z.string().trim().min(LIMITS.statementMin).max(LIMITS.statement).optional(),
  })
  .refine((v) => v.method === 'http_token' || v.statement !== undefined, {
    path: ['statement'],
    message: 'owner_attestation needs a statement',
  });

const createRequestSchema = z.strictObject({
  assetId: z.string().regex(UUID),
  objective: z.string().trim().min(1).max(LIMITS.objective),
  intrusiveness: z.enum(INTRUSIVENESS),
  budgetRequests: z.int().min(LIMITS.budgetRequestsMin).max(LIMITS.budgetRequestsMax),
  budgetSeconds: z.int().min(LIMITS.budgetSecondsMin).max(LIMITS.budgetSecondsMax),
  costCapUsd: z.number().min(LIMITS.costCapMin).max(LIMITS.costCapMax),
  excludedPaths,
});

const decisionSchema = z.strictObject({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().max(LIMITS.reason).nullable().default(null),
});

const killSchema = z.strictObject({ scope: z.literal('run'), confirm: z.string().max(LIMITS.name) });
const gate2DecisionSchema = z.strictObject({ decision: z.enum(['approve', 'deny']) });

const afterSeqQuerySchema = z.object({ afterSeq: z.coerce.number().int().min(0).default(0) });
const reportQuerySchema = z.object({ format: z.enum(REPORT_FORMATS).default('html') });

class CreateAssetDto extends createZodDto(createAssetSchema) {}
class VerifyAssetDto extends createZodDto(verifyAssetSchema) {}
class CreateRequestDto extends createZodDto(createRequestSchema) {}
class DecisionDto extends createZodDto(decisionSchema) {}
class KillDto extends createZodDto(killSchema) {}
class Gate2DecisionDto extends createZodDto(gate2DecisionSchema) {}
class AfterSeqQueryDto extends createZodDto(afterSeqQuerySchema) {}
class ReportQueryDto extends createZodDto(reportQuerySchema) {}

type RequestHeaders = Record<string, string | string[] | undefined>;

/** Rejects a malformed id as 404 before it reaches the database. */
function uuid(id: string, what: string): string {
  if (!UUID.test(id)) throw new DemoRefusal(HttpStatus.NOT_FOUND, 'not_found', `No such ${what}.`);
  return id;
}

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
  private async actor(headers: RequestHeaders): Promise<DemoActor> {
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
  async dashboard(@Headers() headers: RequestHeaders): Promise<unknown> {
    return this.service.dashboard(await this.actor(headers));
  }

  @Get('assets')
  async assets(@Headers() headers: RequestHeaders): Promise<unknown> {
    await this.actor(headers);
    return { items: await this.service.assets() };
  }

  @Get('assets/:id')
  async asset(@Headers() headers: RequestHeaders, @Param('id') id: string): Promise<unknown> {
    await this.actor(headers);
    return this.service.asset(uuid(id, 'asset'));
  }

  @Post('assets')
  async createAsset(@Headers() headers: RequestHeaders, @ZodBody(CreateAssetDto) body: CreateAssetDto): Promise<unknown> {
    return this.service.createAsset(await this.actor(headers), body);
  }

  @Post('assets/:id/verify')
  @HttpCode(HttpStatus.OK)
  async verifyAsset(
    @Headers() headers: RequestHeaders,
    @Param('id') id: string,
    @ZodBody(VerifyAssetDto) body: VerifyAssetDto,
  ): Promise<unknown> {
    return this.service.verifyAsset(await this.actor(headers), uuid(id, 'asset'), body);
  }

  @Post('requests')
  async createRequest(
    @Headers() headers: RequestHeaders,
    @ZodBody(CreateRequestDto) body: CreateRequestDto,
  ): Promise<unknown> {
    return this.service.createRequest(await this.actor(headers), body);
  }

  @Get('requests/:id')
  async request(@Headers() headers: RequestHeaders, @Param('id') id: string): Promise<unknown> {
    const actor = await this.actor(headers);
    return this.service.request(uuid(id, 'request'), actor.id);
  }

  @Post('requests/:id/decision')
  @HttpCode(HttpStatus.OK)
  async decide(
    @Headers() headers: RequestHeaders,
    @Param('id') id: string,
    @ZodBody(DecisionDto) body: DecisionDto,
  ): Promise<unknown> {
    const actor = await this.actor(headers);
    return this.service.decideGate1(actor, uuid(id, 'request'), body.decision, body.reason);
  }

  @Post('requests/:id/runs')
  async startRun(@Headers() headers: RequestHeaders, @Param('id') id: string): Promise<unknown> {
    return this.service.startRun(await this.actor(headers), uuid(id, 'request'));
  }

  @Get('runs/:id')
  async run(
    @Headers() headers: RequestHeaders,
    @Param('id') id: string,
    @ZodQuery(AfterSeqQueryDto) query: AfterSeqQueryDto,
  ): Promise<unknown> {
    await this.actor(headers);
    return this.service.run(uuid(id, 'run'), query.afterSeq);
  }

  @Get('runs/:id/exchanges')
  async exchanges(
    @Headers() headers: RequestHeaders,
    @Param('id') id: string,
    @ZodQuery(AfterSeqQueryDto) query: AfterSeqQueryDto,
  ): Promise<unknown> {
    await this.actor(headers);
    return this.service.exchanges(uuid(id, 'run'), query.afterSeq);
  }

  @Post('runs/:id/pause')
  @HttpCode(HttpStatus.OK)
  async pause(@Headers() headers: RequestHeaders, @Param('id') id: string): Promise<unknown> {
    return this.service.setPaused(await this.actor(headers), uuid(id, 'run'), true);
  }

  @Post('runs/:id/resume')
  @HttpCode(HttpStatus.OK)
  async resume(@Headers() headers: RequestHeaders, @Param('id') id: string): Promise<unknown> {
    return this.service.setPaused(await this.actor(headers), uuid(id, 'run'), false);
  }

  @Post('runs/:id/kill')
  @HttpCode(HttpStatus.OK)
  async kill(
    @Headers() headers: RequestHeaders,
    @Param('id') id: string,
    @ZodBody(KillDto) body: KillDto,
  ): Promise<unknown> {
    return this.service.kill(await this.actor(headers), uuid(id, 'run'), body.confirm);
  }

  @Get('gate2/:id')
  async gate2(@Headers() headers: RequestHeaders, @Param('id') id: string): Promise<unknown> {
    await this.actor(headers);
    return this.service.gate2(uuid(id, 'Gate 2 request'));
  }

  @Post('gate2/:id/decision')
  @HttpCode(HttpStatus.OK)
  async decideGate2(
    @Headers() headers: RequestHeaders,
    @Param('id') id: string,
    @ZodBody(Gate2DecisionDto) body: Gate2DecisionDto,
  ): Promise<unknown> {
    return this.service.decideGate2(await this.actor(headers), uuid(id, 'Gate 2 request'), body.decision);
  }

  @Get('findings')
  async findings(@Headers() headers: RequestHeaders): Promise<unknown> {
    await this.actor(headers);
    return { items: await this.service.listFindings() };
  }

  @Get('findings/:id')
  async finding(@Headers() headers: RequestHeaders, @Param('id') id: string): Promise<unknown> {
    await this.actor(headers);
    return findingDto(await this.service.finding(uuid(id, 'finding')));
  }

  @Get('findings/:id/report')
  async report(
    @Headers() headers: RequestHeaders,
    @Param('id') id: string,
    @ZodQuery(ReportQueryDto) query: ReportQueryDto,
  ): Promise<unknown> {
    await this.actor(headers);
    const format: ReportFormat = query.format;
    return renderReport(await this.service.reportContext(uuid(id, 'finding')), format);
  }
}
