import { describe, it, expect } from 'vitest';
import {
  attributeOutboundEntry,
  canonicalDelegationHint,
  relayRequesterFor,
  rosterFromRegistry,
  type DelegationHintRoster,
} from '../../../src/dispatch/delegation-hint.js';
import { AgentRegistry } from '../../../src/agents/agent-registry.js';

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

describe('canonicalDelegationHint (#1972)', () => {
  const roster = makeRoster();

  it('keeps a bare specialist id', () => {
    expect(canonicalDelegationHint('ceo-inbox', undefined, roster)).toBe('ceo-inbox');
  });

  it('reduces free text that names exactly one specialist to that id', () => {
    // Forms seen in production relays.
    expect(canonicalDelegationHint('Delegate replies to ceo-inbox', undefined, roster)).toBe('ceo-inbox');
    expect(canonicalDelegationHint('ceo-inbox scheduling escalation', undefined, roster)).toBe('ceo-inbox');
    expect(canonicalDelegationHint('CEO-INBOX routing', undefined, roster)).toBe('ceo-inbox');
  });

  it('drops a hint that names no specialist', () => {
    // `calendar-specialist` is not an agent id; a token match must not read it as `calendar`.
    expect(canonicalDelegationHint('calendar-specialist', undefined, roster)).toBeNull();
    expect(canonicalDelegationHint('someone should look at this', undefined, roster)).toBeNull();
  });

  it('drops a hint that names the coordinator — it is the router, not an owner', () => {
    expect(canonicalDelegationHint('coordinator', undefined, roster)).toBeNull();
  });

  it('drops a hint that names more than one specialist', () => {
    expect(canonicalDelegationHint('ceo-inbox or calendar', undefined, roster)).toBeNull();
  });

  it('drops an empty or whitespace hint', () => {
    expect(canonicalDelegationHint('', undefined, roster)).toBeNull();
    expect(canonicalDelegationHint('   ', undefined, roster)).toBeNull();
    expect(canonicalDelegationHint(undefined, undefined, roster)).toBeNull();
  });

  it('keeps the clarification-pending form only when a resume_token backs it', () => {
    const withToken = { resume_token: 'tok-123' };
    expect(canonicalDelegationHint('ceo-inbox clarification pending', withToken, roster))
      .toBe('ceo-inbox clarification pending');
    // No token: the marker would promise a resume that cannot happen.
    expect(canonicalDelegationHint('ceo-inbox clarification pending', undefined, roster)).toBe('ceo-inbox');
    expect(canonicalDelegationHint('ceo-inbox clarification pending', { resume_token: '' }, roster)).toBe('ceo-inbox');
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
});
