/**
 * Target extraction for the PreToolUse PDP call (RUNTIME-005, #467; CONTEXT_PACK §4.3, §8.2).
 *
 * The hook names the network targets a call reaches, so the broker can check each against scope. Only the origin
 * and path of a URL are kept, so a query string or credentials never leave the sandbox. A call that may reach the
 * network but names no parseable target is unresolved, and the hook denies it (fail closed). The model's own
 * claim about scope is never used: the broker decides from the targets alone.
 */

import { PDP_TARGETS_MAX } from '@blackwing/contracts';

/** Command names that can open a network connection. A call that runs one must name a resolvable target. */
const NETWORK_COMMANDS: ReadonlySet<string> = new Set([
  'curl',
  'wget',
  'nc',
  'ncat',
  'netcat',
  'nmap',
  'telnet',
  'ssh',
  'scp',
  'sftp',
  'ftp',
  'ping',
  'dig',
  'nslookup',
  'host',
  'socat',
  'openssl',
  'python',
  'python3',
  'node',
  'ruby',
  'perl',
  'php',
  'masscan',
  'httpx',
  'nuclei',
  'ffuf',
  'sqlmap',
  'subfinder',
  'naabu',
  'dnsx',
  'katana',
  'gobuster',
]);

/** A URL with a scheme, as written in a command or a tool input. */
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>`|;&()]+/gi;
/** A dotted IPv4 literal. The PDP's scope matcher decides whether it is in scope. */
const IPV4_PATTERN = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
/** A bare hostname: at least one dot, labels of letters, digits and hyphens. */
const HOSTNAME_PATTERN = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;
/** Separators between shell words. */
const WORD_SEPARATORS = /[\s;|&()`'"<>=]+/;

/** Tool input fields that name a network target for an MCP tool call. */
const TARGET_FIELDS: readonly string[] = ['url', 'host', 'hostname', 'target', 'address', 'ip'];

export type ExtractedTargets =
  | { readonly kind: 'targets'; readonly targets: readonly string[] }
  | { readonly kind: 'unresolved' };

/** The origin and path of a URL candidate, or `null` when it does not parse. Query and credentials are dropped. */
function redactedUrl(candidate: string): string | null {
  try {
    const url = new URL(candidate);
    if (url.hostname === '') return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

/** The network-looking words of a shell command, as written. */
function shellWords(command: string): readonly string[] {
  return command.split(WORD_SEPARATORS).filter((word) => word !== '');
}

/** The targets a shell command names. A network command with no resolvable target is `unresolved`. */
function commandTargets(command: string): ExtractedTargets {
  const found = new Set<string>();
  for (const match of command.match(URL_PATTERN) ?? []) {
    const url = redactedUrl(match);
    if (url === null) return { kind: 'unresolved' };
    found.add(url);
  }
  for (const ip of command.match(IPV4_PATTERN) ?? []) found.add(ip);

  const words = shellWords(command);
  const runsNetworkTool = words.some((word) =>
    NETWORK_COMMANDS.has(word.slice(word.lastIndexOf('/') + 1)),
  );
  if (runsNetworkTool) {
    for (const word of words) {
      if (!word.startsWith('-') && HOSTNAME_PATTERN.test(word)) found.add(word.toLowerCase());
    }
    if (found.size === 0) return { kind: 'unresolved' };
  }
  return { kind: 'targets', targets: [...found] };
}

/** The targets an MCP tool call names in its target fields. A field that is not a string names nothing. */
function mcpTargets(input: Readonly<Record<string, unknown>>): ExtractedTargets {
  const found = new Set<string>();
  for (const field of TARGET_FIELDS) {
    const value = input[field];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const url = redactedUrl(value.trim());
    found.add(url ?? value.trim().toLowerCase());
  }
  return { kind: 'targets', targets: [...found] };
}

/**
 * The targets of one call. A Bash command is read for URLs, IP literals and, when it runs a network tool, hostname
 * words. An MCP call is read from its target fields. More targets than the PDP accepts is `unresolved`, so a call
 * is never checked against a partial list.
 */
export function extractTargets(toolName: string, input: unknown): ExtractedTargets {
  let extracted: ExtractedTargets;
  if (toolName === 'Bash') {
    const command =
      typeof input === 'object' && input !== null && 'command' in input ? input.command : undefined;
    if (typeof command !== 'string') return { kind: 'unresolved' };
    extracted = commandTargets(command);
  } else if (typeof input === 'object' && input !== null) {
    extracted = mcpTargets(input as Readonly<Record<string, unknown>>);
  } else {
    extracted = { kind: 'targets', targets: [] };
  }
  if (extracted.kind === 'targets' && extracted.targets.length > PDP_TARGETS_MAX) {
    return { kind: 'unresolved' };
  }
  return extracted;
}
