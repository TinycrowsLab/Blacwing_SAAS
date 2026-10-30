// The committed bw-sandbox seccomp profile must be valid JSON in the OCI seccomp shape, default-deny, and
// must never allow a syscall that would let a sandbox escape, inspect another process or reach the kernel
// beyond what Node and the toolchain need (SANDBOX-007, CONTEXT_PACK §8.5 defence in depth).
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const profileSchema = z.strictObject({
  defaultAction: z.literal('SCMP_ACT_ERRNO'),
  defaultErrnoRet: z.number().int().positive(),
  architectures: z.array(z.enum(['SCMP_ARCH_X86_64', 'SCMP_ARCH_AARCH64'])).min(1),
  syscalls: z
    .array(
      z.strictObject({
        names: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1),
        action: z.enum(['SCMP_ACT_ALLOW', 'SCMP_ACT_ERRNO']),
        errnoRet: z.number().int().positive().optional(),
        args: z
          .array(
            z.strictObject({
              index: z.number().int().min(0).max(5),
              value: z.number().int().nonnegative(),
              valueTwo: z.number().int().nonnegative(),
              op: z.enum(['SCMP_CMP_MASKED_EQ']),
            }),
          )
          .optional(),
      }),
    )
    .min(1),
});

const profileUrl = new URL(
  '../../../../infra/docker/sandbox/seccomp/bw-sandbox.json',
  import.meta.url,
);

function loadProfile(): z.infer<typeof profileSchema> {
  return profileSchema.parse(JSON.parse(readFileSync(profileUrl, 'utf8')));
}

/** Syscalls that must never be allowed in a sandbox (escape, process inspection, kernel surface). */
const NEVER_ALLOWED = [
  'ptrace',
  'process_vm_readv',
  'process_vm_writev',
  'mount',
  'umount2',
  'pivot_root',
  'chroot',
  'unshare',
  'setns',
  'bpf',
  'perf_event_open',
  'userfaultfd',
  'kexec_load',
  'kexec_file_load',
  'init_module',
  'finit_module',
  'delete_module',
  'add_key',
  'request_key',
  'keyctl',
  'io_uring_setup',
  'io_uring_enter',
  'io_uring_register',
  'reboot',
  'swapon',
  'swapoff',
  'open_by_handle_at',
  'name_to_handle_at',
  'personality',
  'acct',
  'syslog',
  'settimeofday',
  'clock_settime',
  'adjtimex',
  'quotactl',
  'iopl',
  'ioperm',
  'vhangup',
  'lookup_dcookie',
] as const;

/** Namespace flags a `clone` must never set (CLONE_NEWNS, CLONE_NEWCGROUP, CLONE_NEWUTS, CLONE_NEWIPC, CLONE_NEWUSER, CLONE_NEWPID, CLONE_NEWNET, CLONE_NEWTIME). */
const CLONE_NEWNS_MASK = 0x0002_0000;
const CLONE_NEWCGROUP = 0x0200_0000;
const CLONE_NEWUTS = 0x0400_0000;
const CLONE_NEWIPC = 0x0800_0000;
const CLONE_NEWUSER = 0x1000_0000;
const CLONE_NEWPID = 0x2000_0000;
const CLONE_NEWNET = 0x4000_0000;
const CLONE_NEWTIME = 0x0000_0080;

describe('bw-sandbox seccomp profile', () => {
  it('is valid JSON in the OCI seccomp shape', () => {
    expect(() => loadProfile()).not.toThrow();
  });

  it('is default-deny and targets the architectures the images build for', () => {
    const profile = loadProfile();
    expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO');
    expect(profile.architectures).toEqual(['SCMP_ARCH_X86_64', 'SCMP_ARCH_AARCH64']);
  });

  it('never allows a sandbox-escape or kernel-surface syscall', () => {
    const allowed = new Set<string>();
    for (const rule of loadProfile().syscalls) {
      if (rule.action === 'SCMP_ACT_ALLOW') for (const name of rule.names) allowed.add(name);
    }
    for (const name of NEVER_ALLOWED) {
      expect(allowed.has(name), `${name} must not be allowed`).toBe(false);
    }
  });

  it('lists each syscall name at most once', () => {
    const seen = new Map<string, number>();
    for (const rule of loadProfile().syscalls) {
      for (const name of rule.names) seen.set(name, (seen.get(name) ?? 0) + 1);
    }
    const duplicates = [...seen].filter(([, count]) => count > 1).map(([name]) => name);
    expect(duplicates).toEqual([]);
  });

  it('refuses clone3 with ENOSYS so glibc falls back to clone, which is namespace-filtered', () => {
    const rule = loadProfile().syscalls.find((r) => r.names.includes('clone3'));
    expect(rule).toEqual({ names: ['clone3'], action: 'SCMP_ACT_ERRNO', errnoRet: 38 });
  });

  it('allows clone only when no namespace flag is set', () => {
    const rule = loadProfile().syscalls.find((r) => r.names.includes('clone'));
    expect(rule?.action).toBe('SCMP_ACT_ALLOW');
    const arg = rule?.args?.[0];
    expect(arg?.index).toBe(0);
    expect(arg?.op).toBe('SCMP_CMP_MASKED_EQ');
    expect(arg?.valueTwo).toBe(0);
    const mask = arg?.value ?? 0;
    for (const flag of [
      CLONE_NEWNS_MASK,
      CLONE_NEWCGROUP,
      CLONE_NEWUTS,
      CLONE_NEWIPC,
      CLONE_NEWUSER,
      CLONE_NEWPID,
      CLONE_NEWNET,
      CLONE_NEWTIME,
    ]) {
      expect((mask & flag) === flag, `mask must cover flag ${String(flag)}`).toBe(true);
    }
  });

  it('allows the syscalls Node 22 and glibc need to start and run', () => {
    const allowed = new Set(
      loadProfile().syscalls.flatMap((r) => (r.action === 'SCMP_ACT_ALLOW' ? r.names : [])),
    );
    for (const name of [
      'openat',
      'read',
      'write',
      'mmap',
      'mprotect',
      'futex',
      'epoll_pwait',
      'epoll_ctl',
      'getrandom',
      'clock_gettime',
      'rseq',
      'set_robust_list',
      'prlimit64',
      'sigaltstack',
      'execve',
      'socket',
      'connect',
    ]) {
      expect(allowed.has(name), `${name} must be allowed`).toBe(true);
    }
  });

  it('keeps every rule allow-or-errno only (no trace, log or kill actions)', () => {
    const actions = new Set(loadProfile().syscalls.map((r) => r.action));
    expect([...actions].sort()).toEqual(['SCMP_ACT_ALLOW', 'SCMP_ACT_ERRNO']);
  });
});
