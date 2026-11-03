import { describe, it, expect, vi } from 'vitest';
import { emailChannelStatus } from '../../../../src/channels/email/email-channel-status.js';

function deps(o: { running: number; enabled: boolean; gate: boolean }) {
  return {
    runningAdapterCount: () => o.running,
    isEnabled: vi.fn(async () => o.enabled),
    gatePasses: vi.fn(async () => o.gate),
  };
}

describe('emailChannelStatus (#2409)', () => {
  it('is running when an adapter started this boot', async () => {
    await expect(emailChannelStatus(deps({ running: 1, enabled: true, gate: true }))).resolves.toBe('running');
  });

  it('is restart_required when the channel is enabled after boot and its gate passes, with nothing polling', async () => {
    // The console flow: add an account, click Enable, no restart yet.
    await expect(emailChannelStatus(deps({ running: 0, enabled: true, gate: true }))).resolves.toBe('restart_required');
  });

  it('is not_configured when the channel is not enabled, even if credentials are complete', async () => {
    const d = deps({ running: 0, enabled: false, gate: true });
    await expect(emailChannelStatus(d)).resolves.toBe('not_configured');
    expect(d.gatePasses).not.toHaveBeenCalled();
  });

  it('is not_configured when enabled but the gate fails (no account with a grant)', async () => {
    await expect(emailChannelStatus(deps({ running: 0, enabled: true, gate: false }))).resolves.toBe('not_configured');
  });
});
