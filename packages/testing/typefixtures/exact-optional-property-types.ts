// exactOptionalPropertyTypes: an optional property may be absent, but not explicitly `undefined`.

interface ScanOptions {
  readonly label?: string;
}

// @ts-expect-error TS2375 exactOptionalPropertyTypes: `undefined` is not assignable to an optional `string`
export const explicitUndefined: ScanOptions = { label: undefined };

export function withLabel(label: string | undefined): ScanOptions {
  // @ts-expect-error TS2375 exactOptionalPropertyTypes: a possibly-undefined value must be omitted, not assigned
  const options: ScanOptions = { label };
  return options;
}

export function withLabelCorrect(label: string | undefined): ScanOptions {
  return label === undefined ? {} : { label };
}
