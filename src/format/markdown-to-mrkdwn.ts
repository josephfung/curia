// markdown-to-mrkdwn.ts — focused CommonMark-ish → Slack mrkdwn transform.
//
// Slack mrkdwn is NOT CommonMark: *bold*, _italic_, <url|label> links.
// Passing agent markdown through chat.postMessage raw renders literal ** and
// [text](url). Keep this module small and unit-tested (ADR-030 / PR feedback).

/**
 * Convert LLM-authored markdown into Slack mrkdwn for chat.postMessage.
 *
 * Handles the common cases agents emit: bold, italic, links, headings,
 * unordered/ordered lists, and fenced/inline code. Deliberately not a full
 * CommonMark parser — Block Kit is the heavier alternative for later.
 */
export function markdownToMrkdwn(input: string): string {
  const normalized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const out: string[] = [];
  let inFence = false;

  for (const line of lines) {
    const fenceMatch = line.match(/^(\s*)```(.*)$/);
    if (fenceMatch) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    let next = line;

    // Headings → bold line (drop leading # markers).
    const heading = next.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      next = `*${inlineMarkdownToMrkdwn(heading[2]!.trim())}*`;
      out.push(next);
      continue;
    }

    // Unordered lists → bullet.
    const ul = next.match(/^(\s*)([-*+])\s+(.*)$/);
    if (ul) {
      next = `${ul[1]}• ${inlineMarkdownToMrkdwn(ul[3]!)}`;
      out.push(next);
      continue;
    }

    // Ordered lists → keep number, convert inline.
    const ol = next.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (ol) {
      next = `${ol[1]}${ol[2]}. ${inlineMarkdownToMrkdwn(ol[3]!)}`;
      out.push(next);
      continue;
    }

    out.push(inlineMarkdownToMrkdwn(next));
  }

  return out.join('\n');
}

/**
 * Inline-only transform. Protects code spans and bold placeholders so italic
 * conversion cannot rewrite Slack `*bold*` markers.
 */
export function inlineMarkdownToMrkdwn(input: string): string {
  const placeholders: string[] = [];
  const park = (value: string): string => {
    const idx = placeholders.length;
    placeholders.push(value);
    return `\u0000P${idx}\u0000`;
  };

  // 1. Park inline code.
  let text = input.replace(/`([^`]+)`/g, (_m, code: string) => park(`\`${code}\``));

  // 2. Links: [label](url) → <url|label>
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    return `<${url}|${label}>`;
  });

  // 3. Bold ** / __ → Slack *bold*, then park so italic pass leaves them alone.
  text = text.replace(/\*\*([^*]+)\*\*/g, (_m, inner: string) => park(`*${inner}*`));
  text = text.replace(/__([^_]+)__/g, (_m, inner: string) => park(`*${inner}*`));

  // 4. Italic: markdown *text* or _text_ → Slack _text_
  text = text.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\*)/g, (_m, pre: string, inner: string) => {
    return `${pre}_${inner}_`;
  });
  text = text.replace(/(^|[^\w_])_([^_\n]+)_(?!_)/g, (_m, pre: string, inner: string) => {
    // Avoid double-wrapping already-converted italics.
    if (inner.startsWith('\u0000')) return `${pre}_${inner}_`;
    return `${pre}_${inner}_`;
  });

  // 5. Restore placeholders.
  text = text.replace(/\u0000P(\d+)\u0000/g, (_m, idx: string) => placeholders[Number(idx)] ?? '');

  return text;
}
