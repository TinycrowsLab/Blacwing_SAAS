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

import { BUDGET_LIMITS, type DemoConfig } from './config.js';
import { DemoRefusalFilter } from './filter.js';
import {
  REPORT_FORMATS,
  RUN_REPORT_FORMATS,
  renderReport,
  renderRunReport,
  type ReportFormat,
} from './report.js';
import {
  ALL_ROLES,
  DemoRefusal,
  INTRUSIVENESS,
  RELEASE_MODES,
  type DemoActor,
  type DemoService,
} from './service.js';
import { DEMO_CONFIG, DEMO_SERVICE, DEMO_STORE } from './tokens.js';
import { PublicRoute } from '../tenant/public-route.js';
import { createZodDto, ZodBody, ZodQuery } from '../validation/index.js';

import type { DemoStore } from './store.js';

const LIMITS = {
  name: 120,
  url: 2048,
  path: 512,
  listItems: 50,
  objective: 2000,
  reason: 500,
  statement: 1000,
  workspaceNameMin: 2,
  workspaceNameMax: 60,
  statementMin: 10,
  testAccounts: 3,
  roleName: 32,
  headerName: 64,
  headerValue: 4096,
  reasonMin: 8,
} as const;

const SECONDS_PER_MINUTE = 60;

/** Headers the runner must control itself; a test account cannot set them. */
const RESERVED_HEADERS = ['host', 'content-length', 'connection', 'transfer-encoding'];

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

const testAccountSchema = z.strictObject({
  role: z.string().trim().regex(/^[a-z][a-z0-9_-]{0,31}$/i),
  headerName: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,64}$/)
    .refine((name) => !RESERVED_HEADERS.includes(name.toLowerCase()), 'This header cannot carry a credential.'),
  headerValue: z.string().min(1).max(LIMITS.headerValue),
});

const createRequestSchema = z.strictObject({
  assetId: z.string().regex(UUID),
  objective: z.string().trim().min(1).max(LIMITS.objective),
  intrusiveness: z.enum(INTRUSIVENESS),
  budgetRequests: z.int().min(BUDGET_LIMITS.requests.min).max(BUDGET_LIMITS.requests.max),
  budgetSeconds: z
    .int()
    .min(BUDGET_LIMITS.minutes.min * SECONDS_PER_MINUTE)
    .max(BUDGET_LIMITS.minutes.max * SECONDS_PER_MINUTE),
  costCapUsd: z.number().min(BUDGET_LIMITS.costUsd.min).max(BUDGET_LIMITS.costUsd.max),
  excludedPaths,
  /** Gate 3: `hold` keeps proven findings for a human release; `auto` releases them as the validator proves them. */
  releaseProven: z.enum(RELEASE_MODES).default('hold'),
  testAccounts: z
    .array(testAccountSchema)
    .max(LIMITS.testAccounts)
    .default([])
    .refine((accounts) => new Set(accounts.map((a) => a.role.toLowerCase())).size === accounts.length, {
      message: 'Test account roles must be unique.',
    }),
});

export const workspaceSchema = z.strictObject({
  name: z.string().trim().min(LIMITS.workspaceNameMin).max(LIMITS.workspaceNameMax),
});

const decisionSchema = z.strictObject({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().max(LIMITS.reason).nullable().default(null),
});

const killSchema = z.strictObject({ scope: z.literal('run'), confirm: z.string().max(LIMITS.name) });
export const gate2DecisionSchema = z
  .strictObject({
    decision: z.enum(['approve', 'deny']),
    reason: z.string().trim().max(LIMITS.reason).optional(),
  })
  .refine((v) => v.decision === 'deny' || (v.reason ?? '').length >= LIMITS.reasonMin, {
    path: ['reason'],
    message: 'Approve needs a reason of at least 8 characters.',
  });
const triageSchema = z.strictObject({
  decision: z.enum(['release', 'dismiss']),
  reason: z.string().trim().min(LIMITS.reasonMin).max(LIMITS.reason),
});

const afterSeqQuerySchema = z.object({ afterSeq: z.coerce.number().int().min(0).default(0) });
const reportQuerySchema = z.object({ format: z.enum(REPORT_FORMATS).default('html') });
const runReportQuerySchema = z.object({ format: z.enum(RUN_REPORT_FORMATS).default('html') });

class CreateAssetDto extends createZodDto(createAssetSchema) {}
class VerifyAssetDto extends createZodDto(verifyAssetSchema) {}
class CreateRequestDto extends createZodDto(createRequestSchema) {}
class DecisionDto extends createZodDto(decisionSchema) {}
class WorkspaceDto extends createZodDto(workspaceSchema) {}
class KillDto extends createZodDto(killSchema) {}
class Gate2DecisionDto extends createZodDto(gate2DecisionSchema) {}
class AfterSeqQueryDto extends createZodDto(afterSeqQuerySchema) {}
class TriageDto extends createZodDto(triageSchema) {}
class ReportQueryDto extends createZodDto(reportQuerySchema) {}
class RunReportQueryDto extends createZodDto(runReportQuerySchema) {}

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

  /** Resolves the acting user from the internal hop: token, then the e-mail Google verified for the web session. */
  private async actor(headers: RequestHeaders): Promise<DemoActor> {
    const token = headers['x-bw-demo-token'];
    if (!tokenMatches(typeof token === 'string' ? token : undefined, this.config.internalToken)) {
      throw new DemoRefusal(
        HttpStatus.UNAUTHORIZED,
        'demo_token_invalid',
        'The internal token is missing or wrong.',
      );
    }
    const email = headers['x-bw-demo-user'];
    if (typeof email !== 'string' || email === '') {
      throw new DemoRefusal(
        HttpStatus.UNAUTHORIZED,
        'demo_user_missing',
        'No user was presented.',
      );
    }
    const rolesHeader = headers['x-bw-demo-roles'];
    const roles =
      typeof rolesHeader === 'string' && rolesHeader !== '' ? rolesHeader.split(',') : [];
    const admin = this.config.adminEmails.includes(email.toLowerCase());
    let user = await this.store.findActiveUserByEmail(email);
    // An administrator's first sign-in creates the directory user and the tenant membership (every role). The web
    // admits only administrators, and every other unknown user is refused here.
    const sub = headers['x-bw-demo-sub'];
    if (user === null && admin && typeof sub === 'string' && sub !== '') {
      user = await this.store.provisionUser(this.config.tenantId, {
        sub,
        email,
        name: typeof headers['x-bw-demo-name'] === 'string' ? headers['x-bw-demo-name'] : null,
        roles: ALL_ROLES,
      });
    }
    if (user === null)
      throw new DemoRefusal(
        HttpStatus.UNAUTHORIZED,
        'demo_user_unknown',
        'The user is not active in the tenant.',
      );
    if (admin) {
      return { id: user.id, email: user.email, name: user.name, roles: [...ALL_ROLES], admin: true };
    }
    return { id: user.id, email: user.email, name: user.name, roles };
  }

  @Get('workspace')
  async workspace(@Headers() headers: RequestHeaders): Promise<unknown> {
    return this.service.workspace(await this.actor(headers));
  }

  @Post('workspace')
  @HttpCode(HttpStatus.OK)
  async renameWorkspace(
    @Headers() headers: RequestHeaders,
    @ZodBody(WorkspaceDto) body: WorkspaceDto,
  ): Promise<unknown> {
    return this.service.renameWorkspace(await this.actor(headers), body.name);
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
    return this.service.request(uuid(id, 'request'), actor);
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

  /** Retest: a new pending request with the same answers. Test-account secrets are copied here, never sent to the browser. */
  @Post('requests/:id/clone')
  async cloneRequest(@Headers() headers: RequestHeaders, @Param('id') id: string): Promise<unknown> {
    return this.service.cloneRequest(await this.actor(headers), uuid(id, 'request'));
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
    return this.service.run(await this.actor(headers), uuid(id, 'run'), query.afterSeq);
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
    return this.service.decideGate2(
      await this.actor(headers),
      uuid(id, 'Gate 2 request'),
      body.decision,
      body.reason === undefined || body.reason === '' ? null : body.reason,
    );
  }

  @Get('findings')
  async findings(@Headers() headers: RequestHeaders): Promise<unknown> {
    return { items: await this.service.listFindings(await this.actor(headers)) };
  }

  @Get('findings/:id')
  async finding(@Headers() headers: RequestHeaders, @Param('id') id: string): Promise<unknown> {
    return this.service.findingDetail(await this.actor(headers), uuid(id, 'finding'));
  }

  @Post('findings/:id/triage')
  @HttpCode(HttpStatus.OK)
  async triage(
    @Headers() headers: RequestHeaders,
    @Param('id') id: string,
    @ZodBody(TriageDto) body: TriageDto,
  ): Promise<unknown> {
    return this.service.triage(await this.actor(headers), uuid(id, 'finding'), body.decision, body.reason);
  }

  @Get('findings/:id/report')
  async report(
    @Headers() headers: RequestHeaders,
    @Param('id') id: string,
    @ZodQuery(ReportQueryDto) query: ReportQueryDto,
  ): Promise<unknown> {
    const actor = await this.actor(headers);
    const format: ReportFormat = query.format;
    return renderReport(await this.service.reportContext(actor, uuid(id, 'finding')), format);
  }

  @Get('runs/:id/report')
  async runReport(
    @Headers() headers: RequestHeaders,
    @Param('id') id: string,
    @ZodQuery(RunReportQueryDto) query: RunReportQueryDto,
  ): Promise<unknown> {
    await this.actor(headers);
    return renderRunReport(await this.service.runReportContext(uuid(id, 'run')), query.format);
  }

  @Get('audit')
  async audit(@Headers() headers: RequestHeaders): Promise<unknown> {
    await this.actor(headers);
    return this.service.auditLedger();
  }
}
