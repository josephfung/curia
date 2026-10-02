import { describe, it, expect } from 'vitest';
import {
  attributeOutboundEntry,
  canonicalDelegationHint,
  delegationHintOwner,
  relayRequesterFor,
  rosterFromRegistry,
  type DelegationHintRoster,
} from '../../../src/dispatch/delegation-hint.js';
import { AgentRegistry } from '../../../src/agents/agent-registry.js';
import { encodeResumeToken } from '../../../src/agents/resume-token.js';

function makeRoster(): DelegationHintRoster {
  const registry = new AgentRegistry();
  registry.register('coordinator', { role: 'coordinator', description: 'router' });
  registry.register('ceo-inbox', { role: 'specialist', description: 'inbox' });
  registry.register('calendar', { role: 'specialist', description: 'calendar' });
  registry.register('research-analyst', { role: 'specialist', description: 'research' });
  return rosterFromRegistry(registry);
}

const bullpenWake = {
  taskOrigin: 'bullpen',
  threadId: 'thread-1',
  mentioned: true,
  threadCreatorAgentId: 'ceo-inbox',
};

/** A resume_token as the runtime mints it when `agent` calls request-clarification. */
function tokenFor(agent: string): string {
  return encodeResumeToken({ agent, originalTask: 'find a time with Dana', context: 'asked which day' });
}

describe('canonicalDelegationHint (#1972)', () => {
  const roster = makeRoster();

  it('keeps a bare specialist id', () => {
    expect(canonicalDelegationHint('ceo-inbox', undefined, roster)).toBe('ceo-inbox');
  });

  it('keeps the leading word when it is a specialist (forms seen in production)', () => {
    expect(canonicalDelegationHint('ceo-inbox scheduling escalation', undefined, roster)).toBe('ceo-inbox');
    expect(canonicalDelegationHint('CEO-INBOX routing', undefined, roster)).toBe('ceo-inbox');
    expect(canonicalDelegationHint('ceo-inbox: route reply', undefined, roster)).toBe('ceo-inbox');
    // A second specialist later in the text does not make it ambiguous: the lead decides.
    expect(canonicalDelegationHint('ceo-inbox calendar invite handling', undefined, roster)).toBe('ceo-inbox');
  });

  it('drops a hint whose leading word is not a specialist, even if it mentions one', () => {
    // `calendar` is also an English word; a mention must not become a binding hand-off.
    expect(canonicalDelegationHint('principal may mention calendar', undefined, roster)).toBeNull();
    expect(canonicalDelegationHint('Delegate replies to ceo-inbox', undefined, roster)).toBeNull();
    // `calendar-specialist` is not an agent id and must not be read as `calendar`.
    expect(canonicalDelegationHint('calendar-specialist', undefined, roster)).toBeNull();
  });

  it('drops a hint that names the coordinator — it is the router, not an owner', () => {
    expect(canonicalDelegationHint('coordinator', undefined, roster)).toBeNull();
  });

  it('drops an empty or whitespace hint', () => {
    expect(canonicalDelegationHint('', undefined, roster)).toBeNull();
    expect(canonicalDelegationHint('   ', undefined, roster)).toBeNull();
    expect(canonicalDelegationHint(undefined, undefined, roster)).toBeNull();
  });

  it('takes the clarification owner from the resume_token, not the hint text', () => {
    const meta = { resume_token: tokenFor('calendar') };
    expect(canonicalDelegationHint('calendar clarification pending', meta, roster)).toBe('calendar clarification pending');
    // Prose that leads with, or mentions, another specialist cannot redirect the resume.
    expect(canonicalDelegationHint('contacts to confirm; calendar clarification pending', meta, roster))
      .toBe('calendar clarification pending');
    expect(canonicalDelegationHint(undefined, meta, roster)).toBe('calendar clarification pending');
  });

  it('falls back to the leading word when the token is missing or undecodable', () => {
    expect(canonicalDelegationHint('ceo-inbox clarification pending', undefined, roster)).toBe('ceo-inbox');
    expect(canonicalDelegationHint('ceo-inbox clarification pending', { resume_token: 'not-base64-json' }, roster))
      .toBe('ceo-inbox');
  });
});

describe('delegationHintOwner (#1972)', () => {
  const roster = makeRoster();

  it('reads the owning specialist from a canonical hint', () => {
    expect(delegationHintOwner('ceo-inbox', roster)).toBe('ceo-inbox');
    expect(delegationHintOwner('research-analyst clarification pending', roster)).toBe('research-analyst');
  });

  it('returns null for no hint', () => {
    expect(delegationHintOwner(null, roster)).toBeNull();
    expect(delegationHintOwner(undefined, roster)).toBeNull();
    expect(delegationHintOwner('  ', roster)).toBeNull();
  });

  it('treats a legacy free-text hint written before #1972 as unowned, so it stays releasable', () => {
    expect(delegationHintOwner('Delegate replies to ceo-inbox', roster)).toBeNull();
    expect(delegationHintOwner('CEO Inbox should handle', roster)).toBeNull();
    // A legacy hint that happens to lead with a specialist id still resolves.
    expect(delegationHintOwner('ceo-inbox: route reply', roster)).toBe('ceo-inbox');
  });

  it('treats the coordinator as no owner', () => {
    expect(delegationHintOwner('coordinator', roster)).toBeNull();
  });
});

describe('relayRequesterFor (#1972)', () => {
  const roster = makeRoster();

  it('returns the specialist that opened the thread when the coordinator is mentioned on a bullpen wake', () => {
    expect(relayRequesterFor({
      channelId: 'bullpen', taskMetadata: bullpenWake, invokingAgentId: 'coordinator', roster,
    })).toBe('ceo-inbox');
  });

  it('returns null off the bullpen channel, even with bullpen-shaped metadata', () => {
    // A scheduled job's payload metadata must not be able to claim a relay.
    expect(relayRequesterFor({
      channelId: 'scheduler', taskMetadata: bullpenWake, invokingAgentId: 'coordinator', roster,
    })).toBeNull();
  });

  it('returns null on an FYI (unmentioned) wake', () => {
    expect(relayRequesterFor({
      channelId: 'bullpen', taskMetadata: { ...bullpenWake, mentioned: false }, invokingAgentId: 'coordinator', roster,
    })).toBeNull();
  });

  it('returns null when the invoking agent opened the thread (a consult it owns)', () => {
    expect(relayRequesterFor({
      channelId: 'bullpen',
      taskMetadata: { ...bullpenWake, threadCreatorAgentId: 'coordinator' },
      invokingAgentId: 'coordinator',
      roster,
    })).toBeNull();
    expect(relayRequesterFor({
      channelId: 'bullpen', taskMetadata: bullpenWake, invokingAgentId: 'ceo-inbox', roster,
    })).toBeNull();
  });

  it('returns null when the thread creator is not a registered specialist', () => {
    expect(relayRequesterFor({
      channelId: 'bullpen',
      taskMetadata: { ...bullpenWake, threadCreatorAgentId: 'ghost-agent' },
      invokingAgentId: 'coordinator',
      roster,
    })).toBeNull();
  });

  it('returns null when metadata is missing or the creator is not a string', () => {
    expect(relayRequesterFor({ channelId: 'bullpen', taskMetadata: undefined, invokingAgentId: 'coordinator', roster })).toBeNull();
    expect(relayRequesterFor({
      channelId: 'bullpen',
      taskMetadata: { ...bullpenWake, threadCreatorAgentId: 42 },
      invokingAgentId: 'coordinator',
      roster,
    })).toBeNull();
  });
});

describe('attributeOutboundEntry (#1972)', () => {
  const roster = makeRoster();
  const base = { channelId: 'signal', content: 'Dana proposes Wednesday 2pm instead. Accept?' };

  it('attributes a relayed send to the requesting specialist, overriding the model-written bridge', () => {
    const { entry, changes } = attributeOutboundEntry(
      { ...base, agentId: 'coordinator', delegationHint: 'Delegate replies to ceo-inbox', expectedReply: 'yes/no' },
      { roster, relayRequester: 'ceo-inbox' },
    );
    expect(entry.agentId).toBe('ceo-inbox');
    expect(entry.delegationHint).toBe('ceo-inbox');
    // Fields the platform does not own pass through.
    expect(entry.expectedReply).toBe('yes/no');
    expect(changes).toMatchObject({ relayRequester: 'ceo-inbox', agentIdFrom: 'coordinator' });
  });

  it('adds the hint on a relayed send that carried none (escalation and timeout formats)', () => {
    const { entry } = attributeOutboundEntry({ ...base, agentId: 'coordinator' }, { roster, relayRequester: 'ceo-inbox' });
    expect(entry.agentId).toBe('ceo-inbox');
    expect(entry.delegationHint).toBe('ceo-inbox');
  });

  it('canonicalizes the hint on a non-relayed send and leaves agentId alone', () => {
    const { entry, changes } = attributeOutboundEntry(
      { ...base, agentId: 'coordinator', delegationHint: 'research-analyst follow-up' },
      { roster, relayRequester: null },
    );
    expect(entry.agentId).toBe('coordinator');
    expect(entry.delegationHint).toBe('research-analyst');
    expect(changes.hintFrom).toBe('research-analyst follow-up');
  });

  it('removes an unroutable hint and reports it', () => {
    const { entry, changes } = attributeOutboundEntry(
      { ...base, agentId: 'coordinator', delegationHint: 'calendar-specialist' },
      { roster, relayRequester: null },
    );
    expect(entry.delegationHint).toBeUndefined();
    expect(changes.hintDropped).toBe('calendar-specialist');
  });

  it('reports no changes when the entry is already canonical', () => {
    const { entry, changes } = attributeOutboundEntry(
      { ...base, agentId: 'coordinator', delegationHint: 'calendar' },
      { roster, relayRequester: null },
    );
    expect(entry.delegationHint).toBe('calendar');
    expect(changes).toEqual({});
  });

  it('resumes the token\'s specialist on a relay, not the relay requester', () => {
    // ceo-inbox opened the thread; on that wake the coordinator delegated to calendar,
    // which asked a question. The relayed question must resume calendar.
    const { entry, changes } = attributeOutboundEntry(
      {
        ...base,
        agentId: 'coordinator',
        delegationHint: 'calendar clarification pending',
        metadata: { resume_token: tokenFor('calendar') },
      },
      { roster, relayRequester: 'ceo-inbox' },
    );
    expect(entry.agentId).toBe('calendar');
    expect(entry.delegationHint).toBe('calendar clarification pending');
    expect(changes.resumes).toBe('calendar');
    expect(changes.relayRequester).toBeUndefined();
  });

  it('flags a clarification hint with no usable resume_token', () => {
    const { entry, changes } = attributeOutboundEntry(
      { ...base, agentId: 'coordinator', delegationHint: 'ceo-inbox clarification pending' },
      { roster, relayRequester: null },
    );
    expect(entry.delegationHint).toBe('ceo-inbox');
    expect(changes.resumeTokenMissing).toBe(true);
  });
});
