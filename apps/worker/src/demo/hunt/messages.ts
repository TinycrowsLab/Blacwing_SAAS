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
  private readonly lanes = new Map<string, { turns: number; tokens: number }>();
  private totalCostUsd = 0;

  constructor(private readonly log: EventLog) {}

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

  /** A delegation's tool_result is the subagent's report back to the lane that delegated. */
  private async handleReplies(content: unknown): Promise<void> {
    if (!Array.isArray(content)) return;
    for (const raw of content) {
      const block = toolResultSchema.safeParse(raw);
      if (!block.success) continue;
      const subagent = this.laneByToolUse.get(block.data.tool_use_id);
      if (subagent === undefined) continue;
      const to = this.parentByToolUse.get(block.data.tool_use_id) ?? ORCHESTRATOR;
      await this.log.emit('agent.reply', subagent, `${subagent} reports back to ${to}`, {
        agent: subagent,
        to,
        toolUseId: block.data.tool_use_id,
        text: resultText(block.data.content).slice(0, REPLY_MAX_CHARS),
        isError: block.data.is_error === true,
      });
    }
  }

  async handle(message: SDKMessage): Promise<void> {
    if (message.type === 'user') {
      await this.handleReplies(message.message.content);
      return;
    }
    if (message.type !== 'assistant') return;
    const agent = this.laneOf(message.parent_tool_use_id);
    for (const block of message.message.content) {
      if (block.type === 'text' && block.text.trim() !== '') {
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
