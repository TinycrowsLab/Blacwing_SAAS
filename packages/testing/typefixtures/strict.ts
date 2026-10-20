// strict: the whole strict family must stay on (no member flag may be switched back off).

// @ts-expect-error TS7006 noImplicitAny: parameters need a type
export function implicitAny(value) {
  return value;
}

// @ts-expect-error TS2322 strictNullChecks: null is not a string
export const notNull: string = null;

export class Unset {
  // @ts-expect-error TS2564 strictPropertyInitialization: property is never initialised
  name: string;
}

export function unknownCatch(): string {
  try {
    return "ok";
  } catch (error) {
    // @ts-expect-error TS18046 useUnknownInCatchVariables: catch variables are `unknown`
    return error.message;
  }
}

export function implicitThis(): number {
  // @ts-expect-error TS2683 noImplicitThis: `this` has no annotated type here
  return this.length;
}

type Handler = (value: string | number) => void;
const stringOnly = (value: string): void => {
  void value;
};
// @ts-expect-error TS2322 strictFunctionTypes: parameter types are checked contravariantly
export const handler: Handler = stringOnly;

function add(left: number, right: number): number {
  return left + right;
}
// @ts-expect-error TS2345 strictBindCallApply: call arguments are type-checked
export const sum = add.call(undefined, 1, "2");
