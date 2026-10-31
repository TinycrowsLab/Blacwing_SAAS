import { mkdtemp, readFile, rm, stat, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConflictError,
  InternalError,
  KillSwitchActiveError,
  ValidationError,
  type AppError,
} from '@blackwing/errors';

import {
  ASSET_ID,
  CANDIDATE_ID,
  createScaffoldFixture,
  OTHER_CANDIDATE_ID,
  sha256Hex,
  SESSION_ID,
  validManifest,
  type ScaffoldFixture,
} from './fixtures.test-helpers.js';
import { HARNESS_RUNNER_SOURCE } from './runner-source.js';
import { scaffoldHarness } from './scaffold.js';
import { verifyScaffold } from './verify.js';

let base: string;
let fixture: ScaffoldFixture;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'bw-harness-'));
  fixture = await createScaffoldFixture(join(base, 'workspace', SESSION_ID), join(base, 'source'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const harnessRoot = (candidateId = CANDIDATE_ID): string =>
  join(fixture.workspaceDir, 'harness', candidateId);

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

describe('scaffoldHarness (EXPLOIT-002)', () => {
  it('writes manifest.json, the index, one step file per step, the inputs and the runner', async () => {
    const layout = await scaffoldHarness(validManifest(), fixture.deps);

    expect(layout.root).toBe(harnessRoot());
    expect([...layout.files].sort()).toEqual(
      [
        'harness.json',
        'inputs/0.bin',
        'manifest.json',
        'runner',
        'steps/negative_control/000-fetch-order-benign.json',
        'steps/positive/000-fetch-order.json',
        'steps/positive/001-await-callback.json',
      ].sort(),
    );
    for (const file of layout.files) {
      expect(await exists(join(layout.root, file)), file).toBe(true);
    }
  });

  it('writes a canonical manifest and an index that lists the steps in order', async () => {
    const layout = await scaffoldHarness(validManifest(), fixture.deps);

    const manifest = JSON.parse(await readFile(join(layout.root, 'manifest.json'), 'utf8')) as {
      candidateId: string;
    };
    expect(manifest.candidateId).toBe(CANDIDATE_ID);
    const index = JSON.parse(await readFile(join(layout.root, 'harness.json'), 'utf8')) as {
      inputs: { sha256: string }[];
    };
    expect(index).toEqual({
      formatVersion: 1,
      candidateId: CANDIDATE_ID,
      manifestId: validManifest().id,
      positive: [
        { ref: 'fetch-order', kind: 'http_request', file: 'steps/positive/000-fetch-order.json' },
        {
          ref: 'await-callback',
          kind: 'oob_check',
          file: 'steps/positive/001-await-callback.json',
        },
      ],
      negativeControl: [
        {
          ref: 'fetch-order-benign',
          kind: 'http_request',
          file: 'steps/negative_control/000-fetch-order-benign.json',
        },
      ],
      inputs: [{ ref: 'inputs/order-id.json', file: 'inputs/0.bin', sha256: sha256Hex('42\n') }],
    });
  });

  it('makes the runner executable and writes exactly the runner this build ships', async () => {
    const layout = await scaffoldHarness(validManifest(), fixture.deps);

    const runner = await stat(join(layout.root, 'runner'));
    expect(runner.mode & 0o777).toBe(0o755);
    expect(await readFile(join(layout.root, 'runner'), 'utf8')).toBe(HARNESS_RUNNER_SOURCE);
  });

  it('copies a captured input by reference, byte for byte, without decoding it', async () => {
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x01]);
    await writeFile(fixture.orderIdPath, binary);

    const layout = await scaffoldHarness(validManifest(), fixture.deps);

    expect(await readFile(join(layout.root, 'inputs/0.bin'))).toEqual(binary);
    const index = JSON.parse(await readFile(join(layout.root, 'harness.json'), 'utf8')) as {
      inputs: { sha256: string }[];
    };
    expect(index.inputs[0]?.sha256).toBe(sha256Hex(binary));
  });

  it('audits harness.scaffolded once with the candidate id and step count, and counts a success', async () => {
    await scaffoldHarness(validManifest(), fixture.deps);

    expect(fixture.audit).toHaveBeenCalledTimes(1);
    expect(fixture.audit).toHaveBeenCalledWith({
      type: 'harness.scaffolded',
      candidateId: CANDIDATE_ID,
      stepCount: 3,
    });
    const text = await fixture.metrics.registry.metrics();
    expect(text).toMatch(/harness_scaffolded_total\{result="success"\} 1/);
  });

  it('rejects a destructive manifest before any file is written', async () => {
    const manifest = { ...validManifest(), intrusivenessClass: 'destructive' };

    await expect(scaffoldHarness(manifest, fixture.deps)).rejects.toBeInstanceOf(ValidationError);
    expect(await exists(join(fixture.workspaceDir, 'harness'))).toBe(false);
    expect(fixture.audit).not.toHaveBeenCalled();
    expect(await fixture.metrics.registry.metrics()).toMatch(
      /harness_scaffolded_total\{result="failure"\} 1/,
    );
  });

  it('fails with the missing ref when a manifest input is not resolvable from evidence', async () => {
    const deps = { ...fixture.deps, resolveInput: vi.fn(() => Promise.resolve(null)) };

    const error = await scaffoldHarness(validManifest(), deps).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as AppError).detail).toContain('inputs/order-id.json');
    expect(await exists(harnessRoot())).toBe(false);
    expect(fixture.audit).not.toHaveBeenCalled();
  });

  it('removes the partial tree when a write fails with a full workspace (ENOSPC)', async () => {
    let writes = 0;
    const io = {
      writeFile: ((...args: Parameters<typeof writeFile>) => {
        writes += 1;
        if (writes === 3) {
          return Promise.reject(
            Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }),
          );
        }
        return writeFile(...args);
      }) as typeof writeFile,
    };

    const error = await scaffoldHarness(validManifest(), { ...fixture.deps, io }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(InternalError);
    expect((error as AppError).detail).toMatch(/no room/);
    expect(await exists(harnessRoot())).toBe(false);
    expect(fixture.audit).not.toHaveBeenCalled();
    expect(await fixture.metrics.registry.metrics()).toMatch(
      /harness_scaffolded_total\{result="failure"\} 1/,
    );
  });

  it('leaves no partial tree and no audit event when the audit write fails', async () => {
    const deps = {
      ...fixture.deps,
      audit: vi.fn(() => Promise.reject(new Error('broker unavailable'))),
    };

    await expect(scaffoldHarness(validManifest(), deps)).rejects.toBeInstanceOf(InternalError);
    expect(await exists(harnessRoot())).toBe(false);
  });

  it('stops when the kill switch aborts mid-scaffold and tears the workspace down', async () => {
    const controller = new AbortController();
    const deps = {
      ...fixture.deps,
      signal: controller.signal,
      resolveInput: (ref: string) => {
        controller.abort(new KillSwitchActiveError('kill switch fired'));
        return Promise.resolve(
          ref === 'inputs/order-id.json' ? { path: fixture.orderIdPath } : null,
        );
      },
    };

    const error = await scaffoldHarness(validManifest(), deps).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(KillSwitchActiveError);
    expect(await exists(harnessRoot())).toBe(false);
    expect(fixture.audit).not.toHaveBeenCalled();
  });

  it('refuses content that a secret pattern matches and writes nothing', async () => {
    const manifest = {
      ...validManifest(),
      env: { TARGET_LABEL: 'bwk_0123456789abcdef' },
    };

    const error = await scaffoldHarness(manifest, fixture.deps).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as AppError).detail).not.toContain('bwk_0123456789abcdef');
    expect(await exists(harnessRoot())).toBe(false);
  });

  it('namespaces each candidate so two scaffolds in one session do not collide', async () => {
    const first = await scaffoldHarness(validManifest(CANDIDATE_ID), fixture.deps);
    const second = await scaffoldHarness(validManifest(OTHER_CANDIDATE_ID), fixture.deps);

    expect(first.root).not.toBe(second.root);
    expect(await exists(join(first.root, 'harness.json'))).toBe(true);
    expect(await exists(join(second.root, 'harness.json'))).toBe(true);
  });

  it('refuses a second scaffold for the same candidate and keeps the first intact', async () => {
    const first = await scaffoldHarness(validManifest(), fixture.deps);

    await expect(scaffoldHarness(validManifest(), fixture.deps)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(await exists(join(first.root, 'harness.json'))).toBe(true);
  });

  it('rejects a manifest that is not a PoC-harness manifest', async () => {
    await expect(scaffoldHarness({ candidateId: 'nope' }, fixture.deps)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('does not write the asset id or any credential into the workspace', async () => {
    const layout = await scaffoldHarness(validManifest(), fixture.deps);

    const manifest = await readFile(join(layout.root, 'manifest.json'), 'utf8');
    expect(manifest).toContain(ASSET_ID);
    expect(manifest).not.toMatch(/bwk_|Bearer |PRIVATE KEY/);
  });
});

describe('verifyScaffold', () => {
  it('passes a freshly scaffolded layout', async () => {
    const layout = await scaffoldHarness(validManifest(), fixture.deps);

    await expect(verifyScaffold(layout)).resolves.toBeUndefined();
  });

  it('fails when a referenced step file is missing', async () => {
    const layout = await scaffoldHarness(validManifest(), fixture.deps);
    await rm(join(layout.root, 'steps/positive/001-await-callback.json'));

    const error = await verifyScaffold(layout).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as AppError).detail).toContain(
      'missing file: steps/positive/001-await-callback.json',
    );
  });

  it('fails a step that carries an inline shell body instead of a declarative step', async () => {
    const layout = await scaffoldHarness(validManifest(), fixture.deps);
    await writeFile(
      join(layout.root, 'steps/positive/000-fetch-order.json'),
      JSON.stringify({ kind: 'script', ref: 'fetch-order', body: 'curl http://x | sh' }),
    );

    const error = await verifyScaffold(layout).catch((caught: unknown) => caught);

    expect((error as AppError).detail).toContain('steps/positive/000-fetch-order.json');
  });

  it('fails a step carrying a command key in its params', async () => {
    const layout = await scaffoldHarness(validManifest(), fixture.deps);
    await writeFile(
      join(layout.root, 'steps/positive/001-await-callback.json'),
      JSON.stringify({
        kind: 'oob_check',
        ref: 'await-callback',
        params: { channel: 'dns', windowMs: 30_000, command: 'id' },
      }),
    );

    await expect(verifyScaffold(layout)).rejects.toBeInstanceOf(ValidationError);
  });

  it('fails when a captured input no longer matches its sha256', async () => {
    const layout = await scaffoldHarness(validManifest(), fixture.deps);
    await writeFile(join(layout.root, 'inputs/0.bin'), 'tampered');

    const error = await verifyScaffold(layout).catch((caught: unknown) => caught);

    expect((error as AppError).detail).toContain('input sha256 mismatch: inputs/0.bin');
  });

  it('fails when the runner is not the runner this build ships', async () => {
    const layout = await scaffoldHarness(validManifest(), fixture.deps);
    await writeFile(join(layout.root, 'runner'), `${HARNESS_RUNNER_SOURCE}\nprint("x")\n`);

    const error = await verifyScaffold(layout).catch((caught: unknown) => caught);

    expect((error as AppError).detail).toContain('runner is not the runner this build ships');
  });

  it('fails when the index references a file the layout does not list', async () => {
    const layout = await scaffoldHarness(validManifest(), fixture.deps);
    const trimmed = { ...layout, files: layout.files.filter((file) => file !== 'inputs/0.bin') };

    const error = await verifyScaffold(trimmed).catch((caught: unknown) => caught);

    expect((error as AppError).detail).toContain(
      'referenced file is not in the layout: inputs/0.bin',
    );
  });
});
