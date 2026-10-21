// Test fixture: a versioned "widgets" resource wired through the ETag/If-Match helpers.

import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Module,
  Param,
  Patch,
} from '@nestjs/common';

import { NotFoundError } from '@blackwing/errors';

import { assertRowUpdated, computeEtag, requireIfMatch, UseEtag } from './index.js';

export interface Widget {
  readonly id: string;
  readonly name: string;
  readonly state_version: number;
}

/** The persistence the controller needs; the version check lives in the repository's write. */
export interface WidgetRepo {
  get(id: string): Promise<Widget | null>;
  /** `UPDATE ... WHERE id = $1 AND state_version = $expected`, bumping the version; null on 0 rows. */
  updateName(id: string, expectedVersion: number, name: string): Promise<Widget | null>;
  delete(id: string, expectedVersion: number): Promise<boolean>;
}

export const WIDGET_REPO = Symbol('widget-repo');

/** In-memory repository whose conditional write is atomic, like a single SQL statement. */
export class MemoryWidgetRepo implements WidgetRepo {
  readonly rows = new Map<string, Widget>();
  /** Awaited between nothing and everything, so concurrent requests interleave read and write. */
  constructor(private readonly readDelayMs = 0) {}

  async get(id: string): Promise<Widget | null> {
    const row = this.rows.get(id) ?? null;
    if (this.readDelayMs > 0) await new Promise((r) => setTimeout(r, this.readDelayMs));
    return row;
  }

  updateName(id: string, expectedVersion: number, name: string): Promise<Widget | null> {
    const row = this.rows.get(id);
    if (row?.state_version !== expectedVersion) return Promise.resolve(null);
    const next = { ...row, name, state_version: row.state_version + 1 };
    this.rows.set(id, next);
    return Promise.resolve(next);
  }

  delete(id: string, expectedVersion: number): Promise<boolean> {
    const row = this.rows.get(id);
    if (row?.state_version !== expectedVersion) return Promise.resolve(false);
    this.rows.delete(id);
    return Promise.resolve(true);
  }
}

@Controller('widgets')
@UseEtag()
export class WidgetsController {
  constructor(@Inject(WIDGET_REPO) private readonly repo: WidgetRepo) {}

  @Get(':id')
  async get(@Param('id') id: string): Promise<Widget> {
    const row = await this.repo.get(id);
    if (row === null) throw new NotFoundError();
    return row;
  }

  @Patch(':id')
  async patch(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: { name: string },
  ): Promise<Widget> {
    const current = await this.repo.get(id);
    const { expectedVersion } = requireIfMatch(
      current === null ? null : computeEtag(current),
      ifMatch,
    );
    // `If-Match: *` carries no version: fall back to the version just read; the WHERE still decides.
    const expected = expectedVersion ?? current?.state_version ?? -1;
    const updated = await this.repo.updateName(id, expected, body.name);
    assertRowUpdated(updated === null ? 0 : 1);
    return updated ?? { id, name: body.name, state_version: expected + 1 };
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<void> {
    const current = await this.repo.get(id);
    const { expectedVersion } = requireIfMatch(
      current === null ? null : computeEtag(current),
      ifMatch,
    );
    assertRowUpdated(
      (await this.repo.delete(id, expectedVersion ?? current?.state_version ?? -1)) ? 1 : 0,
    );
  }
}

/** A Nest module exposing {@link WidgetsController} over the given repository. */
export function widgetsModule(repo: WidgetRepo): new () => object {
  @Module({
    controllers: [WidgetsController],
    providers: [{ provide: WIDGET_REPO, useValue: repo }],
  })
  class WidgetsModule {}
  return WidgetsModule;
}
