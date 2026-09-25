import { describe, it, expect } from 'vitest';
import { containsRawAgentId, principalAgentLabel, redactRawAgentId } from '../../../src/agents/agent-display-name.js';
import {
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

  it('treats a single-word id as leaked unless it is the specialist phrase', () => {
    expect(containsRawAgentId('the calendar specialist', 'calendar')).toBe(false);
    expect(containsRawAgentId('the calendar', 'calendar')).toBe(true);
  });

  it('redacts a single-word id only in harness shapes, not in prose', () => {
    const label = 'calendar specialist';
    expect(redactRawAgentId('the calendar is full', 'calendar', label)).toBe('the calendar is full');
    expect(redactRawAgentId("I don't have write access to that calendar", 'calendar', label))
      .toBe("I don't have write access to that calendar");
    expect(redactRawAgentId('calendarId', 'calendar', label)).toBe('calendarId');
    expect(redactRawAgentId('the calendar specialist', 'calendar', label)).toBe('the calendar specialist');
    expect(redactRawAgentId("Specialist 'calendar' refused", 'calendar', label))
      .toBe(`Specialist '${label}' refused`);
    expect(redactRawAgentId('Specialist "Calendar" refused', 'calendar', label))
      .toBe(`Specialist "${label}" refused`);
    expect(redactRawAgentId('ask @calendar about it', 'calendar', label)).toBe(`ask ${label} about it`);
    expect(redactRawAgentId('Social-Media refused', 'social-media', 'social team')).toBe('social team refused');
  });
});

describe('delegation failure reply selection (#1860)', () => {
  const base = {
    displayName: 'social team',
    agentId: 'social-media',
    escalated: true,
    delegateTask: 'Trim the k8m5 draft',
  };

  it('quotes the request on every fallback branch and never the registry id', () => {
    const branches = [
      { reason: 'timeout', possiblySucceeded: true },
      { reason: 'blocked' },
      { reason: 'tool_error' },
      { reason: 'specialist_decline', declined: true, detail: "Specialist 'social-media' refused" },
    ];
    const texts = branches.map((branch) => formatDelegationFailureFallback({ ...base, ...branch }));
    for (const text of texts) {
      expect(text).not.toContain('social-media');
      expect(text).toContain('social team');
      expect(text).toContain('Trim the k8m5 draft');
    }
    expect(new Set(texts).size).toBe(branches.length);
    expect(texts[0]).toMatch(/background|completing/i);
    expect(texts[3]).toContain("'social team' refused");

    const calendarProse = formatDelegationFailureFallback({
      displayName: 'calendar specialist',
      agentId: 'calendar',
      reason: 'specialist_decline',
      declined: true,
      escalated: false,
      delegateTask: 'Move Thursday',
      detail: "I don't have write access to that calendar",
    });
    expect(calendarProse).toContain("I don't have write access to that calendar");
    expect(calendarProse).not.toContain('calendar specialist specialist');
  });

  it('keeps a model draft that names the request and hides the id', () => {
    const modelText = 'The social team did not finish "Trim the k8m5 draft" in time.';
    const selected = selectDelegationFailureReply({ ...base, reason: 'timeout', modelText });
    expect(selected.via).toBe('model');
    expect(selected.content).toBe(modelText);
  });

  it('rejects a model draft that leaks the registry id or ignores the request', () => {
    const leaked = selectDelegationFailureReply({
      ...base,
      reason: 'timeout',
      modelText: 'I was not able to reach social-media about "Trim the k8m5 draft".',
    });
    expect(leaked.via).toBe('fallback');
    expect(leaked.content).not.toContain('social-media');

    const generic = selectDelegationFailureReply({
      ...base,
      reason: 'blocked',
      modelText: 'Something went wrong with the social team.',
    });
    expect(generic.via).toBe('fallback');
    expect(generic.content).toContain('Trim the k8m5 draft');
  });

  it('two different requests are not the same fallback sentence', () => {
    const first = formatDelegationFailureFallback({ ...base, reason: 'timeout', delegateTask: 'Trim the k8m5 draft' });
    const second = formatDelegationFailureFallback({ ...base, reason: 'timeout', delegateTask: 'Shorten the Friday post' });
    expect(first).not.toBe(second);
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
