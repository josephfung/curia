// slack-entities.ts — decode Slack mrkdwn entities before the agent sees text.
//
// Slack delivers user/channel/link mentions as <…> tokens and escapes &, <, >.
// Strip the leading bot @mention on app_mention so content is clean.

/**
 * Decode Slack message text for agent consumption:
 * - Unescape &amp; &lt; &gt;
 * - Unwrap <@U…>, <#C…|name>, <url|label>, <url>
 * - Optionally strip a leading bot mention token
 */
export function decodeSlackText(raw: string, options?: { botUserId?: string }): string {
  let text = raw;

  if (options?.botUserId) {
    const botMention = new RegExp(`^\\s*<@${escapeRegExp(options.botUserId)}>\\s*`);
    text = text.replace(botMention, '');
  }

  // User mentions: <@U123> or <@U123|label>
  text = text.replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/gi, (_m, id: string, label?: string) => {
    return label?.trim() ? `@${label.trim()}` : `@${id}`;
  });

  // Channel mentions: <#C123> or <#C123|general>
  text = text.replace(/<#([CG][A-Z0-9]+)(?:\|([^>]+))?>/gi, (_m, id: string, label?: string) => {
    return label?.trim() ? `#${label.trim()}` : `#${id}`;
  });

  // Links: <url|label> or <url>
  text = text.replace(/<([^|>]+)\|([^>]+)>/g, (_m, url: string, label: string) => {
    // mailto: and special Slack tokens — keep label if present.
    if (url.startsWith('mailto:')) return label;
    return label.trim() || url;
  });
  text = text.replace(/<(https?:\/\/[^>]+)>/gi, '$1');
  text = text.replace(/<mailto:([^|>]+)(?:\|[^>]*)?>/gi, '$1');

  // Unescape HTML entities Slack applies to message text.
  // `&amp;` must come last so an already-decoded `&` is not re-consumed
  // by a later rule (e.g. `&amp;lt;` must stay the literal `&lt;`, not `<`).
  text = text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  return text.trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
