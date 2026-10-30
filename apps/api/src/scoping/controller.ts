import { Controller, Delete, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import { z } from 'zod';

import {
  createInputManifestUploadSchema,
  type InputManifestSpecObject,
  type InputManifestUploadGrant,
  type InputManifestUploadRemoved,
} from '@blackwing/contracts';
import { NotFoundError } from '@blackwing/errors';

import { INPUT_MANIFEST_UPLOAD_SERVICE } from './tokens.js';
import { principalOfRequest } from '../assets/principal.js';
import { createZodDto, ZodBody } from '../validation/index.js';

import type { InputManifestUploadService } from './service.js';
import type { FastifyReply } from 'fastify';

class CreateInputManifestUploadDto extends createZodDto(createInputManifestUploadSchema) {}

const HTTP_OK = 200;

/** A path id is a uuid; anything else is a 404 before the service, the same as an id of another tenant. */
function uuidParam(value: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new NotFoundError('input manifest not found');
  return parsed.data;
}

/**
 * Input-manifest upload routes (SCOPE-006): `POST /v1/input-manifests/:id/uploads` grants a presigned POST,
 * `POST …/uploads/:uploadId/complete` registers the uploaded object, and `DELETE …/uploads/:uploadId` removes it
 * while it is pending scan. The tenant and the actor come from the guard-resolved context, never from the body.
 */
@Controller('input-manifests')
export class InputManifestUploadController {
  constructor(
    @Inject(INPUT_MANIFEST_UPLOAD_SERVICE)
    private readonly service: InputManifestUploadService<unknown>,
  ) {}

  @Post(':id/uploads')
  async requestUpload(
    @Param('id') id: string,
    @ZodBody(CreateInputManifestUploadDto) body: CreateInputManifestUploadDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<InputManifestUploadGrant> {
    const principal = principalOfRequest();
    const { grant } = await this.service.requestUpload(principal, uuidParam(id), body);
    void reply.header('cache-control', 'no-store');
    return grant;
  }

  /** Idempotent: a replay of a completed upload answers the same object. */
  @Post(':id/uploads/:uploadId/complete')
  @HttpCode(HTTP_OK)
  async completeUpload(
    @Param('id') id: string,
    @Param('uploadId') uploadId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<InputManifestSpecObject> {
    const principal = principalOfRequest();
    const { object } = await this.service.completeUpload(
      principal,
      uuidParam(id),
      uuidParam(uploadId),
    );
    void reply.header('cache-control', 'no-store');
    return object;
  }

  @Delete(':id/uploads/:uploadId')
  @HttpCode(HTTP_OK)
  async deleteUpload(
    @Param('id') id: string,
    @Param('uploadId') uploadId: string,
  ): Promise<InputManifestUploadRemoved> {
    const principal = principalOfRequest();
    const removedId = uuidParam(uploadId);
    await this.service.deleteUpload(principal, uuidParam(id), removedId);
    return { uploadId: removedId, status: 'removed' };
  }
}
