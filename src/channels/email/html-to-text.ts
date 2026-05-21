/**
 * Convert HTML email body to plain text for LLM consumption.
 * Lightweight regex-based approach — handles common email HTML patterns
 * without pulling in a heavy dependency like turndown or html-to-text.
 */
export function htmlToText(html: string | undefined | null): string {
  if (!html) return '';

  let text = html;

  // Remove <style> and <script> blocks entirely (content + tags). Loop until
  // the string stops changing to prevent nested-substitution bypass: a crafted
  // input like <scri<script>X</script>pt>…<scri<script>Y</script>pt> causes the
  // g-flag replace to strip both inner blocks simultaneously, leaving the outer
  // fragments to merge into <script>…</script>. A second pass catches that.
  // \s* before the closing > handles whitespace-padded tags like </script >.
  for (let prev = ''; prev !== text; ) {
    prev = text;
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style\s*>/gi, '');
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  }

  // Convert <br> variants to newlines
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Convert block-level closing tags to newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n');

  // Convert <hr> to a separator
  text = text.replace(/<hr\s*\/?>/gi, '\n---\n');

  // Strip all remaining complete HTML tags.
  text = text.replace(/<[^>]+>/g, '');

  // Strip incomplete tags — bare <tagname without a closing > is not caught by
  // <[^>]+> above (which requires >). Loop until stable: stripping a complete
  // inner tag (above) can expose a bare <script fragment from a nested pattern,
  // so we re-run until no tag fragments remain. {0,500} caps match length to
  // prevent consuming large text bodies on inputs with a lone < far from any >.
  for (let prev = ''; prev !== text; ) {
    prev = text;
    text = text.replace(/<[a-zA-Z][^>]{0,500}/g, '');
  }

  // Decode common HTML entities.
  // Order matters: &amp; must be decoded LAST to prevent double-decoding.
  // If &amp; is decoded first, a sequence like &amp;lt; becomes &lt; and then <,
  // which would smuggle a literal < into the output (js/double-escaping).
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');

  // Collapse runs of whitespace (preserving paragraph breaks)
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n[ \t]+/g, '\n');
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}
