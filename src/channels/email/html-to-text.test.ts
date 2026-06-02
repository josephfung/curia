import { describe, it, expect } from 'vitest';
import { htmlToText } from './html-to-text.js';

describe('htmlToText', () => {
  it('returns empty string for null/undefined input', () => {
    expect(htmlToText(null)).toBe('');
    expect(htmlToText(undefined)).toBe('');
    expect(htmlToText('')).toBe('');
  });

  it('strips <script> blocks and their content', () => {
    expect(htmlToText('<p>Hello</p><script>evil()</script><p>World</p>')).toBe('Hello\nWorld');
  });

  it('strips <style> blocks and their content', () => {
    expect(htmlToText('<style>body{color:red}</style><p>Hello</p>')).toBe('Hello');
  });

  it('strips <script> blocks with whitespace-padded closing tags (</script >)', () => {
    expect(htmlToText('<p>Safe</p><script>evil()</script ><p>After</p>')).toBe('Safe\nAfter');
  });

  // ── Security: nested-substitution bypass (parser behavior) ──────────────────
  // The nested-substitution bypass (`<scri<script>X</script>pt>…`) was crafted
  // to exploit single-pass regex sanitizers. A proper HTML parser handles it
  // differently: it correctly identifies and removes the inner <script>X</script>
  // elements, leaving the malformed outer fragments (`<scri` and `pt>`) as literal
  // text nodes. After generic tag stripping, any assembled tag-like patterns are
  // removed but content between them may remain as literal characters in the
  // plain-text output — this is NOT an XSS risk because the output is plain text
  // consumed by an LLM, never rendered as HTML.
  // ─────────────────────────────────────────────────────────────────────────────

  it('strips inner <script> elements from nested-substitution bypass payload', () => {
    // The parser removes the real <script>X</script> and <script>Y</script>
    // elements. The outer malformed fragments (<scri, pt>) are literal text.
    // After generic tag stripping, assembled <script> tag characters are gone.
    const payload =
      '<scri<script>X</script>pt>alert("xss")</scri<script>Y</script>pt>';
    const result = htmlToText(payload);
    expect(result).not.toContain('<script'); // tag characters are stripped
    expect(result).not.toContain('X');       // inner script content is removed
    expect(result).not.toContain('Y');       // inner script content is removed
  });

  it('strips inner <style> elements from nested-substitution bypass payload', () => {
    const payload =
      '<sty<style>X</style>le>body{color:red}</sty<style>Y</style>le>';
    const result = htmlToText(payload);
    expect(result).not.toContain('<style'); // tag characters are stripped
    expect(result).not.toContain('X');      // inner style content is removed
    expect(result).not.toContain('Y');      // inner style content is removed
  });

  it('strips inner <script> elements from deeply nested reconstruction payload', () => {
    const payload =
      '<scri<scri<script>A</script>pt>B</scri<script>C</script>pt>pt>evil()</scri<script>D</script>pt>';
    const result = htmlToText(payload);
    expect(result).not.toContain('<script'); // tag characters are stripped
    expect(result).not.toContain('A');       // inner script content is removed
    expect(result).not.toContain('C');       // inner script content is removed
    expect(result).not.toContain('D');       // inner script content is removed
  });

  // ── Security: js/bad-tag-filter (CodeQL #41) ─────────────────────────────────
  // Regex-based script/style stripping can be bypassed when the script body
  // contains a string literal that looks like a closing tag with attributes.
  // The non-greedy [\s\S]*? matches the FIRST occurrence of </script[^>]*>,
  // which is the fake one inside the string — not the real end of the block.
  // The outer </script> is then left in the document and stripped only as a
  // generic tag, while the content between the two candidates leaks through.
  //
  // Example: <script>var x = "</script type=text>"; alert(1);</script>
  //   regex match: <script>var x = "</script type=text>
  //   residual:    "; alert(1);</script>  ← content between fake/real close
  //   generic strip removes </script> → "; alert(1);"   ← BYPASS SUCCEEDED
  // ─────────────────────────────────────────────────────────────────────────────

  it('strips <script> block whose body contains a fake closing tag with attributes', () => {
    // The regex uses non-greedy matching, so </script type=text> inside the
    // script body terminates the match prematurely, leaking " alert(1);" into
    // the output. A proper HTML parser follows the spec: only </script> (no
    // attributes) ends a script block.
    const payload = '<p>Safe</p><script>var x = "</script type=text>"; alert(1);</script><p>After</p>';
    const result = htmlToText(payload);
    expect(result).not.toContain('alert(1)');
    expect(result).toContain('Safe');
    expect(result).toContain('After');
  });

  it('converts <br> to newlines', () => {
    expect(htmlToText('Line1<br>Line2<br/>Line3')).toBe('Line1\nLine2\nLine3');
  });

  it('converts block-level closing tags to newlines', () => {
    expect(htmlToText('<p>First</p><p>Second</p>')).toBe('First\nSecond');
  });

  it('decodes common HTML entities (preserving order — &amp; last)', () => {
    expect(htmlToText('&lt;tag&gt; &amp; &quot;quote&quot; &#39;apos&#39; &nbsp;space')).toBe(
      '<tag> & "quote" \'apos\' space',
    );
  });

  it('does not double-decode &amp;lt; into a literal <', () => {
    // If &amp; is decoded before &lt;, &amp;lt; → &lt; → <, smuggling a literal <.
    // Correct order: &lt; first, then &amp; last.
    expect(htmlToText('&amp;lt;')).toBe('&lt;');
  });

  it('collapses runs of whitespace', () => {
    expect(htmlToText('<p>Hello   World</p>')).toBe('Hello World');
  });

  it('returns the plain-text content of a realistic email body', () => {
    const html = `
      <html><body>
        <style>.hide{display:none}</style>
        <h1>Invoice #123</h1>
        <p>Dear Customer,</p>
        <p>Your invoice for <strong>$50.00</strong> is attached.</p>
        <script>track()</script>
        <p>Thanks!</p>
      </body></html>
    `;
    const result = htmlToText(html);
    expect(result).toContain('Invoice #123');
    expect(result).toContain('Dear Customer');
    expect(result).toContain('$50.00');
    expect(result).toContain('Thanks!');
    expect(result).not.toContain('track()');
    expect(result).not.toContain('.hide');
    expect(result).not.toContain('<script');
    expect(result).not.toContain('<style');
  });
});
