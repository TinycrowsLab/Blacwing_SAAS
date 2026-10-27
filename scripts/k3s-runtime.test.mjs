// Offline tests for the sandbox runtime manifests (INFRA-005): infra/k3s/runtime/*.
// The live gVisor pod checks need a cluster with runsc (infra/k3s/verify.sh); these assert
// the manifests that enforce them, since this host has no gVisor.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { REPO_ROOT } from './test-fixtures.mjs';

/** @param {string} rel */
const read = (rel) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const RUNTIME = 'infra/k3s/runtime';

describe('RuntimeClass gvisor (cloud)', () => {
  const text = read(`${RUNTIME}/runtimeclass.yaml`);
  it('uses the runsc handler and pins pods to the sandbox pool with the sandbox toleration', () => {
    assert.match(text, /^kind: RuntimeClass$/m);
    assert.match(text, /^metadata:\n {2}name: gvisor$/m);
    assert.match(text, /^handler: runsc$/m);
    assert.match(text, /nodeSelector:\n\s+blackwing\.io\/pool: sandbox/);
    assert.match(
      text,
      /key: blackwing\.io\/sandbox\n\s+operator: Equal\n\s+value: 'true'\n\s+effect: NoSchedule/,
    );
  });
  it('offers no runc fallback class', () => {
    assert.doesNotMatch(text, /handler: runc\b/);
    assert.doesNotMatch(text, /^handler: (?!runsc).*/m);
  });
});

describe('host-socket guard', () => {
  const text = read(`${RUNTIME}/host-socket-guard.yaml`);
  it('fails closed and denies (and audits) everywhere except kube-system', () => {
    assert.match(text, /failurePolicy: Fail/);
    assert.match(text, /validationActions: \[Deny, Audit\]/);
    assert.match(text, /operator: NotIn\n\s+values: \[kube-system\]/);
  });
  it('rejects docker/containerd socket hostPaths, privileged containers and host PID/IPC', () => {
    assert.match(text, /docker\|containerd/);
    assert.match(text, /\^\/\(var\/\)\?run/);
    assert.match(text, /privileged containers are forbidden/);
    assert.match(text, /host PID\/IPC namespaces are forbidden/);
  });
  it('covers init and ephemeral containers and pod updates', () => {
    assert.match(text, /initContainers/);
    assert.match(text, /ephemeralContainers/);
    assert.match(text, /operations: \['CREATE', 'UPDATE'\]/);
  });
  it('the dev sandbox policy still forbids any hostPath', () => {
    assert.match(read('infra/k3s/manifests/20-admission.yaml'), /!has\(v\.hostPath\)/);
  });
});

describe('runtime-class observability', () => {
  const text = read(`${RUNTIME}/prometheus-rules.yaml`);
  it('records pods per runtime class and alerts on a sandbox pod outside gvisor', () => {
    assert.match(text, /record: blackwing:pods_by_runtime_class:count/);
    assert.match(text, /alert: SandboxPodNotUnderGvisor/);
    assert.match(text, /runtime_class_name="gvisor"/);
    assert.match(text, /severity: critical/);
  });
});

describe('runsc pin', () => {
  it('is recorded in infra/versions.env with a sha512', () => {
    const env = read('infra/versions.env');
    assert.match(env, /^RUNSC_VERSION="\d{8}(\.\d+)?"$/m);
    assert.match(env, /^RUNSC_SHA512_AMD64="[0-9a-f]{128}"$/m);
  });
});
