/**
 * Convert HTML email body to plain text for LLM consumption.
 * Lightweight regex-based approach — handles common email HTML patterns
 * without pulling in a heavy dependency like turndown or html-to-text.
 */
export function htmlToText(html: string | undefined | null): string {
  if (!html) return '';

  let text = html;

  // Remove <style> and <script> blocks entirely (content + tags)
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');

  // Convert <br> variants to newlines
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Convert block-level closing tags to newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n');

  // Convert <hr> to a separator
  text = text.replace(/<hr\s*\/?>/gi, '\n---\n');

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');

  // Collapse runs of whitespace (preserving paragraph breaks)
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n[ \t]+/g, '\n');
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}
