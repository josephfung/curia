// src/channels/credential-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { channelCredentialStatus } from './credential-resolver.js';
import type { ChannelDescriptor } from './catalog.js';

const signal: ChannelDescriptor = {
  name: 'signal', description: '', isToggleable: true,
  credentialFields: [
    { key: 'socket_path', label: 'Socket', secret: false, envFallback: 'SIGNAL_SOCKET_PATH' },
    { key: 'phone_number', label: 'Phone', secret: false, envFallback: 'SIGNAL_PHONE_NUMBER' },
  ],
  requiredSecretKeys: ['socket_path', 'phone_number'],
};

const fakeSecrets = (present: Record<string, string>) => ({
  async get(name: string) { return present[name] ?? null; },
});

describe('channelCredentialStatus', () => {
  it('resolves from the vault first', async () => {
    const secrets = fakeSecrets({ 'channel.signal.socket_path': '/run/sig.sock', 'channel.signal.phone_number': '+15551234567' });
    const res = await channelCredentialStatus({ secrets, env: {} }, signal);
    expect(res.requiredResolvable).toBe(true);
    expect(res.fields.map(f => f.source)).toEqual(['vault', 'vault']);
  });

  it('falls back to env when vault is empty', async () => {
    const secrets = fakeSecrets({});
    const env = { SIGNAL_SOCKET_PATH: '/run/sig.sock', SIGNAL_PHONE_NUMBER: '+15551234567' };
    const res = await channelCredentialStatus({ secrets, env }, signal);
    expect(res.requiredResolvable).toBe(true);
    expect(res.fields.map(f => f.source)).toEqual(['env', 'env']);
  });

  it('reports missing when neither vault nor env nor config provides a required key', async () => {
    const res = await channelCredentialStatus({ secrets: fakeSecrets({}), env: {} }, signal);
    expect(res.requiredResolvable).toBe(false);
    expect(res.fields.find(f => f.key === 'socket_path')!.source).toBe('missing');
  });

  it('treats caller-supplied config keys as satisfied', async () => {
    const res = await channelCredentialStatus(
      { secrets: fakeSecrets({}), env: {}, configResolvedKeys: new Set(['socket_path', 'phone_number']) },
      signal,
    );
    expect(res.requiredResolvable).toBe(true);
    expect(res.fields.map(f => f.source)).toEqual(['config', 'config']);
  });

  it('a channel with no required keys is always resolvable', async () => {
    const http: ChannelDescriptor = { name: 'http', description: '', isToggleable: false, credentialFields: [], requiredSecretKeys: [] };
    const res = await channelCredentialStatus({ secrets: fakeSecrets({}), env: {} }, http);
    expect(res.requiredResolvable).toBe(true);
    expect(res.fields).toEqual([]);
  });
});
