import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

import { ToolError } from '../errors.js';

/** The projectdiscovery binaries the recon wrappers drive (nmap is never used: NPSL, REFERENCES §5). */
export type ReconTool = 'dnsx' | 'httpx' | 'naabu';
/** The tools that scan or resolve through the scope envelope (`httpx` probes are recorded by `probeHttp`). */
export type ScanTool = Exclude<ReconTool, 'httpx'>;
/** The protocol/product fingerprinter the infrastructure enumeration drives (INFRASPEC-003, MIT). */
export type FingerprintTool = 'fingerprintx';
/** Every binary the executor may run. */
export type ExecTool = ReconTool | FingerprintTool;

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
  run(tool: ExecTool, args: readonly string[], options: ReconRunOptions): Promise<string>;
}

export interface SpawnExecutorOptions {
  /** Command (and leading arguments) per tool; defaults to the bare binary name. */
  readonly commands?: Partial<Record<ExecTool, readonly [string, ...string[]]>>;
  /** Stdout cap in bytes; a tool that prints more is killed and fails. Default 16 MiB. */
  readonly maxOutputBytes?: number;
  /** Extra environment for every child (proxy variables for egress forcing). Nothing else is inherited. */
  readonly env?: Readonly<Record<string, string>>;
}

/** 16 MiB. */
const DEFAULT_MAX_OUTPUT_BYTES = 16_777_216;
/** The child gets a fixed environment: nothing from the agent runtime (tokens, keys) reaches it. */
const CHILD_PATH = '/usr/local/bin:/usr/bin:/bin';

/** Spawns the real binaries (no shell, fixed environment). The sandbox's resolver and egress path apply to them. */
export function createSpawnExecutor(options: SpawnExecutorOptions = {}): ReconExecutor {
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return {
    run: (tool: ExecTool, args, { stdin, signal, timeoutMs }) =>
      new Promise<string>((resolve, reject) => {
        const [command, ...lead] = options.commands?.[tool] ?? [tool];
        const failure = (message: string): ToolError =>
          signal.aborted
            ? new ToolError('TOOL_KILLED', 'the run was killed')
            : new ToolError('TOOL_BACKEND_UNAVAILABLE', message);
        const child = spawn(command, [...lead, ...args], {
          stdio: ['pipe', 'pipe', 'ignore'],
          env: { ...options.env, PATH: CHILD_PATH, HOME: tmpdir() },
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

/** The proxychains-ng configuration the sandbox image ships for forcing proxy-unaware tools through the gateway. */
export const PROXYCHAINS_CONFIG = '/etc/proxychains/blackwing.conf';

/**
 * Egress forcing for the recon binaries (§8.2): every child gets the gateway as its HTTP(S)/ALL proxy, and the
 * tools that ignore proxy variables (`naabu`, `dnsx`) run under `proxychains-ng`, which uses the gateway's
 * SOCKS5 listener (fingerprintx connects raw TCP, so it is forced the same way). A child that still reaches out
 * directly is stopped by the host firewall and NetworkPolicy.
 */
export function egressSpawnOptions(proxyUrl: string): SpawnExecutorOptions {
  const forced = ['proxychains4', '-q', '-f', PROXYCHAINS_CONFIG] as const;
  return {
    env: {
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      ALL_PROXY: proxyUrl,
    },
    commands: {
      dnsx: [...forced, 'dnsx'] as const,
      naabu: [...forced, 'naabu'] as const,
      fingerprintx: [...forced, 'fingerprintx'] as const,
    },
  };
}
