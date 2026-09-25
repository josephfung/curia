import { describe, it, expect } from 'vitest';
import { containsRawAgentId, principalAgentLabel } from '../../../src/agents/agent-display-name.js';
import {
  formatDelegationFailureFallback,
  selectDelegationFailureReply,
} from '../../../src/agents/delegation-failure-reply.js';

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
});
