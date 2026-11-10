import { describe, expect, it } from 'vitest';
import { bodyEndsWithSignature, emailSignatureText } from '../../../../src/channels/email/signature.js';

// #2554: bodyEndsWithSignature alone decides whether the gateway appends the signature.
describe('bodyEndsWithSignature', () => {
  const signature = 'Nathan Curia\nOffice of the CEO';
  const BODY = 'It still just needs a date and time from you.';

  it('is true when the body ends with the exact signature', () => {
    expect(bodyEndsWithSignature(`${BODY}\n\nNathan Curia\nOffice of the CEO`, signature)).toBe(true);
  });

  it('ignores a -- delimiter, markdown emphasis, case and CRLF', () => {
    expect(bodyEndsWithSignature(`${BODY}\r\n\r\n--\r\n**Nathan Curia**\r\n*Office of the CEO*\r\n`, signature)).toBe(true);
    expect(bodyEndsWithSignature(`${BODY}\n\n__nathan curia__\noffice of the ceo`, signature)).toBe(true);
  });

  it('is false for a closing and first name alone', () => {
    expect(bodyEndsWithSignature(`${BODY}\n\nBest,\nNathan`, signature)).toBe(false);
  });

  it('is false for a first name followed by only part of the signature', () => {
    expect(bodyEndsWithSignature(`${BODY}\n\nNathan\nOffice of the CEO`, signature)).toBe(false);
  });

  it('is false when the signature appears mid-body, not at the end', () => {
    expect(bodyEndsWithSignature(`Nathan Curia\nOffice of the CEO\n\n${BODY}`, signature)).toBe(false);
  });

  it('is true when a first name precedes the full signature (second block still not added)', () => {
    expect(bodyEndsWithSignature(`${BODY}\n\nBest,\nNathan\n\nNathan Curia\nOffice of the CEO`, signature)).toBe(true);
  });

  it('is false for an empty signature', () => {
    expect(bodyEndsWithSignature(BODY, '')).toBe(false);
  });
});

describe('emailSignatureText', () => {
  it('uses the configured signature, else name and title', () => {
    expect(emailSignatureText({ displayName: 'A', title: 'B', emailSignature: ' X\nY ' })).toBe('X\nY');
    expect(emailSignatureText({ displayName: 'A', title: 'B' })).toBe('A\nB');
    expect(emailSignatureText(undefined)).toBeUndefined();
  });
});
