import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGrants, sdkConfigs } = vi.hoisted(() => ({
  mockGrants: { find: vi.fn() },
  sdkConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock('nylas', () => {
  class MockNylas {
    grants = mockGrants;
    constructor(config: Record<string, unknown>) {
      sdkConfigs.push(config);
    }
  }
  return { default: MockNylas };
});

import { NylasClient } from '../../../../src/channels/email/nylas-client.js';
import pino from 'pino';

const client = new NylasClient('key', 'grant-1', pino({ level: 'silent' }));

describe('NylasClient.getGrant', () => {
  beforeEach(() => {
    mockGrants.find.mockReset();
  });

  it("returns the grant's lowercased email and provider", async () => {
    mockGrants.find.mockResolvedValue({ data: { email: 'Work@Example.COM', provider: 'google' } });
    await expect(client.getGrant()).resolves.toEqual({ email: 'work@example.com', provider: 'google' });
    expect(mockGrants.find).toHaveBeenCalledWith({ grantId: 'grant-1' });
  });

  it('throws when the grant has no email', async () => {
    mockGrants.find.mockResolvedValue({ data: { provider: 'google' } });
    await expect(client.getGrant()).rejects.toThrow(/no email/i);
  });

  it('keeps the grant id out of the thrown message', async () => {
    mockGrants.find.mockResolvedValue({ data: { provider: 'google' } });
    await expect(client.getGrant()).rejects.not.toThrow(/grant-1/);
  });

  it('propagates a 404', async () => {
    const err = Object.assign(new Error('not found'), { statusCode: 404 });
    mockGrants.find.mockImplementation(async () => {
      throw err;
    });
    await expect(client.getGrant()).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('NylasClient region', () => {
  it('passes apiUri to the SDK when given', () => {
    sdkConfigs.length = 0;
    new NylasClient('key', 'grant-1', pino({ level: 'silent' }), undefined, 'https://api.eu.nylas.com');
    expect(sdkConfigs.at(-1)).toMatchObject({ apiKey: 'key', apiUri: 'https://api.eu.nylas.com' });
  });

  it('leaves apiUri out of the SDK config when not given (SDK default)', () => {
    sdkConfigs.length = 0;
    new NylasClient('key', 'grant-1', pino({ level: 'silent' }));
    expect(sdkConfigs.at(-1)).not.toHaveProperty('apiUri');
  });
});
