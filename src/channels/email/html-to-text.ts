import { createRequire } from 'node:module';
import type { Node, HTMLElement as HtmlElement } from 'node-html-parser';

// node-html-parser is CJS-only. Load via createRequire so the CJS build is used
// reliably under Node ESM + vitest (where Vite's ESM/CJS interop can lose named exports).
const _require = createRequire(import.meta.url);
const { parse, NodeType } = _require('node-html-parser') as typeof import('node-html-parser');

const BLOCK_ELEMENTS = new Set([
  'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TR', 'TD', 'TH', 'BLOCKQUOTE',
]);

/**
 * Walk the parsed tree and collect raw text fragments into `buf`.
 *
 * SCRIPT and STYLE elements are skipped entirely — neither the tags nor their
 * content are emitted. Using `rawText` (not decoded `.text`) preserves HTML
 * entity encoding in text nodes so entity decoding can happen in a controlled
 * order after remaining tag-like fragments are stripped.
 */
function buildText(node: Node, buf: string[]): void {
  if (node.nodeType === NodeType.TEXT_NODE) {
    buf.push(node.rawText);
    return;
  }
  if (node.nodeType !== NodeType.ELEMENT_NODE) return;

  const el = node as HtmlElement;
  const tag = el.tagName as string | undefined;

  // Root node (tagName is null) — descend without emitting anything
  if (!tag) {
    for (const child of el.childNodes) buildText(child, buf);
    return;
  }

  // Drop script and style blocks entirely (tag + content)
  if (tag === 'SCRIPT' || tag === 'STYLE') return;

  if (tag === 'BR') { buf.push('\n'); return; }
  if (tag === 'HR') { buf.push('\n---\n'); return; }

  for (const child of el.childNodes) buildText(child, buf);

  // Append a newline after each block-level element to preserve paragraph breaks
  if (BLOCK_ELEMENTS.has(tag)) buf.push('\n');
}

/**
 * Convert HTML email body to plain text for LLM consumption.
 *
 * Uses a proper HTML parser (node-html-parser) to remove <script> and <style>
 * blocks, eliminating the regex-based tag-filtering bypass described in CodeQL
 * rule js/bad-tag-filter. The parser correctly handles cases where the script
 * body contains string literals that look like closing tags — e.g.,
 * `var x = "</script type=text>"` — which naive regexes treat as end tags.
 */
export function htmlToText(html: string | undefined | null): string {
  if (!html) return '';

  // Normalize end tags that have trailing whitespace before the closing `>`.
  // The HTML spec allows whitespace-only padding (</script >) in end tags, but
  // node-html-parser requires `>` to immediately follow the tag name. We only
  // strip \s+ (not arbitrary [^>]+) to avoid converting fake closing tags like
  // </script type=text> inside script string literals into real ones.
  const normalized = html.replace(/<\/([a-zA-Z][a-zA-Z0-9]*)\s+>/g, '</$1>');

  const root = parse(normalized, { comment: false });
  const buf: string[] = [];
  buildText(root, buf);

  let text = buf.join('');

  // Strip any HTML-tag-like patterns remaining in the raw text. After the
  // parser removes real SCRIPT/STYLE elements, malformed input may leave
  // literal angle-bracket fragments in text nodes (e.g. the nested-substitution
  // bypass pattern leaves `<scri` and `pt>` as separate text nodes). The loop
  // repeats until stable.
  for (let prev = ''; prev !== text; ) {
    prev = text;
    text = text.replace(/<[^>]+>/g, '');            // complete tag-like patterns
    text = text.replace(/<[a-zA-Z][^>]{0,500}/g, ''); // incomplete trailing fragments
  }

  // Decode HTML entities. &amp; must come LAST to prevent double-decoding:
  // decoded first, &amp;lt; → &lt; → < (smuggles a literal <).
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');

  // Collapse whitespace runs (preserving paragraph breaks)
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n[ \t]+/g, '\n');
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}
