import { describe, it, expect } from 'vitest';
import { parseAttachmentInputs } from './parse-attachments.js';

describe('parseAttachmentInputs', () => {
  it('returns empty array for undefined', () => {
    expect(parseAttachmentInputs(undefined)).toEqual([]);
  });

  it('returns empty array for null', () => {
    expect(parseAttachmentInputs(null)).toEqual([]);
  });

  it('returns an error string when input is not an array', () => {
    const result = parseAttachmentInputs('not-an-array');
    expect(typeof result).toBe('string');
    expect(result).toContain('array');
  });

  it('returns an error string when an element is not an object', () => {
    const result = parseAttachmentInputs(['string-element']);
    expect(typeof result).toBe('string');
    expect(result).toContain('attachments[0]');
  });

  it('returns an error string when file_url is missing', () => {
    const result = parseAttachmentInputs([{ filename: 'a.pdf', content_type: 'application/pdf' }]);
    expect(typeof result).toBe('string');
    expect(result).toContain('file_url');
  });

  it('returns an error string when filename is missing', () => {
    const result = parseAttachmentInputs([{ file_url: 'file:///tmp/a.pdf', content_type: 'application/pdf' }]);
    expect(typeof result).toBe('string');
    expect(result).toContain('filename');
  });

  it('returns an error string when content_type is missing', () => {
    const result = parseAttachmentInputs([{ file_url: 'file:///tmp/a.pdf', filename: 'a.pdf' }]);
    expect(typeof result).toBe('string');
    expect(result).toContain('content_type');
  });

  it('returns a valid OutboundAttachmentInput[] for well-formed input', () => {
    const result = parseAttachmentInputs([
      { file_url: 'file:///tmp/a.pdf', filename: 'a.pdf', content_type: 'application/pdf' },
      { file_url: 'file:///tmp/b.png', filename: 'b.png', content_type: 'image/png' },
    ]);
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result).toHaveLength(2);
      expect(result[0]!).toEqual({ fileUrl: 'file:///tmp/a.pdf', filename: 'a.pdf', contentType: 'application/pdf' });
      expect(result[1]!).toEqual({ fileUrl: 'file:///tmp/b.png', filename: 'b.png', contentType: 'image/png' });
    }
  });

  it('returns empty array for an empty array input', () => {
    expect(parseAttachmentInputs([])).toEqual([]);
  });

  it('errors on second element when first is valid but second is malformed', () => {
    const result = parseAttachmentInputs([
      { file_url: 'file:///tmp/a.pdf', filename: 'a.pdf', content_type: 'application/pdf' },
      { file_url: 'file:///tmp/b.pdf', filename: '', content_type: 'application/pdf' },
    ]);
    expect(typeof result).toBe('string');
    expect(result).toContain('attachments[1]');
  });
});
