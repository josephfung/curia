import { describe, it, expect } from 'vitest';
import {
  messageNotFoundError,
  nylasMessageFailure,
  validateNylasMessageId,
} from '../../../../src/channels/email/nylas-message-id.js';

describe('validateNylasMessageId', () => {
  // The two malformed IDs behind every 404 in the prod audit_log window (#2083).
  it('rejects placeholder text', () => {
    expect(validateNylasMessageId('9b359f65-placeholder')).toMatch(
      /message_id "9b359f65-placeholder" is not a valid message ID: it contains placeholder text/,
    );
  });

  it('rejects a Gmail ID with a seventeenth hex digit', () => {
    expect(validateNylasMessageId('1a102a493eca2fc54')).toMatch(
      /17 hex digits, and Gmail message IDs have at most 16/,
    );
  });

  it('tells the model not to retry', () => {
    expect(validateNylasMessageId('9b359f65-placeholder')).toContain('Do not retry with this value');
  });

  it('names the field it was given', () => {
    expect(validateNylasMessageId('1a102a493eca2fc54', 'reply_to_message_id')).toMatch(/^reply_to_message_id "/);
  });

  it.each([
    ['a UUID', '3f2b8c1e-9d4a-4e6f-8a7b-1c2d3e4f5a6b', /UUID/],
    ['an RFC 822 Message-ID header', '<CAF=abc@mail.gmail.com>', /characters no mail provider uses/],
    ['text with a space', '19a2b3c4 d5e6f708', /characters no mail provider uses/],
    ['a template token', '${message_id}', /placeholder text|characters/],
    ['a hex ID of 31 digits', 'a'.repeat(31), /31 hex digits/],
  ])('rejects %s', (_label, id, problem) => {
    expect(validateNylasMessageId(id)).toMatch(problem);
  });

  it.each([
    ['a Gmail ID', '19a2b3c4d5e6f708'],
    ['an old Gmail ID with 15 digits', 'fe1b2c3d4e5f607'],
    ['a Gmail ID with surrounding whitespace', '  19a2b3c4d5e6f708 '],
    ['a Microsoft Graph ID', 'AAMkAGI2TG93AAA-bW1_ZS0xNjRiLTQ1Zj=='],
    ['a base64 EWS ID', 'AAMkADk0+OWQ2/ZTgtNmMwOC00=='],
    ['a 32-digit hash ID', '0123456789abcdef0123456789abcdef'],
    ['an IMAP UID', '48213'],
    ['a short test ID', 'msg-1'],
  ])('accepts %s', (_label, id) => {
    expect(validateNylasMessageId(id)).toBeNull();
  });
});

describe('nylasMessageFailure', () => {
  it('turns a CeoNylasClient 404 (status) into a final not-found error', () => {
    const err = Object.assign(new Error('HTTP 404'), { status: 404 });
    expect(nylasMessageFailure(err, 'm1', 'Archive failed')).toEqual({
      error: messageNotFoundError('m1'),
      errorType: 'NOT_FOUND',
    });
  });

  it('turns an SDK 404 (statusCode) into the same error', () => {
    const err = Object.assign(new Error('not found'), { statusCode: 404 });
    expect(nylasMessageFailure(err, 'm1', 'Archive failed').errorType).toBe('NOT_FOUND');
  });

  it('says not to retry the ID', () => {
    expect(messageNotFoundError('m1')).toMatch(/Message not found.*"m1".*Do not retry with this ID/);
  });

  it('marks a 429 as RATE_LIMIT and keeps its detail', () => {
    const err = Object.assign(new Error('rate limited (HTTP 429)'), { status: 429 });
    expect(nylasMessageFailure(err, 'm1', 'Archive failed')).toEqual({
      error: 'Archive failed: rate limited (HTTP 429)',
      errorType: 'RATE_LIMIT',
    });
  });

  it('passes any other failure through with its detail', () => {
    expect(nylasMessageFailure(new Error('socket hang up'), 'm1', 'Archive failed')).toEqual({
      error: 'Archive failed: socket hang up',
    });
  });
});
