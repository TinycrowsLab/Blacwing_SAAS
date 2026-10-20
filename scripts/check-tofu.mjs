#!/usr/bin/env node
// Static checks for the OpenTofu tree under infra/tofu (INFRA-001) that need no tofu binary:
// toolchain pins, the environment layout, the shared-file symlinks, the backend, default_tags,
// no hardcoded account IDs, no committed state, and the bootstrap safety rules (no Object Lock on
// the state bucket, prevent_destroy on every stateful resource). infra/tofu/scripts/check.sh runs
// the tofu-side checks (fmt, validate, tflint, tofu test).
//
// Usage: node scripts/check-tofu.mjs [--root <dir>]
// Exits non-zero (listing every problem) when a rule is broken.

import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOFU_DIR = path.join('infra', 'tofu');
export const ENVIRONMENTS = Object.freeze(['dev', 'staging', 'prod']);
export const ENV_OWN_FILES = Object.freeze([
  'main.tf',
  'variables.tf',
  'terraform.tfvars',
  'outputs.tf',
]);
/** Shared files every environment root links to ../../<file>. */
export const ENV_SHARED_FILES = Object.freeze([
  'versions.tf',
  'providers.tf',
  'backend.tf',
  'common_variables.tf',
]);
/** Shared files bootstrap links to ../<file> (bootstrap has its own backend.tf). */
export const BOOTSTRAP_SHARED_FILES = Object.freeze([
  'versions.tf',
  'providers.tf',
  'common_variables.tf',
]);
export const PREVENT_DESTROY = Object.freeze([
  'aws_kms_key.state',
  'aws_s3_bucket.state',
  'aws_s3_bucket.logs',
  'aws_dynamodb_table.lock',
]);
export const COMMON_TAG_KEYS = Object.freeze(['Project', 'Environment', 'ManagedBy']);

/**
 * Returns the text of `resource "<type>" "<name>" { ... }`, matched by brace depth.
 * @param {string} hcl
 * @param {string} address type.name
 * @returns {string | undefined}
 */
export function resourceBlock(hcl, address) {
  const [type, name] = address.split('.');
  const start = hcl.indexOf(`resource "${String(type)}" "${String(name)}" {`);
  if (start === -1) return undefined;
  let depth = 0;
  for (let i = hcl.indexOf('{', start); i < hcl.length; i += 1) {
    if (hcl[i] === '{') depth += 1;
    if (hcl[i] === '}') {
      depth -= 1;
      if (depth === 0) return hcl.slice(start, i + 1);
    }
  }
  return undefined;
}

/** @param {string} hcl */
const stripComments = (hcl) =>
  hcl
    .split('\n')
    .map((line) => line.replace(/^\s*(#|\/\/).*$/, ''))
    .join('\n');

/**
 * @param {string} root repository root
 * @param {string} rel path relative to root
 */
const read = (root, rel) => readFileSync(path.join(root, rel), 'utf8');

/**
 * @param {string} dir absolute directory
 * @returns {string[]} files below dir, relative to it (skipping .terraform)
 */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.terraform') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full).map((f) => path.join(entry.name, f)));
    else out.push(entry.name);
  }
  return out;
}

/**
 * @param {string} root repository root
 * @returns {string[]} problems, empty when every rule holds
 */
export function checkTofu(root) {
  /** @type {string[]} */
  const errors = [];
  const tofu = path.join(root, TOFU_DIR);
  if (!existsSync(tofu)) return [`${TOFU_DIR} does not exist`];
  const has = (/** @type {string} */ rel) => existsSync(path.join(tofu, rel));

  // 1. Toolchain pins.
  const versionFile = path.join(TOFU_DIR, '.opentofu-version');
  const version = has('.opentofu-version') ? read(root, versionFile).trim() : '';
  const pin = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!pin) errors.push(`${versionFile} must hold an exact X.Y.Z OpenTofu version`);
  const versions = has('versions.tf') ? read(root, path.join(TOFU_DIR, 'versions.tf')) : '';
  if (!versions) errors.push(`${TOFU_DIR}/versions.tf is missing`);
  if (pin && versions && !versions.includes(`required_version = "~> ${pin[1]}.${pin[2]}.0"`)) {
    errors.push(
      `versions.tf required_version must be "~> ${pin[1]}.${pin[2]}.0" (.opentofu-version is ${version})`,
    );
  }
  if (
    versions &&
    !/source\s*=\s*"hashicorp\/aws"[\s\S]*?version\s*=\s*"~> \d+\.\d+"/.test(versions)
  ) {
    errors.push('versions.tf must pin hashicorp/aws with a "~> X.Y" constraint');
  }

  // 2. Backend: S3 with DynamoDB locking, encryption and a per-environment key.
  const backend = has('backend.tf')
    ? stripComments(read(root, path.join(TOFU_DIR, 'backend.tf')))
    : '';
  if (!backend) errors.push(`${TOFU_DIR}/backend.tf is missing`);
  else {
    if (!/backend\s+"s3"/.test(backend)) errors.push('backend.tf must configure the s3 backend');
    if (!/dynamodb_table\s*=/.test(backend))
      errors.push('backend.tf must set dynamodb_table (state locking)');
    if (!/encrypt\s*=\s*true/.test(backend)) errors.push('backend.tf must set encrypt = true');
    if (!backend.includes('key            = "blackwing/${var.environment}/terraform.tfstate"')) {
      errors.push('backend.tf key must be "blackwing/${var.environment}/terraform.tfstate"');
    }
  }

  // 3. Provider default_tags = common_tags with exactly the convention's keys.
  const providers = has('providers.tf')
    ? stripComments(read(root, path.join(TOFU_DIR, 'providers.tf')))
    : '';
  if (!/default_tags\s*{\s*tags\s*=\s*local\.common_tags\s*}/.test(providers)) {
    errors.push('providers.tf must set default_tags { tags = local.common_tags }');
  }
  for (const [key, value] of [
    ['Project', '"blackwing"'],
    ['Environment', 'var.environment'],
    ['ManagedBy', '"opentofu"'],
  ]) {
    if (
      !new RegExp(`${String(key)}\\s*=\\s*${String(value).replace('.', '\\.')}`).test(providers)
    ) {
      errors.push(`providers.tf common_tags must set ${String(key)} = ${String(value)}`);
    }
  }

  // 4. Environment layout and shared-file symlinks.
  for (const env of ENVIRONMENTS) {
    const dir = path.join('environments', env);
    for (const file of ENV_OWN_FILES) {
      if (!has(path.join(dir, file))) errors.push(`${TOFU_DIR}/${dir}/${file} is missing`);
    }
    for (const file of ENV_SHARED_FILES) {
      checkLink(tofu, path.join(dir, file), path.join('..', '..', file), errors);
    }
    if (has(path.join(dir, 'terraform.tfvars'))) {
      const tfvars = read(root, path.join(TOFU_DIR, dir, 'terraform.tfvars'));
      if (!new RegExp(`^environment\\s*=\\s*"${env}"`, 'm').test(tfvars)) {
        errors.push(`${TOFU_DIR}/${dir}/terraform.tfvars must set environment = "${env}"`);
      }
    }
  }
  for (const file of BOOTSTRAP_SHARED_FILES) {
    checkLink(tofu, path.join('bootstrap', file), path.join('..', file), errors);
  }

  // 5. Bootstrap safety rules.
  const main = has('bootstrap/main.tf')
    ? stripComments(read(root, path.join(TOFU_DIR, 'bootstrap', 'main.tf')))
    : '';
  if (!main) errors.push(`${TOFU_DIR}/bootstrap/main.tf is missing`);
  else {
    if (
      /object_lock_enabled\s*=\s*true/.test(main) ||
      main.includes('aws_s3_bucket_object_lock_configuration')
    ) {
      errors.push(
        'bootstrap must never enable Object Lock on the state bucket (it blocks state overwrites)',
      );
    }
    for (const address of PREVENT_DESTROY) {
      const block = resourceBlock(main, address);
      if (!block) errors.push(`bootstrap/main.tf must declare ${address}`);
      else if (!/prevent_destroy\s*=\s*true/.test(block)) {
        errors.push(`bootstrap/main.tf ${address} must set lifecycle.prevent_destroy = true`);
      }
    }
  }

  // 6. Whole tree: no state, no hardcoded account IDs, no per-resource override of common tags.
  for (const rel of walk(tofu)) {
    const relPath = path.join(TOFU_DIR, rel);
    if (/\.tfstate(\..*)?$/.test(rel))
      errors.push(`${relPath}: state files must never be committed`);
    if (!/\.(tf|tfvars)$/.test(rel) || rel.split(path.sep).includes('tests')) continue;
    if (lstatSync(path.join(tofu, rel)).isSymbolicLink()) continue;
    const text = stripComments(read(root, relPath));
    if (/(?<![0-9])[0-9]{12}(?![0-9])/.test(text)) {
      errors.push(`${relPath}: hardcoded 12-digit AWS account ID; read it from var.aws_account_id`);
    }
    for (const match of text.matchAll(/^\s*tags\s*=\s*{([^}]*)}/gm)) {
      for (const key of COMMON_TAG_KEYS) {
        if (new RegExp(`\\b${key}\\s*=`).test(String(match[1]))) {
          errors.push(
            `${relPath}: resource tags must not override the common tag ${key} (default_tags owns it)`,
          );
        }
      }
    }
  }
  return errors;
}

/**
 * @param {string} tofu absolute infra/tofu
 * @param {string} rel link path relative to tofu
 * @param {string} target expected link target
 * @param {string[]} errors
 */
function checkLink(tofu, rel, target, errors) {
  const full = path.join(tofu, rel);
  let isLink = false;
  try {
    isLink = lstatSync(full).isSymbolicLink();
  } catch {
    errors.push(`${TOFU_DIR}/${rel} is missing (must be a symlink to ${target})`);
    return;
  }
  if (!isLink || readlinkSync(full) !== target) {
    errors.push(`${TOFU_DIR}/${rel} must be a symlink to ${target} so roots cannot drift`);
  }
}

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv) {
  const at = argv.indexOf('--root');
  const root =
    at !== -1 && argv[at + 1]
      ? path.resolve(String(argv[at + 1]))
      : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const errors = checkTofu(root);
  for (const error of errors) process.stderr.write(`check-tofu: ${error}\n`);
  if (errors.length === 0) process.stdout.write('check-tofu: OK\n');
  return errors.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
