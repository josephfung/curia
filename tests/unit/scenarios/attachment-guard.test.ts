import { describe, expect, it } from 'vitest';
import { emailAttachmentRefusal } from '../../scenarios/attachment-guard.js';

const STORE = '/run/curia-tempfiles';

function attachment(fileUrl: string): Record<string, unknown> {
  return { attachments: [{ file_url: fileUrl, filename: 'deck.pdf', content_type: 'application/pdf' }] };
}

describe('emailAttachmentRefusal', () => {
  it('refuses a file_url outside the temp store and allows one inside it', () => {
    const outside = emailAttachmentRefusal(
      'email-send',
      attachment('file:///tmp/.workspace-mcp/attachments/deck.pdf'),
      STORE,
    );
    expect(outside).toBe(
      'Attachment error: Attachment path is outside the allowed temp store directory: file:///tmp/.workspace-mcp/attachments/deck.pdf',
    );
    expect(emailAttachmentRefusal(
      'email-reply',
      attachment('file:///run/curia-tempfiles/5b1e7c3a.pdf'),
      STORE,
    )).toBeUndefined();
  });

  it('refuses a path that escapes the store with ..', () => {
    const message = emailAttachmentRefusal(
      'email-send',
      attachment('file:///run/curia-tempfiles/../etc/passwd'),
      STORE,
    );
    expect(message).toContain('outside the allowed temp store directory');
  });

  it('refuses a bare workspace-mcp path with production\'s file:// error', () => {
    const message = emailAttachmentRefusal(
      'email-reply',
      attachment('/tmp/.workspace-mcp/attachments/deck.pdf'),
      STORE,
    );
    expect(message).toBe(
      'Attachment error: Invalid attachment file_url "/tmp/.workspace-mcp/attachments/deck.pdf": must start with file://',
    );
  });

  it('ignores sends with no attachments and tools that do not attach files', () => {
    expect(emailAttachmentRefusal('email-send', {}, STORE)).toBeUndefined();
    expect(emailAttachmentRefusal('email-send', { attachments: [] }, STORE)).toBeUndefined();
    expect(emailAttachmentRefusal('signal-send', attachment('file:///etc/passwd'), STORE)).toBeUndefined();
  });

  it('refuses when any attachment in the list is outside the store', () => {
    const message = emailAttachmentRefusal('email-send', {
      attachments: [
        { file_url: 'file:///run/curia-tempfiles/ok.pdf', filename: 'ok.pdf', content_type: 'application/pdf' },
        { file_url: 'file:///tmp/.workspace-mcp/attachments/deck.pdf', filename: 'deck.pdf', content_type: 'application/pdf' },
      ],
    }, STORE);
    expect(message).toContain('deck.pdf');
  });
});
