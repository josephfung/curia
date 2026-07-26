// src/channels/catalog.test.ts
import { describe, it, expect } from 'vitest';
import { CHANNEL_CATALOG, getChannelDescriptor } from './catalog.js';

describe('CHANNEL_CATALOG', () => {
  it('contains exactly the seven known channels', () => {
    expect(CHANNEL_CATALOG.map(c => c.name).sort()).toEqual([
      'cli', 'email', 'http', 'signal', 'slack', 'sms', 'voice',
    ]);
  });

  it('marks http and cli as non-toggleable with no credential fields', () => {
    for (const name of ['http', 'cli']) {
      const d = getChannelDescriptor(name)!;
      expect(d.isToggleable).toBe(false);
      expect(d.credentialFields).toEqual([]);
      expect(d.requiredSecretKeys).toEqual([]);
    }
  });

  it('marks email, signal, slack, sms, and voice as toggleable with required credential fields', () => {
    const email = getChannelDescriptor('email')!;
    expect(email.isToggleable).toBe(true);
    expect(email.requiredSecretKeys).toEqual(['nylas_api_key', 'nylas_grant_id', 'nylas_self_email']);

    const signal = getChannelDescriptor('signal')!;
    expect(signal.isToggleable).toBe(true);
    expect(signal.requiredSecretKeys).toEqual(['socket_path', 'phone_number']);

    const slack = getChannelDescriptor('slack')!;
    expect(slack.isToggleable).toBe(true);
    expect(slack.requiredSecretKeys).toEqual(['bot_token', 'app_token']);

    const sms = getChannelDescriptor('sms')!;
    expect(sms.isToggleable).toBe(true);
    expect(sms.requiredSecretKeys).toEqual(['api_key', 'from_number', 'webhook_public_key']);

    const voice = getChannelDescriptor('voice')!;
    expect(voice.isToggleable).toBe(true);
    expect(voice.requiredSecretKeys).toEqual([
      'livekit_url',
      'livekit_api_key',
      'livekit_api_secret',
      'deepgram_api_key',
      'cartesia_api_key',
      'cartesia_voice_id',
    ]);
    expect(voice.credentialFields.every(f => f.envFallback === undefined)).toBe(true);
  });

  it('every requiredSecretKey corresponds to a declared field', () => {
    for (const d of CHANNEL_CATALOG) {
      const fieldKeys = new Set(d.credentialFields.map(f => f.key));
      for (const req of d.requiredSecretKeys) expect(fieldKeys.has(req)).toBe(true);
    }
  });

  it('getChannelDescriptor returns undefined for unknown channels', () => {
    expect(getChannelDescriptor('telegram')).toBeUndefined();
  });
});
