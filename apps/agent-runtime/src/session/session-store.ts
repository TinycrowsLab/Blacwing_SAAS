import { InMemorySessionStore, type SessionStore } from '@anthropic-ai/claude-agent-sdk';

/**
 * The transcript mirror a resumed session loads from (GATE2-007, #208; REFERENCES §3.5).
 *
 * OFFLINE-STUB(online-porting #907): the offline build keeps the mirror in this process's memory, so a deferred session
 * resumes only inside the process that first ran it. The durable Postgres or S3 store that survives pod loss is ported
 * in #907. Until then, a resume after the process is gone reports `session_expired`, which is a deny, never a guess.
 */
export function createSessionStore(): SessionStore {
  return new InMemorySessionStore();
}
