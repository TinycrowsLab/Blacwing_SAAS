// HTTP surface of service accounts (RBAC-005): `POST|GET /v1/service-accounts`,
// `GET|PATCH|DELETE /v1/service-accounts/{id}`. Thin handlers: resolve the tenant from the ambient
// context (never from the body), hand to the service, answer with an ETag (the state version).
// `PATCH` and `DELETE` require `If-Match` (428 when missing, 412 when stale).

import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Patch,
  Post,
  Headers,
  Res,
} from '@nestjs/common';

import { getTenantContextOrThrow } from '@blackwing/db/tenant-context';
import { ForbiddenError, PreconditionRequiredError, ValidationError } from '@blackwing/errors';

import {
  CreateServiceAccountDto,
  ServiceAccountIdParamDto,
  ServiceAccountListQueryDto,
  UpdateServiceAccountDto,
} from './dto.js';
import { SERVICE_ACCOUNT_SERVICE } from './tokens.js';
import { ZodBody, ZodParam, ZodQuery } from '../validation/zod-validation.pipe.js';

import type { ServiceAccountCaller, ServiceAccountService } from './service.js';
import type { AuditActor, ServiceAccount } from '@blackwing/contracts';
import type { FastifyReply } from 'fastify';

const HTTP_CREATED = 201;
const MAX_VERSION = 2_147_483_647;
const IF_MATCH_PATTERN = /^"?(\d{1,10})"?$/;

/** The `If-Match` ETag of a version: `"<stateVersion>"`. Missing is 428; a malformed value is 422. */
function parseIfMatch(header: string | string[] | undefined): number {
  if (header === undefined || (Array.isArray(header) && header.length === 0)) {
    throw new PreconditionRequiredError('If-Match is required', {
      detail: 'Send the ETag of the service account in an If-Match header.',
    });
  }
  const value = Array.isArray(header) ? header[0] : header;
  const match = IF_MATCH_PATTERN.exec(value ?? '');
  const version = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isInteger(version) || version < 0 || version > MAX_VERSION) {
    throw new ValidationError('If-Match is not a valid version', {
      detail: 'If-Match must be the quoted state version of the resource.',
    });
  }
  return version;
}

/** Everything the service needs from the request: the ambient tenant and the acting identity. */
function callerOf(traceId: string | undefined): ServiceAccountCaller {
  const context = getTenantContextOrThrow();
  if (context.actor.type === 'run') {
    throw new ForbiddenError('run identities cannot manage service accounts');
  }
  const actor: AuditActor = { type: context.actor.type, id: context.actor.id };
  return { tenantId: context.tenantId, actor, ...(traceId === undefined ? {} : { traceId }) };
}

function setEtag(reply: FastifyReply, account: ServiceAccount): void {
  reply.header('etag', `"${account.stateVersion}"`);
  reply.header('cache-control', 'no-store');
}

@Controller('service-accounts')
export class ServiceAccountsController {
  constructor(@Inject(SERVICE_ACCOUNT_SERVICE) private readonly service: ServiceAccountService) {}

  @Post()
  @HttpCode(HTTP_CREATED)
  async create(
    @ZodBody(CreateServiceAccountDto) body: CreateServiceAccountDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ServiceAccount> {
    const account = await this.service.create(callerOf(undefined), body);
    setEtag(reply, account);
    return account;
  }

  @Get()
  async list(
    @ZodQuery(ServiceAccountListQueryDto) query: ServiceAccountListQueryDto,
  ): Promise<{ items: readonly ServiceAccount[]; nextCursor: string | null }> {
    return this.service.list(callerOf(undefined), {
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
  }

  @Get(':id')
  async get(
    @ZodParam(ServiceAccountIdParamDto) params: ServiceAccountIdParamDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ServiceAccount> {
    const account = await this.service.get(callerOf(undefined), params.id);
    setEtag(reply, account);
    return account;
  }

  @Patch(':id')
  async update(
    @ZodParam(ServiceAccountIdParamDto) params: ServiceAccountIdParamDto,
    @ZodBody(UpdateServiceAccountDto) body: UpdateServiceAccountDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ServiceAccount> {
    const expectedVersion = parseIfMatch(ifMatch);
    const account = await this.service.update(
      callerOf(undefined),
      params.id,
      expectedVersion,
      body,
    );
    setEtag(reply, account);
    return account;
  }

  @Delete(':id')
  async disable(
    @ZodParam(ServiceAccountIdParamDto) params: ServiceAccountIdParamDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ServiceAccount> {
    const expectedVersion = parseIfMatch(ifMatch);
    const account = await this.service.disable(callerOf(undefined), params.id, expectedVersion);
    setEtag(reply, account);
    return account;
  }
}
