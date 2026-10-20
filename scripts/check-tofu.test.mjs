// Tests for the OpenTofu static checker (INFRA-001) and the real infra/tofu tree.

import assert from 'node:assert/strict';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { TOFU_DIR, checkTofu, main, resourceBlock } from './check-tofu.mjs';
import { REPO_ROOT } from './test-fixtures.mjs';

/** @type {string[]} */
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** Copies the real infra/tofu (symlinks kept) into a temp repo root and returns that root. */
function copyTree() {
  const root = mkdtempSync(path.join(tmpdir(), 'bw-check-tofu-'));
  temps.push(root);
  cpSync(path.join(REPO_ROOT, TOFU_DIR), path.join(root, TOFU_DIR), {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => !src.split(path.sep).includes('.terraform'),
  });
  return root;
}

/**
 * @param {string} root
 * @param {string} rel path under infra/tofu
 * @param {(text: string) => string} change
 */
function edit(root, rel, change) {
  const file = path.join(root, TOFU_DIR, rel);
  writeFileSync(file, change(readFileSync(file, 'utf8')));
}

/**
 * @param {string[]} errors
 * @param {RegExp} pattern
 */
const expectError = (errors, pattern) => {
  assert.ok(
    errors.some((e) => pattern.test(e)),
    `expected an error matching ${String(pattern)}, got:\n${errors.join('\n')}`,
  );
};

describe('check-tofu on the real tree', () => {
  it('passes', () => {
    assert.deepEqual(checkTofu(REPO_ROOT), []);
  });

  it('main exits 0', () => {
    assert.equal(main(['--root', REPO_ROOT]), 0);
  });
});

describe('check-tofu rejects', () => {
  it('a required_version out of step with .opentofu-version', () => {
    const root = copyTree();
    writeFileSync(path.join(root, TOFU_DIR, '.opentofu-version'), '1.9.0\n');
    expectError(checkTofu(root), /required_version must be "~> 1\.9\.0"/);
  });

  it('an unpinned AWS provider', () => {
    const root = copyTree();
    edit(root, 'versions.tf', (t) =>
      t.replace(/(source\s*=\s*"hashicorp\/aws"\s*\n\s*version\s*=\s*)"~> [0-9.]+"/, '$1">= 5.0"'),
    );
    expectError(checkTofu(root), /pin hashicorp\/aws/);
  });

  it('a backend without DynamoDB locking or encryption', () => {
    const root = copyTree();
    edit(root, 'backend.tf', (t) =>
      t
        .replace(/^\s*dynamodb_table.*$/m, '')
        .replace('encrypt        = true', 'encrypt        = false'),
    );
    const errors = checkTofu(root);
    expectError(errors, /dynamodb_table/);
    expectError(errors, /encrypt = true/);
  });

  it('a state key that is not per environment', () => {
    const root = copyTree();
    edit(root, 'backend.tf', (t) => t.replace('blackwing/${var.environment}/', 'blackwing/'));
    expectError(checkTofu(root), /backend\.tf key/);
  });

  it('missing default_tags', () => {
    const root = copyTree();
    edit(root, 'providers.tf', (t) => t.replace('tags = local.common_tags', 'tags = {}'));
    expectError(checkTofu(root), /default_tags/);
  });

  it('a missing environment file', () => {
    const root = copyTree();
    unlinkSync(path.join(root, TOFU_DIR, 'environments', 'prod', 'outputs.tf'));
    expectError(checkTofu(root), /environments\/prod\/outputs\.tf is missing/);
  });

  it('a copied (not linked) shared file', () => {
    const root = copyTree();
    const link = path.join(root, TOFU_DIR, 'environments', 'staging', 'backend.tf');
    unlinkSync(link);
    writeFileSync(link, readFileSync(path.join(root, TOFU_DIR, 'backend.tf')));
    expectError(checkTofu(root), /staging\/backend\.tf must be a symlink/);
  });

  it('a tfvars that selects the wrong environment', () => {
    const root = copyTree();
    edit(root, 'environments/staging/terraform.tfvars', (t) =>
      t.replace('environment = "staging"', 'environment = "prod"'),
    );
    expectError(checkTofu(root), /staging\/terraform\.tfvars must set environment = "staging"/);
  });

  it('a hardcoded account ID', () => {
    const root = copyTree();
    edit(root, 'environments/dev/main.tf', (t) => `${t}\nlocals {\n  acct = "123456789012"\n}\n`);
    expectError(checkTofu(root), /hardcoded 12-digit AWS account ID/);
  });

  it('Object Lock on the state bucket', () => {
    const root = copyTree();
    edit(root, 'bootstrap/main.tf', (t) =>
      t.replace(/(resource "aws_s3_bucket" "state" \{\n)/, '$1  object_lock_enabled = true\n'),
    );
    expectError(checkTofu(root), /never enable Object Lock/);
  });

  it('a stateful bootstrap resource without prevent_destroy (re-run could recreate it)', () => {
    const root = copyTree();
    edit(root, 'bootstrap/main.tf', (t) => {
      const block = resourceBlock(t, 'aws_dynamodb_table.lock');
      assert.ok(block);
      return t.replace(block, block.replace('prevent_destroy = true', 'prevent_destroy = false'));
    });
    expectError(checkTofu(root), /aws_dynamodb_table\.lock must set lifecycle\.prevent_destroy/);
  });

  it('a resource overriding a common tag', () => {
    const root = copyTree();
    edit(
      root,
      'environments/dev/main.tf',
      (t) => `${t}\nresource "terraform_data" "x" {\n  tags = { ManagedBy = "console" }\n}\n`,
    );
    expectError(checkTofu(root), /must not override the common tag ManagedBy/);
  });

  it('a committed state file', () => {
    const root = copyTree();
    writeFileSync(path.join(root, TOFU_DIR, 'bootstrap', 'terraform.tfstate'), '{}');
    expectError(checkTofu(root), /state files must never be committed/);
  });

  it('a symlink pointing somewhere else', () => {
    const root = copyTree();
    const link = path.join(root, TOFU_DIR, 'bootstrap', 'providers.tf');
    unlinkSync(link);
    symlinkSync(path.join('..', 'versions.tf'), link);
    expectError(
      checkTofu(root),
      /bootstrap\/providers\.tf must be a symlink to \.\.\/providers\.tf/,
    );
  });

  it('and main exits 1', () => {
    const root = copyTree();
    writeFileSync(path.join(root, TOFU_DIR, 'bootstrap', 'terraform.tfstate'), '{}');
    assert.equal(main(['--root', root]), 1);
  });
});
