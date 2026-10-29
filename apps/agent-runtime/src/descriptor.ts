import {
  AGENT_BRIEF_MAX_BYTES,
  agentSessionDescriptorSchema,
  type AgentSessionDescriptor,
} from '@blackwing/contracts';
import { AppError } from '@blackwing/errors';

const KIB = 1024;
const MIB = KIB * KIB;
/** Largest descriptor file the runtime reads. A brief over the limit is refused with its own code first. */
const DESCRIPTOR_FILE_MAX_MIB = 4;
export const DESCRIPTOR_FILE_MAX_BYTES = DESCRIPTOR_FILE_MAX_MIB * MIB;

/** Generic, value-free message of a descriptor that failed validation. */
const DESCRIPTOR_INVALID_MESSAGE = 'session descriptor failed validation';

/**
 * Parses and validates the serialised `SessionDescriptor` before any session starts (RUNTIME-001, #463).
 *
 * Fails closed with an `AppError`: `AGENT_BRIEF_TOO_LARGE` for a brief over 256 KiB (checked first, on the
 * UTF-8 byte size), and `VALIDATION_FAILED` for malformed JSON or a descriptor the schema rejects. The
 * error detail names the offending field paths only, never a value, so no token or brief text reaches logs.
 */
export function parseSessionDescriptor(raw: string): AgentSessionDescriptor {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new AppError('VALIDATION_FAILED', DESCRIPTOR_INVALID_MESSAGE, {
      detail: 'descriptor is not valid JSON',
    });
  }
  if (typeof json === 'object' && json !== null && 'brief' in json) {
    const brief = json.brief;
    if (typeof brief === 'string' && Buffer.byteLength(brief, 'utf8') > AGENT_BRIEF_MAX_BYTES) {
      throw new AppError('AGENT_BRIEF_TOO_LARGE', 'agent brief exceeds 256 KiB');
    }
  }
  const parsed = agentSessionDescriptorSchema.safeParse(json);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)');
    throw new AppError('VALIDATION_FAILED', DESCRIPTOR_INVALID_MESSAGE, {
      detail: `invalid fields: ${[...new Set(paths)].join(', ')}`,
    });
  }
  return parsed.data;
}
