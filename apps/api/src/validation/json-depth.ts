/**
 * True when `value` nests objects/arrays deeper than `maxDepth` (the root container is depth 1).
 * Iterative, so a hostile payload cannot overflow the call stack; stops at the first excess level.
 */
export function exceedsJsonDepth(value: unknown, maxDepth: number): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const stack: { readonly node: object; readonly depth: number }[] = [{ node: value, depth: 1 }];
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    if (frame.depth > maxDepth) return true;
    for (const child of Object.values(frame.node as Record<string, unknown>)) {
      if (typeof child === 'object' && child !== null) {
        stack.push({ node: child, depth: frame.depth + 1 });
      }
    }
  }
  return false;
}
