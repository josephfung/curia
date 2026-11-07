import { describe, it, expect } from 'vitest';
import { markdownToMrkdwn, inlineMarkdownToMrkdwn } from '../../../src/format/markdown-to-mrkdwn.js';

describe('markdownToMrkdwn', () => {
  it('converts bold and italic', () => {
    expect(markdownToMrkdwn('**bold** and *italic*')).toBe('*bold* and _italic_');
  });

  it('converts markdown links to mrkdwn', () => {
    expect(markdownToMrkdwn('See [docs](https://example.com)')).toBe(
      'See <https://example.com|docs>',
    );
  });

  it.each([
    ['unclosed link openers', '[a'],
    ['unclosed link destinations', '[a]('],
    ['host-like link destinations', '[a:]('],
    ['escaped brackets', '[\\['],
    ['escaped bracket run', '\\['],
  ])('converts links after a long run of %s in linear time', (_name, unit) => {
    const started = performance.now();
    const out = markdownToMrkdwn(`See [docs](https://example.com) ${unit.repeat(50_000)}`);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(out.startsWith('See <https://example.com|docs> ')).toBe(true);
    const after = markdownToMrkdwn(`${unit.repeat(50_000)} [docs](https://example.com)`);
    expect(after.endsWith(' <https://example.com|docs>')).toBe(true);
  });

  it('converts links with escaped brackets or IPv6 hosts', () => {
    expect(markdownToMrkdwn('[read \\[](https://example.com)')).toBe('<https://example.com|read [>');
    expect(markdownToMrkdwn('[a \\[b\\]](https://example.com)')).toBe('<https://example.com|a [b]>');
    expect(markdownToMrkdwn('[site](https://[::1]/)')).toBe('<https://[::1]/|site>');
    expect(markdownToMrkdwn('[site](http://[2001:db8::1]:8080/x)')).toBe('<http://[2001:db8::1]:8080/x|site>');
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
