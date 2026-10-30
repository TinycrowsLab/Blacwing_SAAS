// Request DTOs of the service-account routes (RBAC-005). Each DTO is generated from its contracts schema.

import {
  serviceAccountCreateSchema,
  serviceAccountIdParamSchema,
  serviceAccountListQuerySchema,
  serviceAccountUpdateSchema,
} from '@blackwing/contracts';

import { createZodDto } from '../validation/zod-dto.js';

export class CreateServiceAccountDto extends createZodDto(serviceAccountCreateSchema) {}
export class UpdateServiceAccountDto extends createZodDto(serviceAccountUpdateSchema) {}
export class ServiceAccountListQueryDto extends createZodDto(serviceAccountListQuerySchema) {}
export class ServiceAccountIdParamDto extends createZodDto(serviceAccountIdParamSchema) {}
