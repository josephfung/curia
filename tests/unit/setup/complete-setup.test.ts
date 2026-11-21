import { describe, it, expect, vi } from 'vitest';
import { completeSetup } from '../../../src/setup/complete-setup.js';

describe('completeSetup', () => {
  it('marks Setup complete and leaves the web thread alone (onboarding start rotates it, #2360)', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await completeSetup({ query });
    const sql = query.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(sql.some((q) => q.includes("phase = 'complete'"))).toBe(true);
    expect(sql.some((q) => q.includes('web_thread'))).toBe(false);
  });
});
