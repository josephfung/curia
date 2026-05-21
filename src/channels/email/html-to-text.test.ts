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

  // ── Security: js/incomplete-multi-character-sanitization ─────────────────────
  // A single-pass replace of <script…>…</script> can be bypassed by splitting the
  // opening tag across nested inner <script> elements. The g flag replaces all
  // non-overlapping matches in the original string left-to-right; two inner blocks
  // get removed simultaneously, leaving the outer fragments to merge into <script>.
  //
  // Example:
  //   <scri<script>X</script>pt>…<scri<script>Y</script>pt>
  //   pass 1: removes <script>X</script> and <script>Y</script>
  //   result: <script>…</script>  ← bypass succeeded in single-pass approach
  //   loop:   removes <script>…</script> in the next iteration → safe
  // ─────────────────────────────────────────────────────────────────────────────

  it('strips <script> tags reconstructed by nested-substitution bypass', () => {
    // Split <script> across two inner <script> blocks so a single .replace() pass
    // removes the inner blocks and leaves the outer <script>…</script> intact.
    const payload =
      '<scri<script>X</script>pt>alert("xss")</scri<script>Y</script>pt>';
    const result = htmlToText(payload);
    expect(result).not.toContain('<script');
    expect(result).not.toContain('alert("xss")');
  });

  it('strips <style> tags reconstructed by nested-substitution bypass', () => {
    const payload =
      '<sty<style>X</style>le>body{color:red}</sty<style>Y</style>le>';
    const result = htmlToText(payload);
    expect(result).not.toContain('<style');
    expect(result).not.toContain('body{color:red}');
  });

  it('strips deeply nested <script> reconstruction attempts', () => {
    // Three levels of nesting — each loop iteration peels one layer.
    const payload =
      '<scri<scri<script>A</script>pt>B</scri<script>C</script>pt>pt>evil()</scri<script>D</script>pt>';
    const result = htmlToText(payload);
    expect(result).not.toContain('<script');
    expect(result).not.toContain('evil()');
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
