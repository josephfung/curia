// The retired flat keys' write rule (#2475, review m8): vault PUT and secret capture both call
// retiredFlatKeyRefusal, so this is the wiring index.ts and the vault route rely on.
import { describe, it, expect, vi } from 'vitest';
import { FLAT_KEYS_MANAGED_MESSAGE, PER_MAILBOX_GRANT_MANAGED_MESSAGE, retiredFlatKeyRefusal } from '../../../src/principal-mailboxes/secrets.js';

describe('retiredFlatKeyRefusal', () => {
  it.each(['ceo_nylas_grant_id', 'ceo_self_email'])('refuses %s outside the deferred fallback', async (name) => {
    expect(await retiredFlatKeyRefusal(name, async () => false)).toBe(FLAT_KEYS_MANAGED_MESSAGE);
    expect(await retiredFlatKeyRefusal(name, undefined)).toBe(FLAT_KEYS_MANAGED_MESSAGE);
  });

  it.each(['ceo_nylas_grant_id', 'ceo_self_email'])('allows %s while the deferred fallback is active', async (name) => {
    expect(await retiredFlatKeyRefusal(name, async () => true)).toBeNull();
  });

  it('never asks about the fallback for any other name', async () => {
    const check = vi.fn(async () => false);
    expect(await retiredFlatKeyRefusal('anthropic_api_key', check)).toBeNull();
    expect(await retiredFlatKeyRefusal('principal.mailbox.work.nylas_grant_id', check)).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it('a failing fallback check throws (the caller answers 500), never allows the write', async () => {
    await expect(retiredFlatKeyRefusal('ceo_self_email', async () => { throw new Error('db down'); })).rejects.toThrow('db down');
  });
});

// Both messages send the operator to the console page that manages the mailboxes (#2475, R79).
describe('mailbox refusal messages', () => {
  it.each([FLAT_KEYS_MANAGED_MESSAGE, PER_MAILBOX_GRANT_MANAGED_MESSAGE])('message %# names Settings → Personality → Email & Calendar', (message) => {
    expect(message).toContain('Settings → Personality → Email & Calendar');
    expect(message).not.toContain('Channels → Email');
  });
});
