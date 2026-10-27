import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

import { ToolError } from '../errors.js';

/** The projectdiscovery binaries the recon wrappers drive (nmap is never used: NPSL, REFERENCES §5). */
export type ReconTool = 'dnsx' | 'naabu';

export interface ReconRunOptions {
  readonly stdin?: string;
  /** The session kill signal: aborting it kills the child and the call fails with `TOOL_KILLED`. */
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

/**
 * Runs one recon binary and returns its stdout. Adapters throw `ToolError` with a fixed message:
 * `TOOL_BUDGET_EXCEEDED` when the gateway answered with a budget signal (4xx), `TOOL_KILLED` on a kill,
 * `TOOL_BACKEND_UNAVAILABLE` for anything else. Raw child output never leaves the adapter.
 */
export interface ReconExecutor {
  run(tool: ReconTool, args: readonly string[], options: ReconRunOptions): Promise<string>;
}

export interface SpawnExecutorOptions {
  /** Command (and leading arguments) per tool; defaults to the bare binary name. */
  readonly commands?: Partial<Record<ReconTool, readonly [string, ...string[]]>>;
  /** Stdout cap in bytes; a tool that prints more is killed and fails. Default 16 MiB. */
  readonly maxOutputBytes?: number;
}

/** 16 MiB. */
const DEFAULT_MAX_OUTPUT_BYTES = 16_777_216;
/** The child gets a fixed environment: nothing from the agent runtime (tokens, keys) reaches it. */
const CHILD_PATH = '/usr/local/bin:/usr/bin:/bin';

/** Spawns the real binaries (no shell, fixed environment). The sandbox's resolver and egress path apply to them. */
export function createSpawnExecutor(options: SpawnExecutorOptions = {}): ReconExecutor {
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return {
    run: (tool, args, { stdin, signal, timeoutMs }) =>
      new Promise<string>((resolve, reject) => {
        const [command, ...lead] = options.commands?.[tool] ?? [tool];
        const failure = (message: string): ToolError =>
          signal.aborted
            ? new ToolError('TOOL_KILLED', 'the run was killed')
            : new ToolError('TOOL_BACKEND_UNAVAILABLE', message);
        const child = spawn(command, [...lead, ...args], {
          stdio: ['pipe', 'pipe', 'ignore'],
          env: { PATH: CHILD_PATH, HOME: tmpdir() },
          signal,
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
        });
        const chunks: Buffer[] = [];
        let size = 0;
        let overflow = false;
        child.stdout.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            overflow = true;
            child.kill('SIGKILL');
          } else chunks.push(chunk);
        });
        child.stdin.on('error', () => undefined);
        child.stdin.end(stdin);
        child.on('error', () => {
          reject(failure(`${tool} could not run`));
        });
        child.on('close', (code, killedBy) => {
          if (overflow) reject(failure(`${tool} produced too much output`));
          else if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
          else if (killedBy !== null) reject(failure(`${tool} timed out`));
          else reject(failure(`${tool} failed`));
        });
      }),
  };
}
