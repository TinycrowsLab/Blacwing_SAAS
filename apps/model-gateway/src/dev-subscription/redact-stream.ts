const REDACTED = Buffer.from('[REDACTED]', 'utf8');

function replaceAll(buffer: Buffer, needle: Buffer): Buffer {
  let index = buffer.indexOf(needle);
  if (index === -1) return buffer;
  const parts: Buffer[] = [];
  let from = 0;
  while (index !== -1) {
    parts.push(buffer.subarray(from, index), REDACTED);
    from = index + needle.length;
    index = buffer.indexOf(needle, from);
  }
  parts.push(buffer.subarray(from));
  return Buffer.concat(parts);
}

/** Length of the longest suffix of `buffer` that is a proper prefix of one of `needles`. */
function partialMatchLength(buffer: Buffer, needles: readonly Buffer[]): number {
  let longest = 0;
  for (const needle of needles) {
    const max = Math.min(needle.length - 1, buffer.length);
    for (let length = max; length > longest; length -= 1) {
      if (buffer.subarray(buffer.length - length).equals(needle.subarray(0, length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}

/**
 * Replaces every occurrence of a secret value in a byte stream with `[REDACTED]`, including occurrences
 * split across chunks. Only a tail that could be the start of a secret is held back, so streamed (SSE)
 * output otherwise passes through as it arrives.
 */
export async function* redactSecretsInStream(
  body: AsyncIterable<Uint8Array>,
  secrets: readonly string[],
): AsyncGenerator<Uint8Array> {
  const needles = secrets
    .filter((secret) => secret.length > 0)
    .map((secret) => Buffer.from(secret, 'utf8'));
  if (needles.length === 0) {
    yield* body;
    return;
  }
  let pending: Buffer = Buffer.alloc(0);
  for await (const chunk of body) {
    let buffer: Buffer = Buffer.concat([pending, chunk]);
    for (const needle of needles) buffer = replaceAll(buffer, needle);
    const hold = partialMatchLength(buffer, needles);
    pending = buffer.subarray(buffer.length - hold);
    const ready = buffer.subarray(0, buffer.length - hold);
    if (ready.length > 0) yield ready;
  }
  if (pending.length > 0) yield pending;
}
