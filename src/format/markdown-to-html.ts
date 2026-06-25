import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';

export interface MarkdownToHtmlOptions {
  /** Add the styled email shell used for outbound HTML email bodies. */
  wrap?: boolean;
}

const EMAIL_WRAPPER_STYLE = 'font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #222;';

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

const defaultLinkOpen =
  markdown.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

markdown.renderer.rules.link_open = (tokens, idx, options, env, self): string => {
  const token = tokens[idx]!;
  const href = token.attrGet('href') ?? '';
  if (/^(https?:)?\/\//i.test(href)) {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

const MARKDOWN_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'a', 'blockquote', 'br', 'code', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'hr', 'li', 'ol', 'p', 'pre', 'strong', 'ul',
    'caption', 'col', 'colgroup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
  ],
  allowedAttributes: {
    a: ['href', 'rel', 'target', 'title'],
    col: ['span', 'width'],
    colgroup: ['span', 'width'],
    div: ['style'],
    table: ['align', 'border', 'cellpadding', 'cellspacing', 'width'],
    td: ['align', 'colspan', 'rowspan', 'style', 'valign', 'width'],
    th: ['align', 'colspan', 'rowspan', 'scope', 'style', 'valign', 'width'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  nonTextTags: ['script', 'style', 'head', 'noscript', 'template', 'xml'],
  transformTags: {
    '*': (tagName: string, attribs: sanitizeHtml.Attributes): sanitizeHtml.Tag => {
      const style = attribs['style'];
      const newAttribs: sanitizeHtml.Attributes = style
        ? {
            ...attribs,
            style: style
              .replace(/\bexpression\s*\(.*?\)/gis, '')
              .replace(/\bbehavior\s*:[^;]*/gi, ''),
          }
        : attribs;
      return { tagName, attribs: newAttribs };
    },
  },
};

/**
 * Returns true when the input already contains block-level HTML tags.
 *
 * The guard exists for LLM-authored bodies that are already HTML. Those bodies
 * should be sanitized and sent as HTML, not parsed as markdown and escaped.
 */
export function looksLikeHtml(text: string): boolean {
  return /<(html|head|body|p|div|br|ul|ol|li|h[1-6]|blockquote|table|tr|td|th)\b/i.test(text.trim());
}

/**
 * Convert LLM-authored markdown or direct HTML into sanitized HTML.
 */
export function markdownToHtml(input: string, opts?: MarkdownToHtmlOptions): string {
  const rendered = looksLikeHtml(input)
    ? input
    : markdown.render(input.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
  const safe = sanitizeHtml(rendered, MARKDOWN_SANITIZE_OPTIONS).trim();

  if (!opts?.wrap) {
    return safe;
  }

  return `<div style="${EMAIL_WRAPPER_STYLE}">\n${safe}\n</div>`;
}
