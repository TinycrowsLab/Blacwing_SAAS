/** Read-only transcript-summary tool that the advisory personas read (`mcp__<server>__<tool>`). */
export const TRANSCRIPT_SUMMARY_READ_TOOL = 'mcp__blackwing_transcript__transcript_summary_read';

/**
 * Tools the advisory personas (`mentor`, `reflector`) may never use: shell, networked built-ins, native
 * subagents, file writes, target tools and engagement or findings mutation. Advice never touches a target
 * or changes engagement state (CONTEXT_PACK §4.6, §8.11).
 */
export const ADVISORY_DISALLOWED_TOOLS = [
  'Bash',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Write',
  'Edit',
  'mcp__blackwing__http_request',
  'mcp__blackwing__tcp_probe',
  'mcp__blackwing_target__http_request',
  'mcp__blackwing_target__http_batch',
  'mcp__blackwing_target__tcp_probe',
  'mcp__blackwing_oob__oob_allocate',
  'mcp__blackwing_findings__submit_candidate',
  'mcp__blackwing_engagement__dispatch_subtask',
  'mcp__blackwing_engagement__mark_test_case_status',
  'mcp__blackwing_engagement__request_scope_exception',
];
