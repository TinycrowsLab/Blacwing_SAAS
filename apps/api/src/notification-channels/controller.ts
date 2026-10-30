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
  Query,
} from '@nestjs/common';

import { getTenantContextOrThrow } from '@blackwing/db/tenant-context';

import { NOTIFICATION_CHANNEL_SERVICE } from './tokens.js';

import type { NotificationChannelService } from './service.js';
import type { NotificationChannelView } from '@blackwing/contracts';

/** The `201 Created` status of a new channel. */
const HTTP_CREATED = 201;

/**
 * `/v1/notification-channels` (NOTIFY-001). Thin: the tenant and the acting user come from the guard-resolved
 * context, never from the body, and the service does the authorisation, validation and write.
 */
@Controller('notification-channels')
export class NotificationChannelsController {
  constructor(
    @Inject(NOTIFICATION_CHANNEL_SERVICE) private readonly service: NotificationChannelService,
  ) {}

  @Get()
  async list(): Promise<{ readonly items: readonly NotificationChannelView[] }> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return { items: await this.service.list({ tenantId, actorId: actor.id }) };
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<NotificationChannelView> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return this.service.get({ tenantId, actorId: actor.id }, id);
  }

  @Post()
  @HttpCode(HTTP_CREATED)
  async create(@Body() body: unknown): Promise<NotificationChannelView> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return this.service.create({ tenantId, actorId: actor.id }, body);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown): Promise<NotificationChannelView> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return this.service.update({ tenantId, actorId: actor.id }, id, body);
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<NotificationChannelView> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return this.service.remove({ tenantId, actorId: actor.id }, id, query);
  }
}
