import { describe, it, expect } from 'vitest';
import { htmlToText } from '../../../../src/channels/email/html-to-text.js';

describe('htmlToText', () => {
  it('returns plain text unchanged', () => {
    expect(htmlToText('Hello world')).toBe('Hello world');
  });

  it('strips HTML tags', () => {
    expect(htmlToText('<p>Hello</p><p>World</p>')).toContain('Hello');
    expect(htmlToText('<p>Hello</p><p>World</p>')).toContain('World');
    expect(htmlToText('<p>Hello</p><p>World</p>')).not.toContain('<p>');
  });

  it('converts <br> to newlines', () => {
    expect(htmlToText('Line 1<br>Line 2')).toContain('Line 1\nLine 2');
  });

  it('converts block elements to newlines', () => {
    const result = htmlToText('<div>Block 1</div><div>Block 2</div>');
    expect(result).toContain('Block 1');
    expect(result).toContain('Block 2');
  });

  it('strips <style> and <script> blocks entirely', () => {
    const html = '<style>.foo { color: red; }</style><p>Content</p><script>alert(1)</script>';
    const result = htmlToText(html);
    expect(result).toContain('Content');
    expect(result).not.toContain('color');
    expect(result).not.toContain('alert');
  });

  it('decodes common HTML entities', () => {
    expect(htmlToText('&amp; &lt; &gt; &quot; &#39;')).toBe('& < > " \'');
  });

  it('collapses excessive whitespace', () => {
    const result = htmlToText('  Hello   \n\n\n   World  ');
    expect(result).toBe('Hello\n\nWorld');
  });

  it('handles empty/undefined input', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText(undefined as unknown as string)).toBe('');
  });

  // ── Security: js/bad-tag-filter ─────────────────────────────────────────────

  it('strips <script> blocks whose closing tag has trailing whitespace (</script >)', () => {
    // A closing tag </script > (space before >) was not matched by the original regex,
    // allowing script content to survive the strip.
    const html = 'before <script>evil()</script > after';
    const result = htmlToText(html);
    expect(result).not.toContain('evil');
    expect(result).toContain('before');
    expect(result).toContain('after');
  });

  it('strips <style> blocks whose closing tag has trailing whitespace (</style >)', () => {
    const html = '<style>.x { color: red; }</style > <p>Content</p>';
    const result = htmlToText(html);
    expect(result).not.toContain('color');
    expect(result).toContain('Content');
  });

  // ── Security: js/double-escaping ────────────────────────────────────────────

  it('does not double-decode &amp;lt; into a literal <', () => {
    // With the original ordering (&amp; decoded first, then &lt;), the sequence
    // &amp;lt; → &lt; → < — a double-decode that lets attackers smuggle < into output.
    // Correct behaviour: &amp;lt; → &lt; (stop there).
    const result = htmlToText('&amp;lt;');
    expect(result).toBe('&lt;');
  });

  it('does not double-decode &amp;gt; into a literal >', () => {
    const result = htmlToText('&amp;gt;');
    expect(result).toBe('&gt;');
  });
});
