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
// Three rules, in order, applied at the one place every send skill registers an
// entry (ScopedOutboundContext.register):
//
// 1. An entry carrying a `resume_token` relays a specialist's clarification
//    question. Its owner is the agent the token was minted for (the runtime
//    writes that, not the model), and its hint is `<agent> clarification pending`,
//    the form the coordinator's clarification-resume flow looks for.
// 2. A send made on a bullpen wake, where a specialist opened the thread and
//    mentioned the sending agent, is a relay on that specialist's behalf. The
//    entry is attributed to that specialist — agent_id and hint both — whatever
//    the model wrote. ceo-inbox reaches the principal only this way: it has no
//    send tools and asks the coordinator to send for it.
// 3. Any other hint keeps only its leading word, and only when that word is a
//    registered specialist; otherwise the hint is dropped. Leading word only,
//    because `calendar`, `contacts` and `diagnostics` are also English words, and
//    the coordinator treats any hint as a binding hand-off — a hint that merely
//    mentions a specialist must not become one.

import type { AgentRegistry } from '../agents/agent-registry.js';
import { decodeResumeToken } from '../agents/resume-token.js';
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

/**
 * The specialist a clarification-pending entry resumes, read from its
 * `resume_token`, or null when the entry carries no decodable token for a
 * registered specialist. The token's agent is minted by the runtime when the
 * specialist calls request-clarification, so it is not model-written.
 */
export function clarificationAgent(
  metadata: Record<string, unknown> | undefined,
  roster: DelegationHintRoster,
): string | null {
  const token = metadata?.[RESUME_TOKEN_KEY];
  if (typeof token !== 'string' || token.length === 0) return null;
  const agent = decodeResumeToken(token)?.agent;
  return agent && roster.isSpecialist(agent) ? agent : null;
}

/** The hint's leading word, lowercased and stripped of punctuation (`ceo-inbox:` → `ceo-inbox`). */
function leadingWord(raw: string | undefined): string {
  const first = raw?.trim().split(/\s+/)[0] ?? '';
  return first.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

/**
 * Reduce a hint to its canonical form, or null when it names no specialist.
 * Rule 1 then rule 3 from the header; the relay rule needs the invoking task,
 * so it lives in attributeOutboundEntry.
 */
export function canonicalDelegationHint(
  raw: string | undefined,
  metadata: Record<string, unknown> | undefined,
  roster: DelegationHintRoster,
): string | null {
  const resumes = clarificationAgent(metadata, roster);
  if (resumes) return `${resumes} ${CLARIFICATION_PENDING_SUFFIX}`;
  const lead = leadingWord(raw);
  return lead && roster.isSpecialist(lead) ? lead : null;
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
  /** Rule 1: the specialist the entry's resume_token resumes. */
  resumes?: string;
  /** Rule 2: the specialist the send was relayed for. */
  relayRequester?: string;
  /** The model-written agent_id that rule 1 or 2 replaced. */
  agentIdFrom?: string;
  /** The model-written hint that was rewritten. */
  hintFrom?: string;
  /** The model-written hint that named no specialist and was removed. */
  hintDropped?: string;
  /**
   * The hint promised a clarification resume, but the entry has no usable
   * resume_token — the coordinator will re-delegate fresh instead of resuming.
   */
  resumeTokenMissing?: true;
}

/** Apply the three rules in the header to an entry about to be registered. */
export function attributeOutboundEntry(
  entry: EntryInput,
  opts: { roster: DelegationHintRoster; relayRequester: string | null },
): { entry: EntryInput; changes: AttributionChanges } {
  const { roster, relayRequester } = opts;
  const changes: AttributionChanges = {};
  const raw = entry.delegationHint;

  // Rule 1 outranks the relay: when ceo-inbox's relay wake delegated to calendar
  // and calendar asked a question, the entry must resume calendar, not ceo-inbox.
  const resumes = clarificationAgent(entry.metadata, roster);
  let owner: string | null = null;
  let hint: string | null;
  if (resumes) {
    changes.resumes = resumes;
    owner = resumes;
    hint = `${resumes} ${CLARIFICATION_PENDING_SUFFIX}`;
  } else if (relayRequester) {
    changes.relayRequester = relayRequester;
    owner = relayRequester;
    hint = relayRequester;
  } else {
    hint = canonicalDelegationHint(raw, entry.metadata, roster);
  }
  let agentId = entry.agentId;
  if (owner && agentId !== owner) {
    changes.agentIdFrom = agentId;
    agentId = owner;
  }
  if (raw && hint === null) changes.hintDropped = raw;
  if (raw && hint !== null && hint !== raw) changes.hintFrom = raw;
  if (!resumes && raw?.toLowerCase().includes(CLARIFICATION_PENDING_SUFFIX)) changes.resumeTokenMissing = true;

  const attributed: EntryInput = { ...entry, agentId };
  if (hint !== null) attributed.delegationHint = hint;
  else delete attributed.delegationHint;
  return { entry: attributed, changes };
}
