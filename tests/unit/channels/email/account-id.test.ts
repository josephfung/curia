import { describe, it, expect } from 'vitest';
import { emailAccountIdFromInput, replyToMessageIdFromInput } from '../../../../src/channels/email/account-id.js';

describe('emailAccountIdFromInput', () => {
  it.each([
    [{}, undefined],
    [{ account: '' }, undefined],
    [{ account: '   ' }, undefined],
    [{ account: ' personal ' }, 'personal'],
    [{ account: null }, undefined],
    [{ account: 1 }, undefined],
    [{ account: { name: 'personal' } }, undefined],
  ] as const)('parses %j as %j', (input, expected) => {
    expect(emailAccountIdFromInput(input as Record<string, unknown>)).toBe(expected);
  });
});

describe('replyToMessageIdFromInput', () => {
  it.each([
    [{}, undefined],
    [{ reply_to_message_id: '' }, undefined],
    [{ reply_to_message_id: '   ' }, undefined],
    [{ reply_to_message_id: '  msg-1  ' }, 'msg-1'],
    [{ reply_to_message_id: 12 }, undefined],
    [{ reply_to_message_id: null }, undefined],
  ] as const)('parses %j as %j', (input, expected) => {
    expect(replyToMessageIdFromInput(input as Record<string, unknown>)).toBe(expected);
  });
});
