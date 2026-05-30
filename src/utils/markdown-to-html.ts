// markdown-to-html.ts — converts LLM-generated markdown to clean HTML.
//
// Shares the same conversion logic as src/channels/email/markdown-to-html.ts
// but returns the inner HTML blocks without any email-specific wrapper div or
// inline styles. Used by the chat API endpoints.

/**
 * Convert a markdown-formatted string into clean HTML.
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

  // Split into blocks separated by one or more blank lines.
  const rawBlocks = text.split(/\n\s*\n+/);

  const htmlBlocks: string[] = rawBlocks.map((block) => {
    const trimmed = block.trim();
    if (trimmed === '') return '';

    // Horizontal rule: a line of only dashes OR only asterisks (3+, all same).
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
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

    // Paragraph: join lines with <br>, apply inline formatting
    const paragraphText = lines
      .map((l) => applyInline(l.trim()))
      .join('<br>');
    return `<p>${paragraphText}</p>`;
  });

  return htmlBlocks.filter((b) => b !== '').join('\n');
}

function applyInline(text: string): string {
  let out = escapeHtml(text);

  // Inline code first to avoid re-processing its contents
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold: **text** or __text__
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic: *text*
  out = out.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  // Italic: _text_ (word-boundary anchored to avoid matching underscores in identifiers)
  out = out.replace(/(?<!_)\b_(?!_)(.+?)(?<!_)_\b(?!_)/g, '<em>$1</em>');

  return out;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
