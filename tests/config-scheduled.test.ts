import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, reloadAgentConfig } from '../src/config.js';
import { assertFreshActor } from '../src/scheduled-tasks/policy.js';
import type { ScheduleAccessPolicy, ScheduleActor } from '../src/scheduled-tasks/types.js';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function directory() { const dir = mkdtempSync(join(tmpdir(), 'boe-schedule-config-')); directories.push(dir); return dir; }
function save(dir: string, scheduledTasks: unknown) { writeFileSync(join(dir, 'config.local.json'), JSON.stringify({ scheduledTasks })); }

describe('scheduled task deployment configuration', () => {
  it('keeps scheduling disabled by default with bounded frequency, roles, and workload', () => {
    expect(loadConfig(directory()).scheduledTasks).toEqual({
      enabled: false, defaultTimezone: 'Asia/Shanghai', minIntervalMs: 3_600_000,
      scanIntervalMs: 1000, concurrency: 1, maxPerOwner: 20, maxPerRoom: 100,
      maxSchedules: 1000, failureThreshold: 3, catchUpWindowMs: 86_400_000,
      timeoutMs: 3_600_000, commandTtlMs: 300_000, roleMaxAgeMs: 300_000,
    });
  });

  it('merges partial configuration and requires restart for operational changes', () => {
    const root = directory(); save(root, { enabled: true, minIntervalMs: 7_200_000, roleMaxAgeMs: 60_000, defaultTimezone: 'UTC' });
    const initial = loadConfig(root);
    expect(initial.scheduledTasks).toMatchObject({ enabled: true, minIntervalMs: 7_200_000, roleMaxAgeMs: 60_000, defaultTimezone: 'UTC', maxPerOwner: 20 });
    save(root, { enabled: false, minIntervalMs: 3_600_000 });
    expect(reloadAgentConfig(initial).config.scheduledTasks).toEqual(initial.scheduledTasks);
    expect(loadConfig(root).scheduledTasks).toMatchObject({ enabled: false, minIntervalMs: 3_600_000 });
  });

  it.each([
    [{ minIntervalMs: 3_599_999 }, /at least one hour/],
    [{ roleMaxAgeMs: 300_001 }, /expire within five minutes/],
    [{ roleMaxAgeMs: 0 }, /roleMaxAgeMs/],
    [{ enabled: 'true' }, /enabled/],
    [{ defaultTimezone: 'Invalid/Zone' }, /defaultTimezone/],
    [{ scanIntervalMs: 0 }, /scanIntervalMs/],
    [{ concurrency: 1.5 }, /concurrency/],
    [{ maxPerOwner: -1 }, /maxPerOwner/],
    [{ maxSchedules: '1000' }, /maxSchedules/],
    [{ timeoutMs: 0 }, /timeoutMs/],
    [{ commandTtlMs: 0 }, /commandTtlMs/],
  ])('rejects unsafe deployment settings %j', (settings, error) => {
    const root = directory(); save(root, settings); expect(() => loadConfig(root)).toThrow(error);
  });

  it('enforces the configured role expiry at mutation time without treating unknown roles as members', () => {
    const root = directory(); save(root, { enabled: true, roleMaxAgeMs: 60_000 });
    const maxAge = loadConfig(root).scheduledTasks!.roleMaxAgeMs!, now = Date.UTC(2030, 0, 1);
    const actor: ScheduleActor = { kind: 'user', memberId: '301', roomId: 'qq:900:100', roleGroup: 'member', roleVerifiedAt: now - maxAge, sourceMessageIds: ['request'], registeredBy: 'worker' };
    const policy: ScheduleAccessPolicy = { allowedRoleGroups: ['group_admin', 'member'], version: 1, updatedAt: now, updatedBy: 'test' };
    expect(() => assertFreshActor(actor, policy, now, maxAge)).not.toThrow();
    expect(() => assertFreshActor(actor, policy, now + 1, maxAge)).toThrow('重新核验');
    expect(() => assertFreshActor({ ...actor, roleGroup: 'unknown', roleVerifiedAt: now }, policy, now, maxAge)).toThrow('没有任务');
    expect(() => assertFreshActor({ ...actor, roleVerifiedAt: now + 5001 }, policy, now, maxAge)).toThrow('重新核验');
  });
});
