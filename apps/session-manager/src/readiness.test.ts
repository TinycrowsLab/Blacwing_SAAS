import { describe, expect, it, vi } from 'vitest';

import { createReadinessMonitor, type DependencyProbe } from './readiness.js';

function toggle(name: string, initiallyUp = false): DependencyProbe & { up: boolean } {
  const probe = {
    name,
    up: initiallyUp,
    check: () => (probe.up ? Promise.resolve() : Promise.reject(new Error(`${name} down`))),
  };
  return probe;
}

describe('readiness monitor', () => {
  it('is not ready until every dependency has answered', async () => {
    const driver = toggle('driver');
    const valkey = toggle('valkey');
    const monitor = createReadinessMonitor({ probes: [driver, valkey] });
    expect(monitor.isReady()).toBe(false);
    expect(await monitor.checkNow()).toBe(false);
    valkey.up = true;
    expect(await monitor.checkNow()).toBe(false);
    expect(monitor.state()).toEqual({ driver: false, valkey: true });
    driver.up = true;
    expect(await monitor.checkNow()).toBe(true);
  });

  it('falls back to not ready when a dependency goes away (fail closed)', async () => {
    const valkey = toggle('valkey', true);
    const onChange = vi.fn();
    const monitor = createReadinessMonitor({ probes: [valkey], onChange });
    expect(await monitor.checkNow()).toBe(true);
    valkey.up = false;
    expect(await monitor.checkNow()).toBe(false);
    expect(onChange.mock.calls.map(([ready]) => ready as boolean)).toEqual([true, false]);
  });

  it('treats a hanging probe as down', async () => {
    const monitor = createReadinessMonitor({
      probes: [{ name: 'driver', check: () => new Promise<void>(() => undefined) }],
      probeTimeoutMs: 20,
    });
    expect(await monitor.checkNow()).toBe(false);
  });

  it('edge case: an unreachable dependency is retried with exponential backoff, then recovers', async () => {
    const valkey = toggle('valkey');
    const delays: number[] = [];
    const monitor = createReadinessMonitor({
      probes: [valkey],
      initialBackoffMs: 5,
      maxBackoffMs: 20,
      recheckMs: 5,
      onProbeFailure: (_name, _attempt, next) => delays.push(next),
    });
    monitor.start();
    await vi.waitFor(() => {
      expect(delays.length).toBeGreaterThanOrEqual(4);
    });
    expect(delays.slice(0, 4)).toEqual([5, 10, 20, 20]);
    expect(monitor.isReady()).toBe(false);
    valkey.up = true;
    await vi.waitFor(() => {
      expect(monitor.isReady()).toBe(true);
    });
    monitor.stop();
  });

  it('is never ready after stop, even with healthy dependencies', async () => {
    const monitor = createReadinessMonitor({ probes: [toggle('driver', true)] });
    expect(await monitor.checkNow()).toBe(true);
    monitor.stop();
    expect(monitor.isReady()).toBe(false);
  });
});
