// Turns the Agent SDK message stream into run events, attributing every message to the agent lane that produced it.
import { z } from 'zod';

import type { EventLog } from './context.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const ORCHESTRATOR = 'orchestrator';
const HTTP_TOOL = 'mcp__blackwing__http_request';
const MCP_PREFIX = 'mcp__blackwing__';
const inputRecord = z.record(z.string(), z.unknown()).catch({});
const MESSAGE_PREVIEW_CHARS = 200;
/** Cost share is rounded to this many decimal places. */
const COST_DECIMALS = 1e4;

export class MessageRouter {
  /** `Agent` tool_use id -> subagent name; subagent messages carry that id as parent_tool_use_id. */
  private readonly laneByToolUse = new Map<string, string>();
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

  async handle(message: SDKMessage): Promise<void> {
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
          const description = typeof record.description === 'string' ? record.description : '';
          await this.log.emit('agent.tool', agent, `${agent} delegates to ${subagent}: ${description}`, { agent, tool: 'Agent', input: { subagent, description } });
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
