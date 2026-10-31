import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const rulesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../rules/whitebox');

interface RuleFile {
  name: string;
  text: string;
  rules: {
    id: string;
    languages: string[];
    severity: string;
    message: string;
    metadata: { cwe: string; wstg: string; owasp: string };
    'pattern-either': unknown[];
  }[];
}

async function loadRuleFiles(): Promise<RuleFile[]> {
  const names = (await readdir(rulesDir)).filter((n) => n.endsWith('.yaml')).sort();
  return Promise.all(
    names.map(async (name) => {
      const text = await readFile(join(rulesDir, name), 'utf8');
      const doc = parse(text) as { rules: RuleFile['rules'] };
      return { name, text, rules: doc.rules };
    }),
  );
}

const files = await loadRuleFiles();
const allRules = files.flatMap((f) => f.rules);

describe('whitebox rule set', () => {
  it('covers the required sink classes, keyed by CWE', () => {
    const cwes = new Set(allRules.map((r) => r.metadata.cwe));
    expect(cwes).toEqual(
      new Set(['CWE-89', 'CWE-78', 'CWE-22', 'CWE-918', 'CWE-502', 'CWE-1336', 'CWE-611']),
    );
  });

  it('gives every rule a unique id, languages, a severity, a message and sink-shape patterns', () => {
    const ids = allRules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of allRules) {
      expect(rule.id).toMatch(/^bw-whitebox-cwe-\d+-[a-z0-9-]+$/);
      expect(rule.languages.length).toBeGreaterThan(0);
      expect(rule.severity).toBe('WARNING');
      expect(rule.message.length).toBeGreaterThan(10);
      expect(rule['pattern-either'].length).toBeGreaterThan(0);
    }
  });

  it('carries the CWE id, a WSTG category and an OWASP reference in metadata of every rule', () => {
    for (const rule of allRules) {
      expect(rule.metadata.cwe).toMatch(/^CWE-\d+$/);
      expect(rule.metadata.wstg).toMatch(/^WSTG-[A-Z]{4}-\d{2}$/);
      expect(rule.metadata.owasp).toMatch(/^A\d{2}:2021$/);
      expect(rule.id).toContain(`cwe-${rule.metadata.cwe.slice(4)}-`);
    }
  });

  it('keeps every file keyed to a single CWE (file name matches the class)', () => {
    for (const file of files) {
      const cwes = new Set(file.rules.map((r) => r.metadata.cwe));
      expect(cwes.size).toBe(1);
      const [cwe] = [...cwes];
      expect(file.name.startsWith(`cwe-${cwe?.slice(4) ?? ''}-`)).toBe(true);
    }
  });

  it('contains no Semgrep registry rule or registry reference (REFERENCES §5)', () => {
    for (const file of files) {
      expect(file.text).not.toMatch(/semgrep\.dev|returntocorp|r2c-|semgrep-rules|\/p\//i);
    }
  });

  it('describes sink shapes only, with no payload or exploit strings', () => {
    for (const file of files) {
      expect(file.text).not.toMatch(/OR 1=1|<script|\.\.\/\.\.\/|union select|;\s*rm\s|\$\(/i);
    }
  });
});
