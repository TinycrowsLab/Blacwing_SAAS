// Test fixture: creation routes behind @Idempotent(), with a counter standing in for "the side effect".

import {
  Body,
  type CanActivate,
  Controller,
  Header,
  type ExecutionContext,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import { ConflictError, InternalError, ValidationError } from '@blackwing/errors';

import { Idempotent } from './interceptor.js';
import { bindTenant } from '../bootstrap/request-context.js';

import type { FastifyRequest } from 'fastify';

/** Test stand-in for authentication: the tenant comes from `x-test-tenant` (never from a real client). */
@Injectable()
class TestTenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const tenant = request.headers['x-test-tenant'];
    if (typeof tenant === 'string') bindTenant(tenant);
    return true;
  }
}

export interface ThingBody {
  readonly name: string;
  readonly mode?: 'ok' | 'invalid' | 'boom' | 'boom-once' | 'slow' | 'big' | 'secret' | 'conflict';
  readonly delayMs?: number;
}

/** What the "creation" did, so tests can count side effects. */
export class ThingLog {
  created = 0;
  attempts = 0;
  readonly names: string[] = [];
}

const HTTP_ACCEPTED = 202;
/** Size of the `big` response blob; tests set a body cap below it. */
export const BIG_BLOB_LENGTH = 5000;

const THING_LOG = Symbol('thing-log');

@Controller('things')
@UseGuards(TestTenantGuard)
class ThingsController {
  constructor(@Inject(THING_LOG) private readonly log: ThingLog) {}

  @Post()
  @Idempotent()
  async create(@Body() body: ThingBody): Promise<Record<string, unknown>> {
    return this.run(body);
  }

  /** A route with a path parameter: the key is namespaced by the route template. */
  @Post(':id/exports')
  @Idempotent()
  async exportThing(
    @Param('id') id: string,
    @Body() body: ThingBody,
  ): Promise<Record<string, unknown>> {
    return { ...(await this.run(body)), thing: id };
  }

  @Post('accepted')
  @HttpCode(HTTP_ACCEPTED)
  @Idempotent()
  async accepted(@Body() body: ThingBody): Promise<Record<string, unknown>> {
    return this.run(body);
  }

  @Post('located')
  @Header('Location', '/v1/things/7')
  @Header('ETag', '"v1"')
  @Idempotent()
  async located(@Body() body: ThingBody): Promise<Record<string, unknown>> {
    return this.run(body);
  }

  /** Not idempotent: no header needed, nothing stored. */
  @Post('plain/create')
  plain(@Body() body: ThingBody): Record<string, unknown> {
    this.log.created += 1;
    return { id: this.log.created, name: body.name };
  }

  private async run(body: ThingBody): Promise<Record<string, unknown>> {
    this.log.attempts += 1;
    const mode = body.mode ?? 'ok';
    if (body.delayMs !== undefined) await new Promise((r) => setTimeout(r, body.delayMs));
    if (mode === 'invalid') throw new ValidationError('bad thing');
    if (mode === 'boom') throw new InternalError('boom');
    if (mode === 'boom-once' && this.log.attempts === 1) throw new InternalError('boom once');
    if (mode === 'conflict') {
      throw new ConflictError('name taken');
    }
    this.log.created += 1;
    this.log.names.push(body.name);
    const created = { id: this.log.created, name: body.name };
    if (mode === 'big') return { ...created, blob: 'x'.repeat(BIG_BLOB_LENGTH) };
    if (mode === 'secret')
      return { ...created, token: 'bwk_live_super-secret-value', nested: { apiKey: 'k-123' } };
    return created;
  }
}

/** A Nest module exposing {@link ThingsController} over the given log. */
export function thingsModule(log: ThingLog): new () => object {
  @Module({
    controllers: [ThingsController],
    providers: [{ provide: THING_LOG, useValue: log }],
  })
  class ThingsModule {}
  return ThingsModule;
}
