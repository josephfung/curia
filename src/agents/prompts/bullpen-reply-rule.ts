// The bullpen reply rule (#1959; the misroute it prevents is #1609).
//
// It used to sit in the coordinator's always-on prompt. It matters only when a bullpen
// thread is in front of the agent, which the platform knows: the ambient [Bullpen] block
// (formatBullpenContext) and the mention wake (BullpenDispatcher) both carry it now.
// Agent-agnostic on purpose: any agent with a human send tool can misroute a thread reply.
//
// Says where the reply goes rather than naming the send tools it must not use (prompt trim
// PR 10). The old "never with … email-send" read as forbidding the send a thread asks for,
// such as ceo-inbox's urgent escalation to the principal (#2033), so that send is named
// here as an action of its own.
//
// Hard-wrapped so prompt-exfiltration marker extraction (one marker per line) covers it.

export const BULLPEN_REPLY_RULE_LINES: readonly string[] = [
  'Bullpen threads are internal: only agents read them. Reply to a thread with',
  '`bullpen-reply`, so an @mention acknowledgment, a status note or an answer stays on',
  'the thread. A message the thread asks you to send to the principal or anyone else is a',
  'separate action: send it with the send skill the request calls for, as you would any send.',
  'When nothing more is needed from you, close the thread (close_after: true).',
];

export const BULLPEN_REPLY_RULE = BULLPEN_REPLY_RULE_LINES.join('\n');
