import { describe, expect, it } from 'vitest';
import {
  googleWorkspaceUrlError,
  isGoogleWorkspaceFileUrl,
} from '../../../../src/skills/_shared/google-workspace-url.js';

describe('isGoogleWorkspaceFileUrl (prompt trim PR 6)', () => {
  it.each([
    'https://docs.google.com/document/d/1AbC/edit?usp=sharing',
    'https://docs.google.com/spreadsheets/d/1AbC/edit#gid=0',
    'https://docs.google.com/presentation/d/1AbC/edit',
    'https://docs.google.com/a/example.com/document/d/1AbC/edit',
    'https://DOCS.GOOGLE.COM/document/d/1AbC/edit',
    'https://drive.google.com/file/d/1AbC/view',
    'https://drive.google.com/drive/folders/1AbC',
    'https://drive.google.com/open?id=1AbC',
    'https://sheets.google.com/',
  ])('refuses %s', (url) => {
    expect(isGoogleWorkspaceFileUrl(new URL(url))).toBe(true);
  });

  it.each([
    // Public pages the Workspace tools cannot read, or that the browser fills.
    'https://docs.google.com/forms/d/e/1FAIp/viewform',
    'https://docs.google.com/document/d/e/2PACX-1v/pub',
    'https://docs.google.com/spreadsheets/d/e/2PACX-1v/pubhtml',
    // Not Docs, Sheets or Drive.
    'https://www.google.com/search?q=docs',
    'https://mail.google.com/mail/u/0/',
    'https://example.com/docs.google.com/document/d/1AbC',
    'https://docs.google.com.example.com/document/d/1AbC',
    'https://docs.google.com/',
  ])('leaves %s', (url) => {
    expect(isGoogleWorkspaceFileUrl(new URL(url))).toBe(false);
  });

  it('names the tool and where the file opens', () => {
    const error = googleWorkspaceUrlError('web-fetch');
    expect(error).toContain('web-fetch gets a sign-in page');
    expect(error).toContain('skill-activate with skill "google-workspace"');
  });
});
