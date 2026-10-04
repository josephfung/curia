import { describe, it, expect } from 'vitest';
import { containsRawAgentId, principalAgentLabel } from '../../../src/agents/agent-display-name.js';
import {
  delegationFailureAudience,
  delegationFailureNarrationPrompt,
  extractReplyBlock,
  formatDelegationFailureFallback,
  selectDelegationFailureReply,
  transcriptForNarration,
} from '../../../src/agents/delegation-failure-reply.js';
import type { Message } from '../../../src/agents/llm/provider.js';

describe('principal agent labels (#1860)', () => {
  it('derives a phrase from a hyphenated registry id', () => {
    expect(principalAgentLabel('social-media')).toBe('social media specialist');
    expect(containsRawAgentId('the social media specialist', 'social-media')).toBe(false);
    expect(containsRawAgentId('the social-media', 'social-media')).toBe(true);
  });

  it('prefers an explicit display name that is not the registry id', () => {
    expect(principalAgentLabel('social-media', 'social team')).toBe('social team');
    expect(principalAgentLabel('social-media', 'social-media')).toBe('social media specialist');
  });

  it('uses "specialist" when the id is empty, without a double article', () => {
    expect(principalAgentLabel('')).toBe('specialist');
    expect(principalAgentLabel('   ')).toBe('specialist');
  });

  it('treats a single-word id as a leak only in harness shapes', () => {
    expect(containsRawAgentId('the calendar specialist', 'calendar')).toBe(false);
    expect(containsRawAgentId('the calendar', 'calendar')).toBe(false);
    expect(containsRawAgentId('Check my calendar for Tuesday afternoon', 'calendar')).toBe(false);
    expect(containsRawAgentId("Specialist 'calendar' refused", 'calendar')).toBe(true);
    expect(containsRawAgentId('Specialist "Calendar" refused', 'calendar')).toBe(true);
    expect(containsRawAgentId('ask @calendar', 'calendar')).toBe(true);
    expect(principalAgentLabel('calendar', 'calendar')).toBe('calendar specialist');
    expect(principalAgentLabel('calendar', 'Calendar')).toBe('calendar specialist');
  });
});

/** Wrap a draft the way the narration prompt asks the model to. */
function reply(text: string): string {
  return `<reply>${text}</reply>`;
}

describe('delegation failure fallback (#1860, #1975, #1976)', () => {
  const base = {
    audience: 'principal' as const,
    displayName: 'social team',
    agentId: 'social-media',
    escalated: true,
    request: 'Trim the k8m5 draft',
  };
  const branches = [
    { reason: 'timeout', possiblySucceeded: true },
    { reason: 'blocked' },
    { reason: 'tool_error' },
    { reason: 'specialist_decline', declined: true },
  ];

  it('speaks for itself on every branch: no specialist, no registry id', () => {
    const texts = branches.map((branch) => formatDelegationFailureFallback({ ...base, ...branch }));
    for (const text of texts) {
      expect(text).not.toContain('social-media');
      expect(text).not.toContain('social team');
      expect(text).not.toMatch(/specialist/i);
      expect(text).toMatch(/^I /);
    }
    // Each kind of failure still reads differently.
    expect(new Set(texts).size).toBe(branches.length);
    expect(texts[0]).toMatch(/background|completing/i);
  });

  it('never quotes the request, however internal it is', () => {
    const principalUuid = '6f1c2a9e-4b7d-4e3a-9c51-2d8e7f0a1b34';
    const brief = `Prepare the principal's (Alex Example, contact ID ${principalUuid}) morning briefing for today, Thursday.`;
    for (const branch of branches) {
      const text = formatDelegationFailureFallback({ ...base, ...branch, request: brief });
      expect(text).not.toContain(principalUuid);
      expect(text).not.toMatch(/principal/i);
      expect(text).not.toContain('Alex Example');
      expect(text).not.toContain('...');
    }
  });

  it('does not relay the specialist decline prose from #1976', () => {
    // The fallback input no longer carries the decline prose at all. Build the reply
    // for the decline in #1976 and check none of its internals appear.
    const text = formatDelegationFailureFallback({
      audience: 'principal',
      displayName: 'ceo inbox specialist',
      agentId: 'ceo-inbox',
      reason: 'specialist_decline',
      declined: true,
      escalated: true,
      request: 'Summarize where things stand in the long legal thread with Acme',
    });
    for (const internal of ['nylas_api_key', 'workingDocs', 'doc-search', 'KG', 'specialist', 'principal']) {
      expect(text).not.toContain(internal);
    }
  });

  it('suggests a retry only when a retry could help', () => {
    const notEscalated = { ...base, escalated: false };
    const retry = /try again/i;
    expect(formatDelegationFailureFallback({ ...notEscalated, reason: 'timeout' })).toMatch(retry);
    expect(formatDelegationFailureFallback({ ...notEscalated, reason: 'tool_error' })).toMatch(retry);
    // May have gone through: a retry could send or post twice.
    expect(formatDelegationFailureFallback({ ...notEscalated, reason: 'timeout', possiblySucceeded: true }))
      .not.toMatch(retry);
    expect(formatDelegationFailureFallback({ ...notEscalated, reason: 'blocked' })).not.toMatch(retry);
    expect(formatDelegationFailureFallback({ ...notEscalated, reason: 'specialist_decline', declined: true }))
      .not.toMatch(retry);
  });
});

describe('delegation failure narration prompt (#1975)', () => {
  const prompt = delegationFailureNarrationPrompt({
    audience: 'principal',
    reason: 'specialist_decline',
    declined: true,
    escalated: false,
  });

  it('asks for a reply block and quotes nothing', () => {
    expect(prompt).toContain('<reply>');
    expect(prompt).not.toMatch(/include this phrase/i);
  });

  it('tells the model not to name the specialist, and does not hand it the word elsewhere', () => {
    expect(prompt).toMatch(/do not mention specialists/i);
    const others = prompt.split('\n').filter((line) => !/do not mention specialists/i.test(line));
    expect(others.join('\n')).not.toMatch(/specialist|delegat/i);
  });
});

describe('delegation failure draft selection (#1860, #1975)', () => {
  const principalUuid = '6f1c2a9e-4b7d-4e3a-9c51-2d8e7f0a1b34';
  const brief = `Prepare the principal's (Alex Example, contact ID ${principalUuid}) morning briefing for today, Thursday.`;
  const morning = {
    audience: 'principal' as const,
    displayName: 'calendar specialist',
    agentId: 'calendar',
    reason: 'specialist_decline',
    declined: true,
    escalated: false,
    request: 'Prepare the morning briefing for today.',
  };

  it('keeps a clean first-person draft about the request', () => {
    const clean = "I couldn't put together your morning briefing today. Want me to have another go later?";
    const selected = selectDelegationFailureReply({ ...morning, modelText: reply(clean) });
    expect(selected).toEqual({ content: clean, via: 'model' });
  });

  it('keeps a paraphrase that shares a stem with the request', () => {
    const selected = selectDelegationFailureReply({
      audience: 'principal',
      displayName: 'social team',
      agentId: 'social-media',
      reason: 'timeout',
      escalated: true,
      request: 'Trim the k8m5 draft',
      modelText: reply("I didn't get the k8m5 trim done in time. I've logged a follow-up."),
    });
    expect(selected.via).toBe('model');
  });

  it('rejects the draft from #1975: reasoning, the narration prompt and the brief, with no reply block', () => {
    const draft = [
      'Wait — I need to write the reply. Let me reconsider.',
      '',
      'The task says: "A delegated task failed. Write the one reply the principal will read." The specialist declined the task. A follow-up task could not be logged. Do not call tools. Reply in plain text only.',
      '',
      'So I need to write a reply to the principal. Include the required phrase. Refer to the specialist only as "calendar specialist".',
      '',
      `The phrase to include: "${brief.slice(0, 117)}..."`,
      '',
      `Let me compose plainly.I wasn't able to get your morning briefing today — I asked the calendar specialist to ${brief.slice(0, 117)}... and the specialist declined the request.`,
    ].join('\n');
    const selected = selectDelegationFailureReply({ ...morning, modelText: draft });
    expect(selected.via).toBe('fallback');
    expect(selected.rejected).toBe('no_reply_block');
    expect(selected.content).not.toContain(principalUuid);
    expect(selected.content).not.toMatch(/principal/i);
    expect(selected.content).not.toContain('Let me');
  });

  it('keeps only the reply block when the model reasons before it', () => {
    const clean = "I couldn't put together your morning briefing today.";
    const draft = `Wait, let me think about what to say.\nIt was turned down.\n${reply(clean)}`;
    const selected = selectDelegationFailureReply({ ...morning, modelText: draft });
    expect(selected.via).toBe('model');
    expect(selected.content).toBe(clean);
  });

  it('takes the last complete reply block', () => {
    expect(extractReplyBlock(`${reply('first try')}\nhmm\n${reply('  final  ')}`)).toBe('final');
    expect(extractReplyBlock('<reply>never closed')).toBeNull();
    expect(extractReplyBlock(reply('   '))).toBeNull();
    expect(extractReplyBlock('no tags at all')).toBeNull();
  });

  it('drops an abandoned open block and the thinking inside it', () => {
    const clean = "I couldn't put together your morning briefing today.";
    const draft = `<reply>Hmm, that was turned down. I should not mention the principal's contact. Let me redo.\n${reply(clean)}`;
    expect(extractReplyBlock(draft)).toBe(clean);
    const selected = selectDelegationFailureReply({ ...morning, modelText: draft });
    expect(selected.via).toBe('model');
    expect(selected.content).toBe(clean);
  });

  it('rejects a draft that names the specialist', () => {
    const selected = selectDelegationFailureReply({
      ...morning,
      modelText: reply("I couldn't get your morning briefing: the Calendar Specialist declined it."),
    });
    expect(selected.via).toBe('fallback');
    expect(selected.rejected).toBe('names_specialist');
    expect(selected.content).not.toMatch(/specialist/i);
  });

  it('rejects a draft that talks about a specialist or handing off without the full label', () => {
    for (const text of [
      "The specialist didn't get back to me on your morning briefing.",
      'My scheduling specialists could not prepare your morning briefing.',
      'I delegated your morning briefing, but it was turned down.',
    ]) {
      expect(selectDelegationFailureReply({ ...morning, modelText: reply(text) }).rejected).toBe('names_specialist');
    }
  });

  it('rejects an explicit display name, except as "your <label>"', () => {
    const team = { ...morning, displayName: 'social team', agentId: 'social-media', request: 'Trim the k8m5 draft' };
    expect(selectDelegationFailureReply({
      ...team,
      modelText: reply("The social team couldn't trim the k8m5 draft."),
    }).rejected).toBe('names_specialist');

    // The request naming the team does not license the reply to name it as the actor.
    expect(selectDelegationFailureReply({
      ...team,
      request: 'Ask the social team to trim the k8m5 draft',
      modelText: reply("The social team couldn't trim the k8m5 draft."),
    }).rejected).toBe('names_specialist');

    const tracker = {
      ...morning,
      displayName: 'expense tracker',
      agentId: 'expense-tracker',
      request: 'Log this receipt in my expense tracker',
    };
    const onTopic = selectDelegationFailureReply({
      ...tracker,
      modelText: reply("I couldn't add that receipt to your expense tracker."),
    });
    expect(onTopic.via).toBe('model');
  });

  it('rejects a draft that leaks the registry id', () => {
    const selected = selectDelegationFailureReply({
      ...morning,
      modelText: reply("I couldn't get your morning briefing back from 'calendar'."),
    });
    expect(selected.rejected).toBe('agent_id');
  });

  it('rejects a reply block that echoes the narration instructions', () => {
    const selected = selectDelegationFailureReply({
      ...morning,
      modelText: reply('Something you were doing for the principal failed. Your morning briefing could not be prepared.'),
    });
    expect(selected.via).toBe('fallback');
    expect(selected.rejected).toBe('prompt_echo');
  });

  it('does not treat restating the follow-up fact as a prompt echo', () => {
    const selected = selectDelegationFailureReply({
      ...morning,
      reason: 'timeout',
      declined: false,
      escalated: true,
      modelText: reply("I couldn't get your morning briefing in time. A follow-up task has already been logged."),
    });
    expect(selected.via).toBe('model');
  });

  it('rejects a reply block that carries a UUID, including one glued to an id prefix', () => {
    const plain = selectDelegationFailureReply({
      ...morning,
      modelText: reply(`I couldn't prepare your morning briefing for contact ${principalUuid}.`),
    });
    expect(plain.rejected).toBe('uuid');
    expect(plain.content).not.toContain(principalUuid);
    const glued = selectDelegationFailureReply({
      ...morning,
      modelText: reply(`I couldn't prepare your morning briefing for contact_${principalUuid}.`),
    });
    expect(glued.rejected).toBe('uuid');
  });

  it('rejects a protocol marker and an empty draft, and reports no rejection when there was no draft', () => {
    const protocol = selectDelegationFailureReply({
      ...morning,
      modelText: reply('{"_curia_protocol":"delegation_failure"} morning briefing'),
    });
    expect(protocol.rejected).toBe('protocol');
    expect(selectDelegationFailureReply({ ...morning, modelText: '   ' }).rejected).toBe('empty');
    const none = selectDelegationFailureReply(morning);
    expect(none.via).toBe('fallback');
    expect(none.rejected).toBeUndefined();
  });

  it('rejects a stock line that ignores the request', () => {
    const selected = selectDelegationFailureReply({
      ...morning,
      modelText: reply("Something went wrong on my end, sorry. I'll sort it out."),
    });
    expect(selected.rejected).toBe('off_topic');
  });

  it('does not let words the prompt supplies pass the topic check', () => {
    // "follow", "task" and "time" are in the request, but the prompt hands the model
    // those words, so a stock line using them says nothing about this request.
    const selected = selectDelegationFailureReply({
      audience: 'principal',
      displayName: 'contacts specialist',
      agentId: 'contacts',
      reason: 'timeout',
      escalated: true,
      request: 'Add a task to follow up with Dana next time',
      modelText: reply("I didn't get that done in time. A follow-up task has already been logged."),
    });
    expect(selected.rejected).toBe('off_topic');
  });

  it('matches inflections and long prefixes, not short unrelated prefixes', () => {
    const select = (request: string, text: string) =>
      selectDelegationFailureReply({ ...morning, request, modelText: reply(text) });
    // "back" is a prefix of "backup" but not the same word.
    expect(select('Did the backup finish?', "I couldn't get back to you on that one.").rejected).toBe('off_topic');
    // A short base the request word inflects still counts.
    expect(select('Get it trimmed', "I couldn't trim it down.").via).toBe('model');
    // So does a long enough prefix.
    expect(select('Send the briefing', "I couldn't put the brief together.").via).toBe('model');
  });

  it('accepts any clean draft when the request has no content words to check', () => {
    const selected = selectDelegationFailureReply({
      ...morning,
      request: 'do it',
      modelText: reply("I couldn't get that done just now. I've logged a follow-up."),
    });
    expect(selected.via).toBe('model');
  });
});

describe('delegation failure reply for a non-principal reader (#1978)', () => {
  // A known external contact's email: the dispatcher relays this reply to them.
  const sender = {
    audience: 'sender' as const,
    displayName: 'ceo inbox specialist',
    agentId: 'ceo-inbox',
    reason: 'timeout',
    escalated: true,
    request: 'Subject: Re: Venue options for the board dinner\n\nYes, go ahead.',
  };
  const branches = [
    { reason: 'timeout', possiblySucceeded: true },
    { reason: 'timeout' },
    { reason: 'blocked' },
    { reason: 'tool_error' },
    { reason: 'specialist_decline', declined: true },
  ];

  it('the fallback promises a follow-up only when the task recording them was logged', () => {
    for (const branch of branches) {
      const escalated = formatDelegationFailureFallback({ ...sender, ...branch, escalated: true });
      expect(escalated).toMatch(/^I /);
      expect(escalated).toContain("I'll follow up with you on it.");
      // The logged task itself is the principal's to know.
      expect(escalated).not.toMatch(/logged|follow-up task|review the outcome|principal/i);

      const notEscalated = formatDelegationFailureFallback({ ...sender, ...branch, escalated: false });
      expect(notEscalated).not.toMatch(/follow up|follow-up|logged/i);
    }
    // The principal still hears that the follow-up was logged.
    expect(formatDelegationFailureFallback({ ...sender, audience: 'principal' }))
      .toContain("I've logged a follow-up task to review the outcome.");
  });

  it('the prompt names the sender as the reader and gives notes for the principal their own block', () => {
    const prompt = delegationFailureNarrationPrompt({ ...sender });
    expect(prompt).toMatch(/in reply to the person who sent this message/);
    expect(prompt).toMatch(/They are not the principal/);
    // A place to put the note, not only a ban on writing it (#1990).
    expect(prompt).toContain('<note_for_principal></note_for_principal>');
    expect(prompt).toMatch(/Only the principal sees that note/);
    expect(prompt).not.toMatch(/for the principal failed/);
    // It does not ask for "what you were trying to do", which is often "find the thread".
    expect(prompt).not.toMatch(/what you were trying to do/);
    expect(prompt).toMatch(/Do not describe what you looked for, could not find, or have no record of/);
    // The logged task is not handed to the model. A promise is licensed only when it was logged.
    expect(prompt).not.toMatch(/follow-up task/i);
    expect(prompt).toMatch(/you may say you will follow up/);
    expect(delegationFailureNarrationPrompt({ ...sender, escalated: false })).toMatch(/Do not promise to follow up/);
    // Still no specialist vocabulary outside the line forbidding it.
    const others = prompt.split('\n').filter((line) => !/do not mention specialists/i.test(line));
    expect(others.join('\n')).not.toMatch(/specialist|delegat/i);
  });

  it('the principal prompt is unchanged in substance', () => {
    const prompt = delegationFailureNarrationPrompt({ ...sender, audience: 'principal' });
    expect(prompt).toMatch(/for the principal failed/);
    expect(prompt).toContain('A follow-up task has already been logged.');
    expect(prompt).toMatch(/what you were trying to do for them/);
    expect(prompt).not.toMatch(/They are not the principal/);
    // The principal is the reader, so there is no one else to write a note for (#1990).
    expect(prompt).not.toMatch(/note_for_principal/);
  });

  it('keeps a clean draft written to the sender', () => {
    const clean = "Thanks for confirming the board dinner venue. I couldn't get it settled just yet.";
    expect(selectDelegationFailureReply({ ...sender, modelText: reply(clean) })).toEqual({ content: clean, via: 'model' });
  });

  it('rejects a draft that also talks to or about the principal, or reports the logged task', () => {
    for (const text of [
      "I couldn't confirm the board dinner venue yet. Internal note for the principal: I couldn't find the thread.",
      "I couldn't confirm the board dinner venue yet. I've logged it for review.",
      "I couldn't confirm the board dinner venue yet. A follow-up task has been created.",
    ]) {
      const selected = selectDelegationFailureReply({ ...sender, modelText: reply(text) });
      expect(selected.via).toBe('fallback');
      expect(selected.rejected).toBe('internal_note');
      expect(selected.content).not.toMatch(/logged|principal/i);
    }
  });

  it('rejects a draft that tells the sender the thread was lost', () => {
    for (const text of [
      // Both from review: they passed every check before lost_thread existed.
      "I tried to find our earlier thread about the board dinner venue options but couldn't track it down in time.",
      "I don't have a record of the board dinner venue thread, so I couldn't act on it yet.",
      'I have no record of the board dinner venue options you mention.',
      'I couldn\u2019t locate the board dinner venue thread.',
      'I seem to have lost the thread on the board dinner venue.',
    ]) {
      const selected = selectDelegationFailureReply({ ...sender, modelText: reply(text) });
      expect(selected.via, text).toBe('fallback');
      expect(selected.rejected, text).toBe('lost_thread');
    }
    // The principal may hear it: candour with them is the rule.
    expect(selectDelegationFailureReply({
      ...sender,
      audience: 'principal',
      modelText: reply("I couldn't find the board dinner venue thread in time."),
    }).via).toBe('model');
  });

  it('rejects a follow-up promise in a draft when nothing records the sender as waiting', () => {
    for (const text of [
      "I couldn't confirm the board dinner venue yet. I'll follow up with you shortly.",
      "I couldn't confirm the board dinner venue yet, but I will get back to you.",
      'I couldn\u2019t confirm the board dinner venue yet. I\u2019ll definitely be in touch.',
      "I couldn't confirm the board dinner venue yet. You'll hear back from me soon.",
    ]) {
      const unbacked = selectDelegationFailureReply({ ...sender, escalated: false, modelText: reply(text) });
      expect(unbacked.rejected, text).toBe('unbacked_promise');
      expect(unbacked.content).not.toMatch(/follow up|get back|in touch|hear back/i);
      // Backed by the review task: the same promise is fine.
      expect(selectDelegationFailureReply({ ...sender, escalated: true, modelText: reply(text) }).via, text).toBe('model');
    }
  });

  it('rejects an echo of the sender-only instruction', () => {
    const selected = selectDelegationFailureReply({
      ...sender,
      modelText: reply('Write only to them, and say nothing about tasks kept on the board dinner venue.'),
    });
    expect(selected.rejected).toBe('prompt_echo');
  });
});

describe('note for the principal on a reply to a sender (#1990)', () => {
  const sender = {
    audience: 'sender' as const,
    displayName: 'ceo inbox specialist',
    agentId: 'ceo-inbox',
    reason: 'timeout',
    escalated: true,
    request: 'Subject: Re: Venue options for the board dinner\n\nYes, go ahead.',
  };
  const clean = "Thanks for confirming the board dinner venue. I couldn't get it settled just yet.";
  const note = (text: string): string => `<note_for_principal>${text}</note_for_principal>`;

  it('sends the reply and returns the note separately when the note follows the reply', () => {
    const selected = selectDelegationFailureReply({
      ...sender,
      modelText: `${reply(clean)}\n${note("I couldn't find the original venue thread.")}`,
    });
    expect(selected).toEqual({
      content: clean,
      via: 'model',
      principalNote: "I couldn't find the original venue thread.",
    });
  });

  it('keeps a note written before the reply, or inside it, out of the reply', () => {
    const before = selectDelegationFailureReply({
      ...sender,
      modelText: `${note('Placeholder Principal, the thread is gone.')}\n${reply(clean)}`,
    });
    expect(before.content).toBe(clean);
    expect(before.principalNote).toBe('Placeholder Principal, the thread is gone.');

    // The #1990 shape: a postscript to the principal inside the reply, now in its own block.
    const inside = selectDelegationFailureReply({
      ...sender,
      modelText: reply(`${clean} ${note('P.S. Placeholder: I could not find the original thread anywhere.')}`),
    });
    expect(inside.via).toBe('model');
    expect(inside.content).toBe(clean);
    expect(inside.content).not.toMatch(/note_for_principal|P\.S\.|Placeholder/);
    expect(inside.principalNote).toBe('P.S. Placeholder: I could not find the original thread anywhere.');
  });

  it('keeps the note when the reply is rejected or missing', () => {
    const rejected = selectDelegationFailureReply({
      ...sender,
      modelText: `${reply('I have no record of the board dinner venue options you mention.')}${note('Thread not found.')}`,
    });
    expect(rejected.via).toBe('fallback');
    expect(rejected.rejected).toBe('lost_thread');
    expect(rejected.principalNote).toBe('Thread not found.');

    const noReply = selectDelegationFailureReply({ ...sender, modelText: note('Thread not found.') });
    expect(noReply.via).toBe('fallback');
    expect(noReply.rejected).toBe('no_reply_block');
    expect(noReply.principalNote).toBe('Thread not found.');
  });

  it('treats a missing or empty note as no note, not as a rejection', () => {
    expect(selectDelegationFailureReply({ ...sender, modelText: reply(clean) })).toEqual({ content: clean, via: 'model' });
    expect(selectDelegationFailureReply({ ...sender, modelText: `${reply(clean)}${note('   ')}` }))
      .toEqual({ content: clean, via: 'model' });
  });

  it('keeps every distinct note, since two blocks may be two separate points', () => {
    const selected = selectDelegationFailureReply({
      ...sender,
      modelText: `${note('The budget figure changed.')}${reply(clean)}${note('Thread not found.')}${note('Thread not found.')}`,
    });
    expect(selected.principalNote).toBe('The budget figure changed. Thread not found.');
  });

  it('rejects a reply that still carries note markup, so a broken note never reaches the sender', () => {
    for (const body of [
      `${clean} <note_for_principal>P.S. Placeholder: the thread is gone`,
      `${clean} P.S. Placeholder: the thread is gone</note_for_principal>`,
      // Tag variants the exact pattern would miss.
      `${clean} <note_for_principal >P.S. Placeholder: the thread is gone</note_for_principal >`,
      `${clean} <Note-For-Principal>P.S. Placeholder: the thread is gone`,
    ]) {
      const selected = selectDelegationFailureReply({ ...sender, modelText: reply(body) });
      expect(selected.via, body).toBe('fallback');
      expect(selected.rejected, body).toBe('note_markup');
      expect(selected.content).not.toMatch(/Placeholder|note_for_principal/i);
    }
  });

  it('recovers the text of a note the model never closed, and says so', () => {
    // Inside the reply: the reply is rejected, but what was meant for the principal is kept.
    const inside = selectDelegationFailureReply({
      ...sender,
      modelText: reply(`${clean} <note_for_principal>P.S. Placeholder: the thread is gone`),
    });
    expect(inside.rejected).toBe('note_markup');
    expect(inside.principalNote).toBe('P.S. Placeholder: the thread is gone');
    expect(inside.noteUnclosed).toBe(true);

    // After the reply, cut off (the likeliest cause is the output limit): the reply stands.
    const after = selectDelegationFailureReply({
      ...sender,
      modelText: `${reply(clean)}\n<note_for_principal>Thread not found, and the`,
    });
    expect(after).toEqual({ content: clean, via: 'model', principalNote: 'Thread not found, and the', noteUnclosed: true });

    // Before the reply: the note ends where the reply starts.
    const before = selectDelegationFailureReply({
      ...sender,
      modelText: `<note_for_principal>Thread not found. ${reply(clean)}`,
    });
    expect(before.content).toBe(clean);
    expect(before.principalNote).toBe('Thread not found.');
  });

  it('folds the note onto one bounded, sanitized line', () => {
    const selected = selectDelegationFailureReply({
      ...sender,
      modelText: `${reply(clean)}${note(`Line one.\n\n  Line two.${' x'.repeat(2000)}`)}`,
    });
    expect(selected.principalNote).toMatch(/^Line one\. Line two\./);
    expect(selected.principalNote).not.toContain('\n');
    expect(Array.from(selected.principalNote!).length).toBeLessThanOrEqual(1000);
  });

  it('leaves the principal path unchanged: no note is read for the principal', () => {
    const selected = selectDelegationFailureReply({
      ...sender,
      audience: 'principal',
      modelText: `${reply("I couldn't settle the board dinner venue in time.")}${note('aside')}`,
    });
    expect(selected).toEqual({ content: "I couldn't settle the board dinner venue in time.", via: 'model' });
  });
});

describe('delegation failure audience (#1978)', () => {
  const external = {
    contactId: 'contact-lena',
    systemRole: null,
    channel: 'email',
    initiatedAt: '2026-10-02T10:00:00.000Z',
    tier: 'known' as const,
  };
  const audienceOf = (turn: Parameters<typeof delegationFailureAudience>[0]) => delegationFailureAudience(turn).audience;

  it('is the sender on an inbound from anyone who is not the principal, resolved or not', () => {
    expect(delegationFailureAudience({ originator: external, channelId: 'email', delegated: false }))
      .toEqual({ audience: 'sender', basis: 'non_principal_originator' });
    expect(audienceOf({
      originator: { ...external, contactId: 'stranger@example.test', tier: 'unknown' },
      channelId: 'signal',
      delegated: false,
    })).toBe('sender');
  });

  it('is the principal on the principal\'s own inbound, and on work the platform or Curia started', () => {
    expect(delegationFailureAudience({
      originator: { ...external, systemRole: 'principal', tier: 'principal' },
      channelId: 'email',
      delegated: false,
    })).toEqual({ audience: 'principal', basis: 'principal_side_originator' });
    for (const systemRole of ['system', 'agent'] as const) {
      expect(audienceOf({ originator: { ...external, systemRole, tier: null }, channelId: 'email', delegated: false }))
        .toBe('principal');
    }
  });

  it('is the principal where no outside sender reads the reply', () => {
    // A delegated specialist answers the agent that delegated, even on external lineage.
    expect(delegationFailureAudience({ originator: external, channelId: 'internal', delegated: true }))
      .toEqual({ audience: 'principal', basis: 'delegated' });
    for (const channelId of ['scheduler', 'bullpen', 'internal']) {
      expect(delegationFailureAudience({ originator: external, channelId, delegated: false }))
        .toEqual({ audience: 'principal', basis: 'non_sender_channel' });
    }
  });

  it('is the principal on the principal-only channels, even with no originator', () => {
    for (const channelId of ['cli', 'smoke-test', 'web']) {
      expect(delegationFailureAudience({ originator: undefined, channelId, delegated: false }))
        .toEqual({ audience: 'principal', basis: 'principal_only_channel' });
    }
  });

  it('fails closed to the sender on a human channel when the originator cannot say otherwise', () => {
    // The content-block rewrite retry is relayed to the original sender with no originator.
    expect(delegationFailureAudience({ originator: undefined, channelId: 'email', delegated: false }))
      .toEqual({ audience: 'sender', basis: 'originator_missing' });
    // A stored originator with no role field (late-delegation accepts one) is not the principal.
    const noRole = { ...external, systemRole: undefined } as unknown as Parameters<typeof delegationFailureAudience>[0]['originator'];
    expect(audienceOf({ originator: noRole, channelId: 'email', delegated: false })).toBe('sender');
  });
});

describe('narration transcript (#1860)', () => {
  it('drops tool blocks so the narration call does not require a tools list', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Trim the k8m5 draft' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Asking the social team.' },
          { type: 'tool_use', id: 'call-1', name: 'delegate', input: { agent: 'social-media', task: 'Trim the k8m5 draft' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '{"agent":"social-media","failed":true}' }],
      },
    ];
    const narrated = transcriptForNarration(messages);
    expect(narrated).toEqual([
      { role: 'user', content: 'Trim the k8m5 draft' },
      { role: 'assistant', content: 'Asking the social team.' },
    ]);
    expect(JSON.stringify(narrated)).not.toContain('tool_use');
    expect(JSON.stringify(narrated)).not.toContain('tool_result');
  });
});
