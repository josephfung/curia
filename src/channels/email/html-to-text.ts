/**
 * Convert HTML email body to plain text for LLM consumption.
 * Lightweight regex-based approach — handles common email HTML patterns
 * without pulling in a heavy dependency like turndown or html-to-text.
 */
export function htmlToText(html: string | undefined | null): string {
  if (!html) return '';

  let text = html;

  // Remove <style> and <script> blocks entirely (content + tags).
  // \s* before the closing > handles whitespace-padded closing tags like </script >
  // which the original pattern (</script>) did not match (js/bad-tag-filter).
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script\s*>/gi, '');

  // Convert <br> variants to newlines
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Convert block-level closing tags to newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n');

  // Convert <hr> to a separator
  text = text.replace(/<hr\s*\/?>/gi, '\n---\n');

  // Strip all remaining complete HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Strip incomplete tags — bare <tagname without a closing > is not caught by <[^>]+>
  // above (which requires >). Entity decoding happens below, so any < remaining at this
  // point must be from an incomplete tag in the original HTML source.
  // (js/incomplete-multi-character-sanitization)
  text = text.replace(/<[a-zA-Z][^>]*/g, '');

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
