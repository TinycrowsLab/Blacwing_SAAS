import { beforeEach, describe, expect, it, vi } from 'vitest';

import { startWorkerProcess } from './bootstrap.js';

const mocks = vi.hoisted(() => ({
  bundleWorkflowCode: vi.fn(),
  connect: vi.fn(),
  create: vi.fn(),
  install: vi.fn(),
}));

vi.mock('@temporalio/worker', () => ({
  bundleWorkflowCode: mocks.bundleWorkflowCode,
  NativeConnection: { connect: mocks.connect },
  Runtime: { install: mocks.install },
  Worker: { create: mocks.create },
}));

const env = {
  NODE_ENV: 'test',
  TEMPORAL_ADDRESS: '127.0.0.1:17233',
  TEMPORAL_NAMESPACE: 'blackwing-dev',
};

describe('startWorkerProcess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails (never serving a stale bundle) when the workflow bundle build fails', async () => {
    mocks.bundleWorkflowCode.mockRejectedValue(new Error('bundle failed'));
    await expect(startWorkerProcess(env)).rejects.toThrow('bundle failed');
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('fails fast on an unknown task queue before touching Temporal', async () => {
    await expect(startWorkerProcess({ ...env, WORKER_TASK_QUEUES: 'bogus' })).rejects.toThrow(
      /bogus/,
    );
    expect(mocks.bundleWorkflowCode).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
