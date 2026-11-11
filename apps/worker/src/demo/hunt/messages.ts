// Turns the Agent SDK message stream into run events, attributing every message to the agent lane that produced it.
import { z } from 'zod';

import type { EventLog } from './context.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const ORCHESTRATOR = 'orchestrator';
const HTTP_TOOL = 'mcp__blackwing__http_request';
const MCP_PREFIX = 'mcp__blackwing__';
const inputRecord = z.record(z.string(), z.unknown()).catch({});
const MESSAGE_PREVIEW_CHARS = 200;
/** The delegation instruction and the subagent's report are shown in the console's conversation; both are clamped. */
const PROMPT_MAX_CHARS = 2000;
const REPLY_MAX_CHARS = 4000;

/** A tool_result block in a user message (the SDK types it as an Anthropic MessageParam; parsed, not trusted). */
const toolResultSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
  content: z
    .union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }).loose())])
    .optional(),
});

/** The structured result of a tool call: an Agent call launched in the background reports `async_launched`. */
const toolUseResultSchema = z.object({ status: z.string() }).loose();
const BACKGROUND_LAUNCH = /^(async|remote)_launched$/;

function resultText(content: z.infer<typeof toolResultSchema>['content']): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content.map((part) => part.text ?? '').filter((t) => t !== '').join('\n');
}
/** Cost share is rounded to this many decimal places. */
const COST_DECIMALS = 1e4;

export class MessageRouter {
  /** `Agent` tool_use id -> subagent name; subagent messages carry that id as parent_tool_use_id. */
  private readonly laneByToolUse = new Map<string, string>();
  /** `Agent` tool_use id -> the lane that delegated (the reply goes back to it). */
  private readonly parentByToolUse = new Map<string, string>();
  /** The latest text of each lane: a background subagent's report is its last message when its task completes. */
  private readonly lastTextByLane = new Map<string, string>();
  private readonly replied = new Set<string>();
  private readonly lanes = new Map<string, { turns: number; tokens: number }>();
  private totalCostUsd = 0;

  /** The model that last answered, so `run.model` is emitted at the start and again if a fallback takes over. */
  private modelUsed: string | null = null;

  constructor(
    private readonly log: EventLog,
    private readonly effort: string | null = null,
  ) {}

  /** Records the model that actually served the session (it differs from the configured one after a fallback). */
  private async noteModel(model: string | undefined): Promise<void> {
    if (model === undefined || model === '' || model === this.modelUsed) return;
    const from = this.modelUsed;
    this.modelUsed = model;
    await this.log.emit('run.model', 'plan', from === null ? `Model in use: ${model}` : `Model switched from ${from} to ${model}`, { model, effort: this.effort, ...(from === null ? {} : { from }) });
  }

  get totalCost(): number {
    return this.totalCostUsd;
  }

  setTotalCost(costUsd: number): void {
    this.totalCostUsd = costUsd;
  }

  private laneOf(parentToolUseId: string | null): string {
    return (parentToolUseId === null ? undefined : this.laneByToolUse.get(parentToolUseId)) ?? ORCHESTRATOR;
  }

  /** Cost is only known for the whole run, so each agent gets its token share of it. */
  private costShare(agent: string): number {
    let all = 0;
    for (const lane of this.lanes.values()) all += lane.tokens;
    const own = this.lanes.get(agent)?.tokens ?? 0;
    return all === 0 ? 0 : Math.round((this.totalCostUsd * own * COST_DECIMALS) / all) / COST_DECIMALS;
  }

  private async reply(toolUseId: string, text: string, isError: boolean, status: string): Promise<void> {
    const subagent = this.laneByToolUse.get(toolUseId);
    if (subagent === undefined || this.replied.has(toolUseId)) return;
    this.replied.add(toolUseId);
    const to = this.parentByToolUse.get(toolUseId) ?? ORCHESTRATOR;
    await this.log.emit('agent.reply', subagent, `${subagent} reports back to ${to}`, {
      agent: subagent,
      to,
      toolUseId,
      text: text.slice(0, REPLY_MAX_CHARS),
      isError,
      status,
    });
  }

  /**
   * A delegation's tool_result is the subagent's report back to the lane that delegated, unless the SDK ran the
   * subagent in the background: then the tool_result is only a launch receipt and the report arrives with the task's
   * `task_notification` (see handle).
   */
  private async handleReplies(content: unknown, toolUseResult: unknown): Promise<void> {
    if (!Array.isArray(content)) return;
    const structured = toolUseResultSchema.safeParse(toolUseResult);
    if (structured.success && BACKGROUND_LAUNCH.test(structured.data.status)) return;
    for (const raw of content) {
      const block = toolResultSchema.safeParse(raw);
      if (!block.success) continue;
      const isError = block.data.is_error === true;
      await this.reply(block.data.tool_use_id, resultText(block.data.content), isError, isError ? 'failed' : 'completed');
    }
  }

  async handle(message: SDKMessage): Promise<void> {
    if (message.type === 'system' && message.subtype === 'init') await this.noteModel(message.model);
    if (message.type === 'user') {
      await this.handleReplies(message.message.content, message.tool_use_result);
      return;
    }
    if (message.type === 'system' && message.subtype === 'task_notification') {
      const id = message.tool_use_id;
      const lane = id === undefined ? undefined : this.laneByToolUse.get(id);
      if (id !== undefined && lane !== undefined) {
        // The subagent's own last words are its report; the SDK's summary stands in when it wrote none.
        await this.reply(id, this.lastTextByLane.get(lane) ?? message.summary, message.status !== 'completed', message.status);
      }
      return;
    }
    if (message.type !== 'assistant') return;
    const agent = this.laneOf(message.parent_tool_use_id);
    if (message.parent_tool_use_id === null) await this.noteModel(message.message.model);
    for (const block of message.message.content) {
      if (block.type === 'text' && block.text.trim() !== '') {
        this.lastTextByLane.set(agent, block.text);
        await this.log.emit('agent.message', agent, `${agent}: ${block.text.slice(0, MESSAGE_PREVIEW_CHARS)}`, { agent, text: block.text });
      } else if (block.type === 'tool_use' && block.name !== HTTP_TOOL) {
        const record = inputRecord.parse(block.input);
        if (block.name === 'Agent' || block.name === 'Task') {
          const subagent = typeof record.subagent_type === 'string' ? record.subagent_type : 'general-purpose';
          this.laneByToolUse.set(block.id, subagent);
          this.parentByToolUse.set(block.id, agent);
          const description = typeof record.description === 'string' ? record.description : '';
          const prompt = typeof record.prompt === 'string' ? record.prompt.slice(0, PROMPT_MAX_CHARS) : '';
          await this.log.emit('agent.tool', agent, `${agent} delegates to ${subagent}: ${description}`, {
            agent,
            tool: 'Agent',
            toolUseId: block.id,
            input: { subagent, description, prompt },
          });
        } else {
          const tool = block.name.startsWith(MCP_PREFIX) ? block.name.slice(MCP_PREFIX.length) : block.name;
          await this.log.emit('agent.tool', agent, `${agent} uses ${tool}`, { agent, tool, input: record });
        }
      }
    }
    const lane = this.lanes.get(agent) ?? { turns: 0, tokens: 0 };
    lane.turns += 1;
    lane.tokens += message.message.usage.input_tokens + message.message.usage.output_tokens;
    this.lanes.set(agent, lane);
    await this.log.emit('agent.turn', agent, `${agent} turn ${lane.turns}`, { agent, turns: lane.turns, costUsd: this.costShare(agent) });
  }
}
