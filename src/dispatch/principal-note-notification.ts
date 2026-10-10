// The email that carries a note for the principal (prompt trim PR 5).
//
// When the coordinator answers someone other than the principal, anything it wants the
// principal to hear goes in a <note_for_principal> block, which the runtime cuts out of
// the reply (src/agents/principal-note.ts). The dispatcher delivers the note as a
// `principal_note` system notification: email to the principal's verified address, through
// the gateway's content checks, like approval alerts.
//
// Pure module. The sender's label and address are sender-controlled text (a self-claimed
// display name, a From address), so they are folded onto one line and bounded before they
// reach a subject line.

/** What the principal needs to place the note: who the reply went to, and how. */
export interface PrincipalNoteSource {
  /** The sender's display name when resolved, else their channel identifier. */
  senderLabel: string;
  /** The sender's channel identifier (an email address, a phone number). */
  senderId: string;
  channelId: string;
}

const MAX_LABEL = 80;

// What a message on each channel is called, with its article. Anything else is "a message".
const CHANNEL_NOUN: Readonly<Record<string, readonly [string, string]>> = {
  email: ['an', 'email'],
  signal: ['a', 'Signal message'],
  sms: ['a', 'text'],
  slack: ['a', 'Slack message'],
};

function oneLine(text: string): string {
  // Control characters (CR/LF included) would end a header line early.
  const folded = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(folded).slice(0, MAX_LABEL).join('').trim();
}

function channelNoun(channelId: string): readonly [string, string] {
  return CHANNEL_NOUN[channelId] ?? ['a', 'message'];
}

export function principalNoteSubject(source: PrincipalNoteSource): string {
  const label = oneLine(source.senderLabel) || 'a sender';
  return `Note about ${label}'s ${channelNoun(source.channelId)[1]}`;
}

export function principalNoteBody(note: string, source: PrincipalNoteSource): string {
  const label = oneLine(source.senderLabel) || 'the sender';
  const id = oneLine(source.senderId);
  const who = id.length > 0 && id.toLowerCase() !== label.toLowerCase() ? `${label} (${id})` : label;
  const [article, noun] = channelNoun(source.channelId);
  return [
    note,
    '',
    '—',
    `Written while replying to ${article} ${noun} from ${who}. They were not sent this note.`,
  ].join('\n');
}
