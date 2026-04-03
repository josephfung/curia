// markdown-to-html.ts — converts LLM-generated markdown email bodies to HTML.
//
// LLMs write email bodies in markdown (bold, bullets, paragraphs). When Nylas
// sends a plaintext body, email clients collapse whitespace and show raw **bold**
// markers. By converting to HTML first, recipients get properly formatted emails.
//
// This is intentionally a focused converter, not a full markdown spec:
// it handles only the patterns that appear in LLM-generated emails.

/**
 * Convert a markdown-formatted string into an HTML email body.
 *
 * Handles:
 *   - Paragraphs (blank lines → <p> blocks)
 *   - Unordered lists (lines starting with "- " or "* ")
 *   - Bold (**text** or __text__)
 *   - Italic (*text* or _text_)
 *   - Inline code (`code`)
 *   - Horizontal rules (--- or ***)
 *   - Plain line breaks within paragraphs
 */
export function markdownToHtml(markdown: string): string {
  // Normalise line endings
  const text = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Split into blocks separated by one or more blank lines
  const rawBlocks = text.split(/\n{2,}/);

  const htmlBlocks: string[] = rawBlocks.map((block) => {
    const trimmed = block.trim();
    if (trimmed === '') return '';

    // Horizontal rule: a line that is only dashes or asterisks (3+)
    if (/^[-*]{3,}$/.test(trimmed)) {
      return '<hr>';
    }

    // Unordered list block: every line starts with "- " or "* "
    const lines = trimmed.split('\n');
    const isListBlock = lines.every((l) => /^[-*]\s+/.test(l.trim()));
    if (isListBlock) {
      const items = lines
        .map((l) => `  <li>${applyInline(l.trim().replace(/^[-*]\s+/, ''))}</li>`)
        .join('\n');
      return `<ul>\n${items}\n</ul>`;
    }

    // Paragraph: join lines with a space (single newline in source is a soft wrap),
    // then apply inline formatting
    const paragraphText = lines
      .map((l) => applyInline(l.trim()))
      .join('<br>');
    return `<p>${paragraphText}</p>`;
  });

  // Wrap in a minimal HTML email shell with a readable font and line spacing
  const body = htmlBlocks.filter((b) => b !== '').join('\n');
  return `<div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #222;">\n${body}\n</div>`;
}

// ---------------------------------------------------------------------------
// Inline formatting helpers
// ---------------------------------------------------------------------------

/**
 * Apply inline markdown formatting to a single run of text.
 * Order matters: code spans first (to avoid double-processing their contents),
 * then bold (** / __), then italic (* / _).
 */
function applyInline(text: string): string {
  // HTML-escape special characters that aren't part of markdown syntax.
  // We escape < > & but leave * _ ` alone for markdown processing below.
  let out = escapeHtml(text);

  // Inline code: `code` — escape happens inside the span via escapeHtml above
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold: **text** or __text__
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic: *text* or _text_ (not preceded/followed by another * or _)
  out = out.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  out = out.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<em>$1</em>');

  return out;
}

/**
 * Escape HTML special characters so literal < > & in email text don't
 * accidentally create tags. Does NOT escape * _ ` so markdown processing
 * can still match them.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
