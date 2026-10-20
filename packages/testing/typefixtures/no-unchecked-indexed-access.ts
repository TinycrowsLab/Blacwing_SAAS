// noUncheckedIndexedAccess: index signatures and array elements include `undefined`.

const hosts: string[] = ['a.example', 'b.example'];
const ports: Record<string, number> = { http: 80 };

export function firstHostLength(): number {
  // @ts-expect-error TS2532 noUncheckedIndexedAccess: an array element may be undefined
  return hosts[0].length;
}

// @ts-expect-error TS2322 noUncheckedIndexedAccess: a record lookup is `number | undefined`
export const httpsPort: number = ports['https'];

export function safeFirstHostLength(): number {
  const first = hosts[0];
  return first === undefined ? 0 : first.length;
}
