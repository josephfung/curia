import { describe, it, expect, vi } from 'vitest';
import {
  resolveAttachment,
  formatAttachmentListing,
  attachmentSelectorPresent,
  type ResolvableAttachment,
} from './resolve-attachment.js';
import {
  DMARC_REAL_ATTACHMENT_ID,
  DMARC_CORRUPTED_ATTACHMENT_ID,
  DMARC_FILENAME,
} from './__fixtures__/resolve-attachment.js';
import type { Logger } from '../../src/logger.js';

function makeLog(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function att(
  id: string,
  filename: string,
  size = 814,
  contentType = 'application/zip',
): ResolvableAttachment {
  return { id, filename, contentType, size };
}

describe('attachmentSelectorPresent', () => {
  it('is false when both are missing or whitespace', () => {
    expect(attachmentSelectorPresent({})).toBe(false);
    expect(attachmentSelectorPresent({ attachmentId: '  ', filename: '  ' })).toBe(false);
  });

  it('is true when either selector is non-empty after trim', () => {
    expect(attachmentSelectorPresent({ attachmentId: 'att-1' })).toBe(true);
    expect(attachmentSelectorPresent({ filename: 'a.pdf' })).toBe(true);
  });
});

describe('resolveAttachment', () => {
  it('resolves by exact ID without warning', () => {
    const log = makeLog();
    const attachment = att(DMARC_REAL_ATTACHMENT_ID, DMARC_FILENAME);
    const result = resolveAttachment({
      attachments: [attachment],
      attachmentId: DMARC_REAL_ATTACHMENT_ID,
      messageId: '1a16d5ec7cd97903',
      log,
      logContext: 'test',
    });

    expect(result).toEqual({ ok: true, attachment, resolvedBy: 'id' });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('falls back to sole_attachment for the 2026-10-24 corrupted ID fixture', () => {
    const log = makeLog();
    const attachment = att(DMARC_REAL_ATTACHMENT_ID, DMARC_FILENAME);
    const result = resolveAttachment({
      attachments: [attachment],
      attachmentId: DMARC_CORRUPTED_ATTACHMENT_ID,
      messageId: '1a16d5ec7cd97903',
      log,
      logContext: 'test',
    });

    expect(result).toEqual({
      ok: true,
      attachment,
      resolvedBy: 'sole_attachment',
    });
    expect(log.warn).toHaveBeenCalledOnce();
    expect(vi.mocked(log.warn).mock.calls[0]![0]).toMatchObject({
      requestedAttachmentId: DMARC_CORRUPTED_ATTACHMENT_ID,
      resolvedAttachmentId: DMARC_REAL_ATTACHMENT_ID,
      resolvedBy: 'sole_attachment',
    });
  });

  it('warns when resolving by filename after an ID miss', () => {
    const log = makeLog();
    const wanted = att('att-a', 'report.pdf', 100, 'application/pdf');
    const other = att('att-b', 'photo.jpg', 200, 'image/jpeg');
    const result = resolveAttachment({
      attachments: [wanted, other],
      attachmentId: 'garble',
      filename: 'report.pdf',
      messageId: 'msg-1',
      log,
      logContext: 'test',
    });

    expect(result).toEqual({ ok: true, attachment: wanted, resolvedBy: 'filename' });
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.info).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn).mock.calls[0]![0]).toMatchObject({
      requestedAttachmentId: 'garble',
      resolvedAttachmentId: 'att-a',
      filename: 'report.pdf',
      resolvedBy: 'filename',
    });
  });

  it('resolves by filename at info (not warn) when no ID is given', () => {
    const log = makeLog();
    const wanted = att('att-a', 'report.pdf');
    const other = att('att-b', 'photo.jpg');
    const result = resolveAttachment({
      attachments: [wanted, other],
      filename: 'report.pdf',
      messageId: 'msg-1',
      log,
      logContext: 'test',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedBy).toBe('filename');
      expect(result.attachment.id).toBe('att-a');
    }
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledOnce();
  });

  it('uses attachment_id when it matches even if filename names a different attachment', () => {
    const log = makeLog();
    const a = att('att-a', 'report.pdf', 100, 'application/pdf');
    const b = att('att-b', 'photo.jpg', 200, 'image/jpeg');
    const result = resolveAttachment({
      attachments: [a, b],
      attachmentId: 'att-a',
      filename: 'photo.jpg',
      messageId: 'msg-1',
      log,
      logContext: 'test',
    });

    expect(result).toEqual({ ok: true, attachment: a, resolvedBy: 'id' });
    expect(log.warn).toHaveBeenCalledOnce();
    expect(vi.mocked(log.warn).mock.calls[0]![1]).toMatch(/disagree/);
  });

  it('fails with listing and warns on selector miss for a multi-attachment message', () => {
    const log = makeLog();
    const a = att('att-a', 'report.pdf', 100, 'application/pdf');
    const b = att('att-b', 'photo.jpg', 200, 'image/jpeg');
    const result = resolveAttachment({
      attachments: [a, b],
      attachmentId: 'wrong',
      messageId: 'msg-1',
      log,
      logContext: 'test',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('wrong');
      expect(result.error).toContain('msg-1');
      expect(result.error).toContain('report.pdf');
      expect(result.error).toContain('photo.jpg');
      expect(result.error).toContain('att-a');
      expect(result.error).toContain('content_type=');
      expect(result.error).toContain('size=100');
    }
    expect(log.warn).toHaveBeenCalledOnce();
    expect(vi.mocked(log.warn).mock.calls[0]![0]).toMatchObject({
      requestedAttachmentId: 'wrong',
      attachmentCount: 2,
      resolvedBy: 'none',
    });
  });

  it('fails when filename is ambiguous and tells the model to copy the listed id exactly', () => {
    const log = makeLog();
    const a = att('att-a', 'dup.pdf', 10, 'application/pdf');
    const b = att('att-b', 'dup.pdf', 20, 'application/pdf');
    const result = resolveAttachment({
      attachments: [a, b],
      attachmentId: 'wrong',
      filename: 'dup.pdf',
      messageId: 'msg-1',
      log,
      logContext: 'test',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/matches 2 attachments/i);
      expect(result.error).toMatch(/copy the id exactly/i);
      expect(result.error).toContain('att-a');
      expect(result.error).toContain('att-b');
      expect(result.error).toContain('content_type=');
    }
  });

  it('does not sole-fallback when an explicit filename misses; warns with resolvedBy none', () => {
    const log = makeLog();
    const attachment = att(DMARC_REAL_ATTACHMENT_ID, DMARC_FILENAME);
    const result = resolveAttachment({
      attachments: [attachment],
      attachmentId: DMARC_CORRUPTED_ATTACHMENT_ID,
      filename: 'other.zip',
      messageId: 'msg-1',
      log,
      logContext: 'test',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('other.zip');
      expect(result.error).toContain(DMARC_FILENAME);
    }
    expect(log.warn).toHaveBeenCalledOnce();
    expect(vi.mocked(log.warn).mock.calls[0]![0]).toMatchObject({
      requestedAttachmentId: DMARC_CORRUPTED_ATTACHMENT_ID,
      requestedFilename: 'other.zip',
      attachmentCount: 1,
      resolvedBy: 'none',
    });
  });

  it('matches when the model sends a trimmed name and the attachment has padded whitespace', () => {
    const log = makeLog();
    const padded = att('att-a', '  report.pdf  ', 100, 'application/pdf');
    const other = att('att-b', 'photo.jpg', 200, 'image/jpeg');
    const result = resolveAttachment({
      attachments: [padded, other],
      filename: 'report.pdf',
      messageId: 'msg-1',
      log,
      logContext: 'test',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attachment.id).toBe('att-a');
      expect(result.resolvedBy).toBe('filename');
    }
  });

  it('matches when the model copies a padded filename exactly from the listing', () => {
    const log = makeLog();
    const padded = att('att-a', '  report.pdf  ', 100, 'application/pdf');
    const other = att('att-b', 'photo.jpg', 200, 'image/jpeg');
    const result = resolveAttachment({
      attachments: [padded, other],
      filename: '  report.pdf  ',
      messageId: 'msg-1',
      log,
      logContext: 'test',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attachment.id).toBe('att-a');
      expect(result.resolvedBy).toBe('filename');
    }
  });

  it('prefers exact filename match over a trimmed near-collision', () => {
    const log = makeLog();
    const exact = att('att-exact', 'a.pdf', 10, 'application/pdf');
    const padded = att('att-padded', 'a.pdf ', 20, 'application/pdf');
    const result = resolveAttachment({
      attachments: [exact, padded],
      filename: 'a.pdf',
      messageId: 'msg-1',
      log,
      logContext: 'test',
    });

    expect(result).toEqual({ ok: true, attachment: exact, resolvedBy: 'filename' });
  });

  it('filename match is case-sensitive', () => {
    const log = makeLog();
    const a = att('att-a', 'Report.pdf');
    const b = att('att-b', 'photo.jpg');
    const result = resolveAttachment({
      attachments: [a, b],
      filename: 'report.pdf',
      messageId: 'msg-1',
      log,
      logContext: 'test',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Report.pdf');
    }
    expect(log.warn).toHaveBeenCalledOnce();
    expect(vi.mocked(log.warn).mock.calls[0]![0]).toMatchObject({
      requestedFilename: 'report.pdf',
      resolvedBy: 'none',
    });
  });

  describe('secret-redacted filenames (#2430)', () => {
    // Mimecast DMARC reports end in a 32+ hex report ID. sanitizeOutput's long-hex
    // rule shows the model this name with the ID replaced by [REDACTED].
    const MIMECAST_REAL =
      'mimecast.org!example.com!1793232000!1793318399!0123456789abcdef0123456789abcdef.xml.gz';
    const MIMECAST_SHOWN = 'mimecast.org!example.com!1793232000!1793318399![REDACTED].xml.gz';

    it('resolves the filename the model was shown back to the real attachment', () => {
      const log = makeLog();
      const report = att('att-mime', MIMECAST_REAL, 682, 'application/gzip');
      const other = att('att-other', 'notes.txt', 10, 'text/plain');
      const result = resolveAttachment({
        attachments: [report, other],
        filename: MIMECAST_SHOWN,
        messageId: 'msg-1',
        log,
        logContext: 'test',
      });

      expect(result).toEqual({ ok: true, attachment: report, resolvedBy: 'filename' });
      expect(log.warn).not.toHaveBeenCalled();
      expect(vi.mocked(log.info).mock.calls[0]![0]).toMatchObject({
        resolvedAttachmentId: 'att-mime',
        matchedRedactedFilename: true,
      });
    });

    it('refuses to pick when the redacted name matches more than one attachment', () => {
      const log = makeLog();
      const a = att('att-a', MIMECAST_REAL, 682, 'application/gzip');
      const b = att(
        'att-b',
        MIMECAST_REAL.replace('0123456789abcdef0123456789abcdef', 'fedcba9876543210fedcba9876543210'),
        683,
        'application/gzip',
      );
      const result = resolveAttachment({
        attachments: [a, b],
        filename: MIMECAST_SHOWN,
        messageId: 'msg-1',
        log,
        logContext: 'test',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/matches 2 attachments/i);
        expect(result.error).toMatch(/copy the id exactly/i);
      }
    });

    it('prefers an attachment literally named with the marker over a redacted look-alike', () => {
      const log = makeLog();
      const literal = att('att-literal', MIMECAST_SHOWN, 10, 'application/gzip');
      const real = att('att-real', MIMECAST_REAL, 682, 'application/gzip');
      const result = resolveAttachment({
        attachments: [real, literal],
        filename: MIMECAST_SHOWN,
        messageId: 'msg-1',
        log,
        logContext: 'test',
      });

      expect(result).toEqual({ ok: true, attachment: literal, resolvedBy: 'filename' });
    });

    it('does not treat a redacted name as matching an attachment with different visible parts', () => {
      const log = makeLog();
      const report = att('att-mime', MIMECAST_REAL, 682, 'application/gzip');
      const other = att('att-other', 'notes.txt', 10, 'text/plain');
      const result = resolveAttachment({
        attachments: [report, other],
        filename: 'mimecast.org!example.com![PHONE]![PHONE]![REDACTED].xml.gz',
        messageId: 'msg-1',
        log,
        logContext: 'test',
      });

      expect(result.ok).toBe(false);
    });
  });

  describe('retry hint on a miss', () => {
    const a = att('att-a', 'report.pdf', 100, 'application/pdf');
    const b = att('att-b', 'photo.jpg', 200, 'image/jpeg');

    it('steers a filename miss to attachment_id, not another filename', () => {
      const result = resolveAttachment({
        attachments: [a, b],
        filename: 'reprot.pdf',
        messageId: 'msg-1',
        log: makeLog(),
        logContext: 'test',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/retry with attachment_id copied exactly/i);
        expect(result.error).not.toMatch(/filename \(preferred\)/i);
      }
    });

    it('steers to attachment_id when both the id and the filename missed', () => {
      const result = resolveAttachment({
        attachments: [a, b],
        attachmentId: 'garble',
        filename: 'reprot.pdf',
        messageId: 'msg-1',
        log: makeLog(),
        logContext: 'test',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/retry with attachment_id copied exactly/i);
        expect(result.error).not.toMatch(/filename \(preferred\)/i);
      }
    });

    it('keeps recommending filename after an id-only miss', () => {
      const result = resolveAttachment({
        attachments: [a, b],
        attachmentId: 'garble',
        messageId: 'msg-1',
        log: makeLog(),
        logContext: 'test',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/pass filename \(preferred\)/i);
      }
    });
  });

  it('returns a dedicated error when the message has no attachments', () => {
    const log = makeLog();
    const result = resolveAttachment({
      attachments: [],
      attachmentId: 'any',
      messageId: 'msg-empty',
      log,
      logContext: 'test',
    });

    expect(result).toEqual({
      ok: false,
      error: 'Message msg-empty has no attachments — check message_id.',
    });
  });
});

describe('formatAttachmentListing', () => {
  it('describes an empty attachment list', () => {
    expect(formatAttachmentListing([])).toBe('Message has no attachments.');
  });

  it('lists filename, content_type, size, and id per attachment', () => {
    const listing = formatAttachmentListing([
      att('att-1', 'a.pdf', 10, 'application/pdf'),
      att('att-2', 'b.png', 20, 'image/png'),
    ]);
    expect(listing).toContain('filename="a.pdf" content_type="application/pdf" size=10 id=att-1');
    expect(listing).toContain('filename="b.png" content_type="image/png" size=20 id=att-2');
  });
});
