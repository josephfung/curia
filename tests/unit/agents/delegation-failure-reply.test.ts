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

  it('the fallback promises to follow up and mentions no internal follow-up task', () => {
    for (const branch of branches) {
      const text = formatDelegationFailureFallback({ ...sender, ...branch });
      expect(text).toMatch(/^I /);
      expect(text).toContain("I'll follow up with you on it.");
      expect(text).not.toMatch(/logged|follow-up task|review the outcome|principal/i);
    }
    // The principal still hears that the follow-up was logged.
    expect(formatDelegationFailureFallback({ ...sender, audience: 'principal' }))
      .toContain("I've logged a follow-up task to review the outcome.");
  });

  it('the fallback promises nothing when no follow-up was logged', () => {
    for (const branch of branches) {
      const text = formatDelegationFailureFallback({ ...sender, ...branch, escalated: false });
      expect(text).not.toMatch(/follow up|follow-up|logged/i);
    }
  });

  it('the prompt names the sender as the reader and rules out notes for the principal', () => {
    const prompt = delegationFailureNarrationPrompt({ ...sender });
    expect(prompt).toMatch(/in reply to the person who sent this message/);
    expect(prompt).toMatch(/They are not the principal/);
    expect(prompt).toMatch(/no note, aside or postscript for the principal/);
    expect(prompt).not.toMatch(/for the principal failed/);
    // The logged task is not handed to the model as something to tell the sender.
    expect(prompt).not.toMatch(/follow-up task/i);
    expect(prompt).toMatch(/you may say you will follow up/);
    expect(delegationFailureNarrationPrompt({ ...sender, escalated: false })).toMatch(/do not promise to follow up/);
    // Still no specialist vocabulary outside the line forbidding it.
    const others = prompt.split('\n').filter((line) => !/do not mention specialists/i.test(line));
    expect(others.join('\n')).not.toMatch(/specialist|delegat/i);
  });

  it('the principal prompt is unchanged in substance', () => {
    const prompt = delegationFailureNarrationPrompt({ ...sender, audience: 'principal' });
    expect(prompt).toMatch(/for the principal failed/);
    expect(prompt).toContain('A follow-up task has already been logged.');
    expect(prompt).not.toMatch(/They are not the principal/);
  });

  it('keeps a clean draft written to the sender', () => {
    const clean = "Thanks for confirming the board dinner venue. I couldn't finish setting it up just yet, and I'll follow up with you shortly.";
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

  it('rejects an echo of the sender-only instruction', () => {
    const selected = selectDelegationFailureReply({
      ...sender,
      modelText: reply('Write only to them. Add no note, aside or postscript about the board dinner venue.'),
    });
    expect(selected.rejected).toBe('prompt_echo');
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

  it('is the sender on an inbound from anyone who is not the principal, resolved or not', () => {
    expect(delegationFailureAudience({ originator: external, channelId: 'email', delegated: false })).toBe('sender');
    expect(delegationFailureAudience({
      originator: { ...external, contactId: 'stranger@example.test', tier: 'unknown' },
      channelId: 'signal',
      delegated: false,
    })).toBe('sender');
  });

  it('is the principal on the principal\'s own inbound', () => {
    expect(delegationFailureAudience({
      originator: { ...external, systemRole: 'principal', tier: 'principal' },
      channelId: 'email',
      delegated: false,
    })).toBe('principal');
  });

  it('is the principal where no outside sender reads the reply', () => {
    // A delegated specialist answers the agent that delegated, even on external lineage.
    expect(delegationFailureAudience({ originator: external, channelId: 'internal', delegated: true })).toBe('principal');
    for (const channelId of ['scheduler', 'bullpen', 'internal']) {
      expect(delegationFailureAudience({ originator: external, channelId, delegated: false })).toBe('principal');
    }
    expect(delegationFailureAudience({
      originator: { ...external, systemRole: 'system', tier: null },
      channelId: 'email',
      delegated: false,
    })).toBe('principal');
    expect(delegationFailureAudience({ originator: undefined, channelId: 'email', delegated: false })).toBe('principal');
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
