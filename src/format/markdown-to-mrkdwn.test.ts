import { describe, it, expect } from 'vitest';
import { markdownToMrkdwn, inlineMarkdownToMrkdwn } from '../../src/format/markdown-to-mrkdwn.js';

describe('markdownToMrkdwn', () => {
  it('converts bold and italic', () => {
    expect(markdownToMrkdwn('**bold** and *italic*')).toBe('*bold* and _italic_');
  });

  it('converts markdown links to mrkdwn', () => {
    expect(markdownToMrkdwn('See [docs](https://example.com)')).toBe(
      'See <https://example.com|docs>',
    );
  });

  it('converts headings to bold lines', () => {
    expect(markdownToMrkdwn('## Next steps')).toBe('*Next steps*');
  });

  it('converts unordered lists to bullets', () => {
    expect(markdownToMrkdwn('- one\n- two')).toBe('• one\n• two');
  });

  it('leaves fenced code blocks alone', () => {
    const input = 'before\n```\n**not bold**\n```\nafter';
    expect(markdownToMrkdwn(input)).toBe(input);
  });

  it('preserves inline code markers', () => {
    expect(inlineMarkdownToMrkdwn('use `**raw**` please')).toBe('use `**raw**` please');
  });
});
