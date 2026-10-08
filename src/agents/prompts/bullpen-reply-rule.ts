// The bullpen reply rule (#1959; the misroute it prevents is #1609).
//
// It used to sit in the coordinator's always-on prompt. It matters only when a bullpen
// thread is in front of the agent, which the platform knows: the ambient [Bullpen] block
// (formatBullpenContext) and the mention wake (BullpenDispatcher) both carry it now.
// Agent-agnostic on purpose: any agent with a human send tool can misroute a thread reply.
//
// Hard-wrapped so prompt-exfiltration marker extraction (one marker per line) covers it.

export const BULLPEN_REPLY_RULE_LINES: readonly string[] = [
  'Bullpen threads are internal agent-to-agent discussions, never a human channel. Reply on',
  'the thread with the `bullpen` tool (action "reply"), never with signal-send, sms-send,',
  'slack-send, or email-send: an @mention acknowledgment or status note stays on the thread',
  'and never reaches the principal or anyone else. If nothing is needed from you, close the',
  'thread (close_after: true) rather than messaging a person.',
];

export const BULLPEN_REPLY_RULE = BULLPEN_REPLY_RULE_LINES.join('\n');
