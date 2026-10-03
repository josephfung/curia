import { describe, it, expect } from 'vitest';
import { containsRawAgentId, principalAgentLabel } from '../../../src/agents/agent-display-name.js';
import {
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

describe('delegation failure reply selection (#1860, #1975)', () => {
  const base = {
    displayName: 'social team',
    agentId: 'social-media',
    escalated: true,
    request: 'Trim the k8m5 draft',
  };

  it('names the specialist on every fallback branch and never the registry id', () => {
    const branches = [
      { reason: 'timeout', possiblySucceeded: true },
      { reason: 'blocked' },
      { reason: 'tool_error' },
      { reason: 'specialist_decline', declined: true },
    ];
    const texts = branches.map((branch) => formatDelegationFailureFallback({ ...base, ...branch }));
    for (const text of texts) {
      expect(text).not.toContain('social-media');
      expect(text).toContain('social team');
    }
    expect(new Set(texts).size).toBe(branches.length);
    expect(texts[0]).toMatch(/background|completing/i);

    const calendar = formatDelegationFailureFallback({
      displayName: 'calendar specialist',
      agentId: 'calendar',
      reason: 'specialist_decline',
      declined: true,
      escalated: false,
      request: 'Move Thursday',
    });
    expect(calendar).not.toContain('calendar specialist specialist');
  });

  it('keeps a model draft that names the request in a domain noun the id shares', () => {
    const ask = 'Check my calendar for Tuesday afternoon';
    const modelText = "I couldn't check Tuesday afternoon for you. The calendar specialist didn't answer in time.";
    const selected = selectDelegationFailureReply({
      displayName: 'calendar specialist',
      agentId: 'calendar',
      reason: 'timeout',
      escalated: true,
      request: ask,
      modelText: reply(modelText),
    });
    expect(selected.via).toBe('model');
    expect(selected.content).toBe(modelText);

    const leaked = selectDelegationFailureReply({
      displayName: 'calendar specialist',
      agentId: 'calendar',
      reason: 'timeout',
      escalated: true,
      request: ask,
      modelText: reply("I couldn't get Tuesday afternoon back from 'calendar'."),
    });
    expect(leaked.via).toBe('fallback');
    expect(leaked.rejected).toBe('agent_id');
    expect(leaked.content).not.toContain("'calendar'");
  });

  it('keeps a model draft that paraphrases the request and hides the id', () => {
    const modelText = "The social team didn't get the k8m5 trim back to me in time.";
    const selected = selectDelegationFailureReply({ ...base, reason: 'timeout', modelText: reply(modelText) });
    expect(selected.via).toBe('model');
    expect(selected.content).toBe(modelText);
  });

  it('rejects a model draft that leaks the registry id or ignores the request', () => {
    const leaked = selectDelegationFailureReply({
      ...base,
      reason: 'timeout',
      modelText: reply('I was not able to reach social-media about the k8m5 draft.'),
    });
    expect(leaked.via).toBe('fallback');
    expect(leaked.content).not.toContain('social-media');

    const generic = selectDelegationFailureReply({
      ...base,
      reason: 'blocked',
      modelText: reply('Something went wrong with the social team.'),
    });
    expect(generic.via).toBe('fallback');
    expect(generic.rejected).toBe('off_topic');
  });

  it('does not count the specialist name as naming the request', () => {
    // "calendar" is in the request and in the display name. A stock line that only
    // names the specialist must not pass the topic check on that word alone.
    const selected = selectDelegationFailureReply({
      displayName: 'calendar specialist',
      agentId: 'calendar',
      reason: 'blocked',
      escalated: false,
      request: "What's on my calendar tomorrow?",
      modelText: reply('The calendar specialist was blocked and could not finish.'),
    });
    expect(selected.via).toBe('fallback');
    expect(selected.rejected).toBe('off_topic');
  });

  it('accepts any clean draft when the request has no content words to check', () => {
    const selected = selectDelegationFailureReply({
      ...base,
      reason: 'timeout',
      request: 'do it',
      modelText: reply("The social team didn't answer in time. I've logged a follow-up."),
    });
    expect(selected.via).toBe('model');
  });
});

describe('delegation failure reply leaks (#1975, #1976)', () => {
  const principalUuid = '6f1c2a9e-4b7d-4e3a-9c51-2d8e7f0a1b34';
  // The brief the coordinator wrote for the specialist. It addresses the specialist,
  // names "the principal" and carries a contact UUID. None of it may reach the reply.
  const brief = `Prepare the principal's (Alex Example, contact ID ${principalUuid}) morning briefing for today, Thursday.`;
  const morning = {
    displayName: 'calendar specialist',
    agentId: 'calendar',
    reason: 'specialist_decline',
    declined: true,
    escalated: false,
    request: 'Prepare the morning briefing for today.',
  };

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
    const clean = "I couldn't put together your morning briefing today. The calendar specialist declined it. Want me to try again in a bit?";
    const draft = `Wait, let me think about what to say.\nThe specialist declined.\n${reply(clean)}`;
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

  it('rejects a reply block that echoes the narration instructions', () => {
    const selected = selectDelegationFailureReply({
      ...morning,
      modelText: reply('A delegated task failed. Write the one message the principal will read. Your morning briefing could not be prepared.'),
    });
    expect(selected.via).toBe('fallback');
    expect(selected.rejected).toBe('prompt_echo');
  });

  it('does not treat restating the follow-up fact as a prompt echo', () => {
    const prompt = delegationFailureNarrationPrompt({
      displayName: 'calendar specialist',
      reason: 'timeout',
      escalated: true,
    });
    expect(prompt).toContain('A follow-up task has already been logged.');
    const selected = selectDelegationFailureReply({
      ...morning,
      reason: 'timeout',
      declined: false,
      escalated: true,
      modelText: reply("I couldn't get your morning briefing in time. A follow-up task has already been logged."),
    });
    expect(selected.via).toBe('model');
  });

  it('rejects a reply block that carries a UUID', () => {
    const selected = selectDelegationFailureReply({
      ...morning,
      modelText: reply(`I couldn't prepare your morning briefing for contact ${principalUuid}.`),
    });
    expect(selected.via).toBe('fallback');
    expect(selected.rejected).toBe('uuid');
    expect(selected.content).not.toContain(principalUuid);
  });

  it('never quotes the request on any fallback branch', () => {
    for (const reason of ['timeout', 'blocked', 'tool_error', 'specialist_decline']) {
      const text = formatDelegationFailureFallback({ ...morning, reason, request: brief });
      expect(text).not.toContain(principalUuid);
      expect(text).not.toMatch(/principal/i);
      expect(text).not.toContain('Alex Example');
      expect(text).not.toContain('...');
    }
  });

  it('does not ask the model to quote anything', () => {
    const prompt = delegationFailureNarrationPrompt({
      displayName: 'calendar specialist',
      reason: 'specialist_decline',
      declined: true,
      escalated: false,
    });
    expect(prompt).not.toMatch(/include this phrase/i);
    expect(prompt).toContain('<reply>');
  });

  it('does not relay the specialist decline prose from #1976', () => {
    // The fallback input no longer carries the decline prose at all. Build the reply
    // for the exact decline in #1976 and check none of its internals appear.
    const text = formatDelegationFailureFallback({
      displayName: 'ceo inbox specialist',
      agentId: 'ceo-inbox',
      reason: 'specialist_decline',
      declined: true,
      escalated: true,
      request: 'Summarize where things stand in the long legal thread with Acme',
    });
    expect(text).toContain('ceo inbox specialist');
    expect(text).toMatch(/declined/i);
    for (const internal of ['nylas_api_key', 'workingDocs', 'doc-search', 'KG', 'specialist-search', 'principal']) {
      expect(text).not.toContain(internal);
    }
  });

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
