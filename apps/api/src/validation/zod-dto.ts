import type { z } from 'zod';

/**
 * A DTO class generated from a `@blackwing/contracts` Zod schema. `schema` is the single source of
 * truth for validation and, later, the OpenAPI document (API-003).
 */
export interface ZodDto<S extends z.ZodType = z.ZodType> {
  new (): z.output<S>;
  readonly isZodDto: true;
  readonly schema: S;
}

/**
 * `class CreateRunDto extends createZodDto(createRunSchema) {}`: the DTO convention for
 * `apps/api/src/**\/dto`. The schema must come from `@blackwing/contracts`, never be written inline.
 */
export function createZodDto<S extends z.ZodType>(schema: S): ZodDto<S> {
  // A plain function is a valid base class; it carries the schema as static metadata.
  return Object.assign(
    function AugmentedZodDto(): void {
      // Intentionally empty: instances carry no state, only the static schema does.
    },
    {
      isZodDto: true as const,
      schema,
    },
  ) as unknown as ZodDto<S>;
}

export function isZodDto(value: unknown): value is ZodDto {
  return (
    typeof value === 'function' &&
    (value as { isZodDto?: unknown }).isZodDto === true &&
    typeof (value as { schema?: { safeParse?: unknown } }).schema?.safeParse === 'function'
  );
}
