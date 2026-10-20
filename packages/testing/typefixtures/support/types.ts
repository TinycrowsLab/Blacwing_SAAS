// Type-only exports shared by the module-syntax fixtures. Nothing here should fail to compile.

export interface Shape {
  readonly kind: 'circle' | 'square';
  readonly size: number;
}

export type ShapeKind = Shape['kind'];

export const DEFAULT_SIZE = 1;
