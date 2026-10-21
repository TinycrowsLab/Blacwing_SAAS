// The canonical repository example (DB-007). A domain epic copies this file: define the Zod schemas
// of its writes, pick the entity name, and extend with its own queries via `run` if needed.

import { z } from 'zod';

import { BaseRepository, type RepositoryConfig } from '../repository.js';
import { widgets } from './widget.table.js';

const MAX_NAME_LENGTH = 120;

/** `create` input: `tenantId` is not accepted (it always comes from the ambient tenant). */
const widgetCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
  quantity: z.number().int().min(0).default(0),
  parentId: z.uuid().nullish(),
});
export type WidgetCreate = z.input<typeof widgetCreateSchema>;

/** `update` patch: id, tenant, version and deletion state are not writable. */
const widgetUpdateSchema = z.strictObject({
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH).optional(),
  quantity: z.number().int().min(0).optional(),
});
export type WidgetUpdate = z.input<typeof widgetUpdateSchema>;

export type WidgetRepositoryOptions = Omit<
  RepositoryConfig<typeof widgets, WidgetCreate, WidgetUpdate>,
  'entity' | 'table' | 'createSchema' | 'updateSchema'
>;

export class WidgetRepository extends BaseRepository<typeof widgets, WidgetCreate, WidgetUpdate> {
  constructor(options: WidgetRepositoryOptions) {
    super({
      ...options,
      entity: 'widget',
      table: widgets,
      createSchema: widgetCreateSchema,
      updateSchema: widgetUpdateSchema,
    });
  }
}
