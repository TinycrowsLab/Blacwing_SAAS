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
  Patch,
  Post,
  UseFilters,
} from '@nestjs/common';
import { z } from 'zod';

import { BUDGET_LIMITS, OBJECTIVE_MAX, type DemoConfig } from './config.js';
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
  EMERGENCY_VALIDITIES,
  INTRUSIVENESS,
  RELEASE_MODES,
  type DemoActor,
  type DemoService,
} from './service.js';
import { DEMO_CONFIG, DEMO_SERVICE, DEMO_STORE } from './tokens.js';
import { RateLimit } from '../rate-limit/policy.js';
import { PublicRoute } from '../tenant/public-route.js';
import { createZodDto, ZodBody, ZodQuery } from '../validation/index.js';

import type { DemoStore } from './store.js';

const LIMITS = {
  name: 120,
  url: 2048,
  path: 512,
  listItems: 50,
  objective: OBJECTIVE_MAX,
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
  batchIds: 200,
  emergencyLabel: 80,
  emergencyToken: 128,
  clientKey: 64,
} as const;

const SECONDS_PER_MINUTE = 60;

/** Headers the runner must control itself; a test account cannot set them. */
const RESERVED_HEADERS = ['host', 'content-length', 'connection', 'transfer-encoding'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const webUrl = z.url({ protocol: /^https?$/ }).max(LIMITS.url);
const pathList = z.array(z.string().min(1).max(LIMITS.path).startsWith('/')).max(LIMITS.listItems);
const excludedPaths = pathList.default([]);

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

const uniqueRoles = (accounts: readonly { role: string }[]): boolean =>
  new Set(accounts.map((a) => a.role.toLowerCase())).size === accounts.length;

/** The plan fields with the same limits for a new request and for an edit. */
const planFields = {
  objective: z.string().trim().min(1).max(LIMITS.objective),
  intrusiveness: z.enum(INTRUSIVENESS),
  budgetRequests: z.int().min(BUDGET_LIMITS.requests.min).max(BUDGET_LIMITS.requests.max),
  budgetSeconds: z
    .int()
    .min(BUDGET_LIMITS.minutes.min * SECONDS_PER_MINUTE)
    .max(BUDGET_LIMITS.minutes.max * SECONDS_PER_MINUTE),
  costCapUsd: z.number().min(BUDGET_LIMITS.costUsd.min).max(BUDGET_LIMITS.costUsd.max),
  /** Gate 3: `hold` keeps proven findings for a human release; `auto` releases them as the validator proves them. */
  releaseProven: z.enum(RELEASE_MODES),
};

const createRequestSchema = z.strictObject({
  assetId: z.string().regex(UUID),
  ...planFields,
  excludedPaths,
  releaseProven: planFields.releaseProven.default('hold'),
  testAccounts: z
    .array(testAccountSchema)
    .max(LIMITS.testAccounts)
    .default([])
    .refine(uniqueRoles, { message: 'Test account roles must be unique.' }),
});

/** PATCH /requests/:id: the version the editor saw, plus at least one plan field. */
export const amendRequestSchema = z
  .strictObject({
    version: z.int().min(1),
    objective: planFields.objective.optional(),
    intrusiveness: planFields.intrusiveness.optional(),
    budgetRequests: planFields.budgetRequests.optional(),
    budgetSeconds: planFields.budgetSeconds.optional(),
    costCapUsd: planFields.costCapUsd.optional(),
    excludedPaths: pathList.optional(),
    releaseProven: planFields.releaseProven.optional(),
    /** Omitted = unchanged; an account without `headerValue` keeps the value stored for that role. */
    testAccounts: z
      .array(testAccountSchema.extend({ headerValue: testAccountSchema.shape.headerValue.optional() }))
      .max(LIMITS.testAccounts)
      .refine(uniqueRoles, { message: 'Test account roles must be unique.' })
      .optional(),
  })
  .refine((body) => Object.keys(body).some((key) => key !== 'version'), {
    message: 'Change at least one plan field.',
  });

export const workspaceSchema = z.strictObject({
  name: z.string().trim().min(LIMITS.workspaceNameMin).max(LIMITS.workspaceNameMax),
});

const decisionSchema = z.strictObject({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().max(LIMITS.reason).nullable().default(null),
  /** The plan version the approver saw: a newer plan is refused (`plan_changed`). */
  version: z.int().min(1).optional(),
});

/** Optional body: an empty request keeps the plain clone. */
const cloneSchema = z.preprocess(
  (body) => body ?? {},
  z.strictObject({ untriedFromRunId: z.string().regex(UUID).optional() }),
);

const killSchema = z.strictObject({ scope: z.literal('run'), confirm: z.string().max(LIMITS.name) });
/** A blast radius wider than one run: every run on a target, or every run in the workspace. */
export const killScopeSchema = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('target'), assetId: z.string().regex(UUID), confirm: z.string().max(LIMITS.name) }),
  z.strictObject({ scope: z.literal('workspace'), confirm: z.string().max(LIMITS.name) }),
]);
export const emergencyLinkSchema = z.strictObject({
  validity: z.enum(EMERGENCY_VALIDITIES),
  /** Who the link is for (e.g. "SOC on-call"); empty means none. */
  label: z.string().trim().max(LIMITS.emergencyLabel).optional(),
});
export const emergencyContactSchema = z.strictObject({
  contact: z
    .strictObject({
      name: z.string().trim().min(1).max(LIMITS.emergencyLabel),
      phone: z.string().trim().regex(/^\+?[0-9][0-9 ()./-]{2,38}$/, 'Use digits, spaces and + ( ) - . only.'),
    })
    .nullable(),
});
/** The no-login page's calls: the token travels in the body, never in a URL the API could log. */
const emergencyTokenSchema = z.strictObject({ token: z.string().max(LIMITS.emergencyToken) });
const emergencyRunsSchema = emergencyTokenSchema.extend({
  runIds: z.array(z.string().regex(UUID)).max(LIMITS.batchIds),
});
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
export const triageManySchema = triageSchema.extend({
  ids: z
    .array(z.string().regex(UUID))
    .min(1)
    .max(LIMITS.batchIds)
    .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, {
      message: 'Each finding may be listed once.',
    }),
});

const afterSeqQuerySchema = z.object({ afterSeq: z.coerce.number().int().min(0).default(0) });
const reportQuerySchema = z.object({ format: z.enum(REPORT_FORMATS).default('html') });
const runReportQuerySchema = z.object({ format: z.enum(RUN_REPORT_FORMATS).default('html') });

class CreateAssetDto extends createZodDto(createAssetSchema) {}
class VerifyAssetDto extends createZodDto(verifyAssetSchema) {}
class CreateRequestDto extends createZodDto(createRequestSchema) {}
class DecisionDto extends createZodDto(decisionSchema) {}
class AmendRequestDto extends createZodDto(amendRequestSchema) {}
class CloneDto extends createZodDto(cloneSchema) {}
class TriageManyDto extends createZodDto(triageManySchema) {}
class WorkspaceDto extends createZodDto(workspaceSchema) {}
class KillDto extends createZodDto(killSchema) {}
/** A union has no class form: the DTO is the schema holder itself. */
const KillScopeDto = createZodDto(killScopeSchema);
class EmergencyLinkDto extends createZodDto(emergencyLinkSchema) {}
class EmergencyContactDto extends createZodDto(emergencyContactSchema) {}
class EmergencyTokenDto extends createZodDto(emergencyTokenSchema) {}
class EmergencyRunsDto extends createZodDto(emergencyRunsSchema) {}
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
@RateLimit({ rps: 20, burst: 60 })
@UseFilters(DemoRefusalFilter)
@Controller('demo')
export class DemoController {
  constructor(
    @Inject(DEMO_CONFIG) private readonly config: DemoConfig,
    @Inject(DEMO_STORE) private readonly store: DemoStore,
    @Inject(DEMO_SERVICE) private readonly service: DemoService,
  ) {}

  /** The internal hop only (the web server's token), with no signed-in user: the emergency page's calls. */
  private internal(headers: RequestHeaders): void {
    const token = headers['x-bw-demo-token'];
    if (!tokenMatches(typeof token === 'string' ? token : undefined, this.config.internalToken)) {
      throw new DemoRefusal(
        HttpStatus.UNAUTHORIZED,
        'demo_token_invalid',
        'The internal token is missing or wrong.',
      );
    }
  }

  /** The visitor's address as the web server saw it: the emergency page's rate-limit key. */
  private clientKey(headers: RequestHeaders): string {
    const ip = headers['x-bw-client-ip'];
    return typeof ip === 'string' && ip !== '' ? ip.slice(0, LIMITS.clientKey) : 'unknown';
  }

  /** Resolves the acting user from the internal hop: token, then the e-mail Google verified for the web session. */
  private async actor(headers: RequestHeaders): Promise<DemoActor> {
    this.internal(headers);
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

  @Post('workspace/emergency-contact')
  @HttpCode(HttpStatus.OK)
  async setEmergencyContact(
    @Headers() headers: RequestHeaders,
    @ZodBody(EmergencyContactDto) body: EmergencyContactDto,
  ): Promise<unknown> {
    return this.service.setEmergencyContact(await this.actor(headers), body.contact);
  }

  @Get('emergency-links')
  async emergencyLinks(@Headers() headers: RequestHeaders): Promise<unknown> {
    return this.service.emergencyLinks(await this.actor(headers));
  }

  @Post('emergency-links')
  async createEmergencyLink(
    @Headers() headers: RequestHeaders,
    @ZodBody(EmergencyLinkDto) body: EmergencyLinkDto,
  ): Promise<unknown> {
    const label = body.label === undefined || body.label === '' ? null : body.label;
    return this.service.createEmergencyLink(await this.actor(headers), body.validity, label);
  }

  @Post('emergency-links/:id/revoke')
  @HttpCode(HttpStatus.OK)
  async revokeEmergencyLink(@Headers() headers: RequestHeaders, @Param('id') id: string): Promise<unknown> {
    return this.service.revokeEmergencyLink(await this.actor(headers), uuid(id, 'emergency link'));
  }

  /** The no-login emergency page: internal token only, the link's token in the body. */
  @Post('emergency/view')
  @HttpCode(HttpStatus.OK)
  async emergencyView(
    @Headers() headers: RequestHeaders,
    @ZodBody(EmergencyTokenDto) body: EmergencyTokenDto,
  ): Promise<unknown> {
    this.internal(headers);
    return this.service.emergencyView(body.token, this.clientKey(headers));
  }

  @Post('emergency/stop')
  @HttpCode(HttpStatus.OK)
  async emergencyStop(
    @Headers() headers: RequestHeaders,
    @ZodBody(EmergencyTokenDto) body: EmergencyTokenDto,
  ): Promise<unknown> {
    this.internal(headers);
    return this.service.emergencyStop(body.token, this.clientKey(headers));
  }

  @Post('emergency/runs')
  @HttpCode(HttpStatus.OK)
  async emergencyRuns(
    @Headers() headers: RequestHeaders,
    @ZodBody(EmergencyRunsDto) body: EmergencyRunsDto,
  ): Promise<unknown> {
    this.internal(headers);
    return this.service.emergencyRuns(body.token, this.clientKey(headers), body.runIds);
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
    return this.service.decideGate1(actor, uuid(id, 'request'), body.decision, body.reason, body.version ?? null);
  }

  /** Edits a pending plan in place. Test-account values the browser does not resend are kept server-side. */
  @Patch('requests/:id')
  @HttpCode(HttpStatus.OK)
  async amendRequest(
    @Headers() headers: RequestHeaders,
    @Param('id') id: string,
    @ZodBody(AmendRequestDto) body: AmendRequestDto,
  ): Promise<unknown> {
    return this.service.amendRequest(await this.actor(headers), uuid(id, 'request'), body);
  }

  /**
   * Retest: a new pending request with the same answers (optionally plus the test cases a run left untried).
   * Test-account secrets are copied here, never sent to the browser.
   */
  @Post('requests/:id/clone')
  async cloneRequest(
    @Headers() headers: RequestHeaders,
    @Param('id') id: string,
    @ZodBody(CloneDto) body: CloneDto,
  ): Promise<unknown> {
    const runId = body.untriedFromRunId;
    return this.service.cloneRequest(
      await this.actor(headers),
      uuid(id, 'request'),
      runId === undefined ? undefined : uuid(runId, 'run'),
    );
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

  @Post('kill')
  @HttpCode(HttpStatus.OK)
  async killScope(@Headers() headers: RequestHeaders, @ZodBody(KillScopeDto) body: z.infer<typeof killScopeSchema>): Promise<unknown> {
    return this.service.killScope(await this.actor(headers), body);
  }

  @Get('gate2/:id')
  async gate2(@Headers() headers: RequestHeaders, @Param('id') id: string): Promise<unknown> {
    return this.service.gate2(uuid(id, 'Gate 2 request'), await this.actor(headers));
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

  /** Batch Gate 3: one call for "Release all" / "Dismiss all". */
  @Post('findings/triage')
  @HttpCode(HttpStatus.OK)
  async triageMany(
    @Headers() headers: RequestHeaders,
    @ZodBody(TriageManyDto) body: TriageManyDto,
  ): Promise<unknown> {
    return this.service.triageMany(await this.actor(headers), body.ids, body.decision, body.reason);
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

  /** Retest: the runner replays the proven probe and its control once more (state-changing probes excluded). */
  @Post('findings/:id/replay')
  @HttpCode(HttpStatus.ACCEPTED)
  async replay(@Headers() headers: RequestHeaders, @Param('id') id: string): Promise<unknown> {
    return this.service.requestRetest(await this.actor(headers), uuid(id, 'finding'));
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
