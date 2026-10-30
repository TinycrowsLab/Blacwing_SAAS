import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Res } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { z } from 'zod';

import { getTenantContextOrThrow } from '@blackwing/db/tenant-context';

import { ONCALL_MEMBERSHIPS, ONCALL_SERVICE } from './tokens.js';
import { computeEtag } from '../concurrency/etag.js';
import { requireIfMatch } from '../concurrency/if-match.js';

import type { OncallMemberships, OncallPrincipal } from './ports.js';
import type { OncallService } from './service.js';
import type { OncallRoster } from '@blackwing/contracts';
import type { FastifyReply } from 'fastify';

const HTTP_OK = 200;
const HTTP_CREATED = 201;

/** Actor ids that can hold memberships are UUIDs; anything else holds no roles (fail closed). */
const userIdSchema = z.uuid();

/** Sends the ETag and `no-store` with the roster: rosters are per-tenant and must not be cached. */
function answer(reply: FastifyReply, status: number, roster: OncallRoster): OncallRoster {
  void reply.status(status).header('ETag', computeEtag(roster)).header('cache-control', 'no-store');
  return roster;
}

/** The trace the audit event is correlated with, when the request runs under a span. */
function traceIdOrNull(): string | null {
  return trace.getActiveSpan()?.spanContext().traceId ?? null;
}

/**
 * The caller of this request: the tenant and actor from the guard-resolved context (never the body),
 * with the roles held in that tenant. The service makes the authorisation decision.
 */
async function principalOf(memberships: OncallMemberships): Promise<OncallPrincipal> {
  const { tenantId, actor } = getTenantContextOrThrow();
  const isUser = actor.type === 'user';
  const roles =
    isUser && userIdSchema.safeParse(actor.id).success
      ? await memberships.rolesOf(tenantId, actor.id)
      : [];
  return { type: isUser ? 'user' : 'service', id: actor.id, tenantId, roles };
}

/**
 * `GET|POST /v1/oncall/rosters` and `GET|PATCH /v1/oncall/rosters/:id` (GATE2-003). Thin: the principal
 * comes from the tenant context, the service authorises (Org Admin for writes), validates and writes.
 * Failures are RFC 9457 problem+json through the global filter.
 */
@Controller('oncall/rosters')
export class OncallController {
  constructor(
    @Inject(ONCALL_SERVICE) private readonly service: OncallService,
    @Inject(ONCALL_MEMBERSHIPS) private readonly memberships: OncallMemberships,
  ) {}

  @Get()
  async list(@Res({ passthrough: true }) reply: FastifyReply): Promise<{
    items: readonly OncallRoster[];
    nextCursor: null;
  }> {
    const items = await this.service.listRosters(await principalOf(this.memberships));
    void reply.header('cache-control', 'no-store');
    return { items, nextCursor: null };
  }

  @Post()
  async create(
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<OncallRoster> {
    const roster = await this.service.createRoster(
      await principalOf(this.memberships),
      body,
      traceIdOrNull(),
    );
    void reply.header('location', `/v1/oncall/rosters/${roster.id}`);
    return answer(reply, HTTP_CREATED, roster);
  }

  @Get(':id')
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<OncallRoster> {
    const roster = await this.service.getRoster(await principalOf(this.memberships), id);
    return answer(reply, HTTP_OK, roster);
  }

  /**
   * Requires `If-Match` (428 without it, 412 for a stale ETag). The store's compare-and-set on
   * `state_version` is the final word on concurrent edits.
   */
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<OncallRoster> {
    const principal = await principalOf(this.memberships);
    const current = await this.service.getRoster(principal, id);
    const precondition = requireIfMatch(computeEtag(current), ifMatch);
    const updated = await this.service.updateRoster(
      principal,
      current.id,
      body,
      precondition.expectedVersion ?? current.stateVersion,
      traceIdOrNull(),
    );
    return answer(reply, HTTP_OK, updated);
  }
}
