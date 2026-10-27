import { ToolError } from './errors.js';

/** Where an oversized output goes. MCP-009 (`attach_evidence`) supplies the production sink. */
export interface EvidenceSink {
  /** Stores `content` as evidence and returns its id. */
  store(input: {
    readonly content: string;
    readonly contentType: string;
    readonly description: string;
  }): Promise<string>;
}

const EXCERPT_BYTES = 4096;
/** Head and tail together never take more than half the limit. */
const EXCERPT_LIMIT_DIVISOR = 4;
const EVIDENCE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const UTF8_CONTINUATION_MASK = 0b1100_0000;
const UTF8_CONTINUATION = 0b1000_0000;

const isContinuation = (byte: number | undefined): boolean =>
  byte !== undefined && (byte & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION;

/** The first `n` bytes of `buf`, cut back to a code point boundary. */
function head(buf: Buffer, n: number): string {
  let end = Math.min(n, buf.length);
  while (end > 0 && isContinuation(buf[end])) end -= 1;
  return buf.toString('utf8', 0, end);
}

/** The last `n` bytes of `buf`, cut forward to a code point boundary. */
function tail(buf: Buffer, n: number): string {
  let start = Math.max(0, buf.length - n);
  while (start < buf.length && isContinuation(buf[start])) start += 1;
  return buf.toString('utf8', start);
}

export interface LimitedOutput {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

/**
 * Keeps `text` inline when it fits in `maxBytes` (UTF-8). Otherwise the whole output is written to
 * evidence and replaced with a head/tail excerpt plus an `evidence://<id>` pointer. Excerpts never split a
 * code point. If the evidence cannot be stored the call fails (`TOOL_BACKEND_UNAVAILABLE`): output is
 * never dropped and never returned unbounded.
 */
export async function limitOutput(
  text: string,
  maxBytes: number,
  evidence: EvidenceSink,
  description: string,
): Promise<LimitedOutput> {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, bytes: buf.length, truncated: false };
  let id: string;
  try {
    id = await evidence.store({ content: text, contentType: 'application/json', description });
  } catch {
    throw new ToolError(
      'TOOL_BACKEND_UNAVAILABLE',
      'oversized output could not be stored as evidence',
    );
  }
  if (typeof id !== 'string' || !EVIDENCE_ID.test(id)) {
    throw new ToolError('TOOL_BACKEND_UNAVAILABLE', 'evidence store returned an invalid id');
  }
  const excerpt = Math.min(EXCERPT_BYTES, Math.floor(maxBytes / EXCERPT_LIMIT_DIVISOR));
  const limited = JSON.stringify({
    ok: true,
    truncated: true,
    evidence: `evidence://${id}`,
    totalBytes: buf.length,
    head: head(buf, excerpt),
    tail: tail(buf, excerpt),
  });
  return { text: limited, bytes: buf.length, truncated: true };
}
