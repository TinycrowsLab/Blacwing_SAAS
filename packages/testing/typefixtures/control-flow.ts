// noImplicitOverride, noImplicitReturns, noFallthroughCasesInSwitch, allowUnreachableCode=false,
// allowUnusedLabels=false.

class Base {
  describe(): string {
    return "base";
  }
}

export class Derived extends Base {
  // @ts-expect-error TS4114 noImplicitOverride: overriding members must say `override`
  describe(): string {
    return "derived";
  }
}

export class DerivedCorrect extends Base {
  override describe(): string {
    return "derived";
  }
}

// @ts-expect-error TS7030 noImplicitReturns: not every code path returns a value
export function maybeReturns(flag: boolean): string | undefined {
  if (flag) {
    return "yes";
  }
}

export function fallsThrough(code: number): string {
  let result = "";
  switch (code) {
    // @ts-expect-error TS7029 noFallthroughCasesInSwitch: a non-empty case must not fall through
    case 1:
      result += "one";
    case 2:
      result += "two";
      break;
    default:
      result = "other";
  }
  return result;
}

export function unreachable(): number {
  return 1;
  // @ts-expect-error TS7027 allowUnreachableCode: code after `return` is an error, not a warning
  console.log("never");
}

export function unusedLabel(): number {
  // @ts-expect-error TS7028 allowUnusedLabels: an unused label is an error
  outer: for (let i = 0; i < 1; i += 1) {
    return i;
  }
  return -1;
}
