// src/dispatch/delegation-hint.ts
//
// Code-owned attribution for outbound-context entries (#1972).
//
// An entry's `delegation_hint` names the specialist that owns any reply to the
// message. The coordinator treats a matched entry with a hint as
// transfer-ownership and routes the reply to that specialist. Until #1972 both
// the hint and the entry's `agent_id` were whatever the model wrote into the
// send skill's `context_bridge` JSON. In production that produced nine
// different spellings of "ceo-inbox", hints naming agents that do not exist
// (`calendar-specialist`) or the coordinator itself, and relays that dropped
// the hint entirely, so the principal's reply to a specialist's follow-up
// reached the coordinator as an unowned message.
//
// Two rules, applied at the one place every send skill registers an entry
// (ScopedOutboundContext.register):
//
// 1. A send made on a bullpen wake, where a specialist opened the thread and
//    mentioned the sending agent, is a relay on that specialist's behalf. The
//    entry is attributed to that specialist — agent_id and hint both — whatever
//    the model wrote. ceo-inbox reaches the principal only this way: it has no
//    send tools and asks the coordinator to send for it.
// 2. Any other hint is reduced to a registered specialist id, or dropped. The
//    one structured form kept is `<agent> clarification pending`, and only when
//    the entry carries the `resume_token` that the coordinator's
//    clarification-resume flow needs.

import type { AgentRegistry } from '../agents/agent-registry.js';
import type { OutboundContextEntry } from './outbound-context.js';

/** Suffix of the clarification-resume hint form (`<agent> clarification pending`). */
export const CLARIFICATION_PENDING_SUFFIX = 'clarification pending';

/** Metadata key the coordinator's clarification-resume flow stores the token under. */
const RESUME_TOKEN_KEY = 'resume_token';

/**
 * Task-metadata key the BullpenDispatcher stamps with the agent that opened the
 * thread. Shared so the writer and the reader below cannot drift apart.
 */
export const THREAD_CREATOR_AGENT_ID_KEY = 'threadCreatorAgentId';

/** The view of the agent roster these rules need. */
export interface DelegationHintRoster {
  /** True for a registered agent that can own an exchange: anything but the coordinator. */
  isSpecialist(agentId: string): boolean;
}

export function rosterFromRegistry(registry: AgentRegistry): DelegationHintRoster {
  return {
    isSpecialist: (agentId) => {
      const entry = registry.get(agentId);
      return entry !== undefined && entry.role !== 'coordinator';
    },
  };
}

function hasResumeToken(metadata: Record<string, unknown> | undefined): boolean {
  const token = metadata?.[RESUME_TOKEN_KEY];
  return typeof token === 'string' && token.length > 0;
}

/**
 * Reduce a model-written hint to the specialist it names, or null.
 *
 * Matching is by whole token (agent names are lowercase with hyphens), so
 * `calendar-specialist` does not match `calendar`. A hint naming more than one
 * specialist is ambiguous and dropped rather than guessed at.
 */
export function canonicalDelegationHint(
  raw: string | undefined,
  metadata: Record<string, unknown> | undefined,
  roster: DelegationHintRoster,
): string | null {
  if (!raw) return null;
  const tokens = raw.toLowerCase().split(/[^a-z0-9_-]+/).filter((t) => t.length > 0);
  const named = [...new Set(tokens.filter((t) => roster.isSpecialist(t)))];
  if (named.length !== 1) return null;
  const agent = named[0]!;
  return hasResumeToken(metadata) && raw.toLowerCase().includes(CLARIFICATION_PENDING_SUFFIX)
    ? `${agent} ${CLARIFICATION_PENDING_SUFFIX}`
    : agent;
}

/**
 * The specialist a send is relayed for, or null when the send is the agent's own.
 *
 * The channel check is what makes this trustworthy: only the BullpenDispatcher
 * creates tasks on the `bullpen` channel, so a scheduled job's payload metadata
 * cannot claim a relay. The thread's opener, not the sender of the latest post,
 * owns the exchange: when the coordinator opened a consult thread, the
 * specialist's answer is input to the coordinator's own reply.
 */
export function relayRequesterFor(opts: {
  channelId: string | undefined;
  taskMetadata: Record<string, unknown> | undefined;
  invokingAgentId: string | undefined;
  roster: DelegationHintRoster;
}): string | null {
  const { channelId, taskMetadata, invokingAgentId, roster } = opts;
  if (channelId !== 'bullpen' || !taskMetadata) return null;
  if (taskMetadata['taskOrigin'] !== 'bullpen' || taskMetadata['mentioned'] !== true) return null;
  const creator = taskMetadata[THREAD_CREATOR_AGENT_ID_KEY];
  if (typeof creator !== 'string' || creator === invokingAgentId) return null;
  return roster.isSpecialist(creator) ? creator : null;
}

type EntryInput = Omit<OutboundContextEntry, 'conversationId'>;

/** What attribution changed, for the registration log. Empty when nothing did. */
export interface AttributionChanges {
  relayRequester?: string;
  /** The model-written agent_id that a relay replaced. */
  agentIdFrom?: string;
  /** The model-written hint that was rewritten. */
  hintFrom?: string;
  /** The model-written hint that named no specialist and was removed. */
  hintDropped?: string;
}

/** Apply the two rules above to an entry about to be registered. */
export function attributeOutboundEntry(
  entry: EntryInput,
  opts: { roster: DelegationHintRoster; relayRequester: string | null },
): { entry: EntryInput; changes: AttributionChanges } {
  const { roster, relayRequester } = opts;
  const changes: AttributionChanges = {};
  const raw = entry.delegationHint;

  let agentId = entry.agentId;
  let hint: string | null;
  if (relayRequester) {
    changes.relayRequester = relayRequester;
    if (agentId !== relayRequester) changes.agentIdFrom = agentId;
    agentId = relayRequester;
    hint = hasResumeToken(entry.metadata) && raw?.toLowerCase().includes(CLARIFICATION_PENDING_SUFFIX)
      ? `${relayRequester} ${CLARIFICATION_PENDING_SUFFIX}`
      : relayRequester;
  } else {
    hint = canonicalDelegationHint(raw, entry.metadata, roster);
    if (raw && hint === null) changes.hintDropped = raw;
  }
  if (raw && hint !== null && hint !== raw) changes.hintFrom = raw;

  const attributed: EntryInput = { ...entry, agentId };
  if (hint !== null) attributed.delegationHint = hint;
  else delete attributed.delegationHint;
  return { entry: attributed, changes };
}
