import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { replaceActiveSkillsBlock } from '../../../src/db/active-skills-progress.js';
import { minutesTaskNeedsRepair, withMinutesTaskLock } from '../../../src/meetings/minutes-task.js';

function lockingPool(unlock: () => Promise<void>): {
  pool: Pool;
  release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn();
  let calls = 0;
  const client = {
    query: vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { rows: [] };
      await unlock();
      return { rows: [] };
    }),
    release,
  };
  return { pool: { connect: async () => client } as unknown as Pool, release };
}

describe('withMinutesTaskLock', () => {
  it('returns the callback result when the unlock fails and destroys the connection', async () => {
    const { pool, release } = lockingPool(async () => {
      throw new Error('unlock failed');
    });
    await expect(withMinutesTaskLock(pool, 'meeting-minutes:sess', async () => 'done')).resolves.toBe('done');
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect((release.mock.calls[0]?.[0] as Error).message).toBe('unlock failed');
  });

  it('keeps the callback error when the unlock also fails', async () => {
    const { pool, release } = lockingPool(async () => {
      throw new Error('unlock failed');
    });
    await expect(withMinutesTaskLock(pool, 'meeting-minutes:sess', async () => {
      throw new Error('task write failed');
    })).rejects.toThrow('task write failed');
    expect((release.mock.calls[0]?.[0] as Error).message).toBe('unlock failed');
  });
});

describe('minutesTaskNeedsRepair', () => {
  it('repairs a task whose stored block still names the removed playbook (#2400)', () => {
    const progress = { activeSkills: replaceActiveSkillsBlock(['meeting-minutes-structuring']) };
    expect(minutesTaskNeedsRepair({ status: 'pending', progress }, true)).toBe(true);
  });

  it('leaves a task with the meetings bundle and a wake alone', () => {
    const progress = { activeSkills: replaceActiveSkillsBlock(['meetings']) };
    expect(minutesTaskNeedsRepair({ status: 'pending', progress }, true)).toBe(false);
  });
});
