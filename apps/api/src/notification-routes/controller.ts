import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';

import { getTenantContextOrThrow } from '@blackwing/db/tenant-context';

import { NOTIFICATION_ROUTE_SERVICE } from './tokens.js';

import type { NotificationRouteService } from './service.js';
import type { NotificationRouteView } from '@blackwing/contracts';

/** The `201 Created` status of a new rule. */
const HTTP_CREATED = 201;

/**
 * `/v1/notification-routes` (NOTIFY-011). Thin: the tenant and the acting user come from the guard-resolved
 * context, never from the body, and the service does the authorisation, validation and write.
 */
@Controller('notification-routes')
export class NotificationRoutesController {
  constructor(
    @Inject(NOTIFICATION_ROUTE_SERVICE) private readonly service: NotificationRouteService,
  ) {}

  @Get()
  async list(): Promise<{ readonly items: readonly NotificationRouteView[] }> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return { items: await this.service.list({ tenantId, actorId: actor.id }) };
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<NotificationRouteView> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return this.service.get({ tenantId, actorId: actor.id }, id);
  }

  @Post()
  @HttpCode(HTTP_CREATED)
  async create(@Body() body: unknown): Promise<NotificationRouteView> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return this.service.create({ tenantId, actorId: actor.id }, body);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown): Promise<NotificationRouteView> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return this.service.update({ tenantId, actorId: actor.id }, id, body);
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<NotificationRouteView> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return this.service.remove({ tenantId, actorId: actor.id }, id);
  }
}
