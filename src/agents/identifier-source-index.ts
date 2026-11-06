// identifier-source-index.ts — identifiers seen in source-tool results, per conversation
// (#2061, ADR-047).
//
// When a tool whose manifest sets `provenance_source` returns (a web page, a document,
// a mail listing), the runtime records the identifiers in its result under the task's
// root conversation. A delegated specialist records under the conversation it came
// from, so a page a specialist read counts when the coordinator then creates the
// contact, and the reverse. Contact skills look identifiers up here before verifying.
//
// What the agent supplies to web-fetch and web-browser is recorded too (#2498), so a page
// that repeats it (a search page showing its query, a form showing what was typed) cannot
// verify it: such a result never contributes a key the agent supplied first.
//
// Process memory only. Tool results are not persisted anywhere an agent could write,
// and losing the index (restart, TTL) only means a later write is refused and the
// agent asks again — it never verifies anything.

import { sourceKeysInText } from '../contacts/identifier-provenance.js';

export interface IdentifierSourceIndexOptions {
  /** How long a recorded key counts. Default 24 hours. */
  ttlMs?: number;
  /** Keys kept per conversation; the oldest go first. Default 5 000. */
  maxKeysPerConversation?: number;
  /** Conversations kept; the least recently recorded goes first. Default 500. */
  maxConversations?: number;
  now?: () => number;
}

interface ConversationEntry {
  recordedAt: number;
  /** Identifiers found in source-tool results, with when each was last seen. */
  keys: Map<string, number>;
  /** Identifiers the agent supplied to echo-prone source tools (#2498). */
  agentKeys: Map<string, number>;
}

export class IdentifierSourceIndex {
  private readonly ttlMs: number;
  private readonly maxKeys: number;
  private readonly maxConversations: number;
  private readonly now: () => number;
  // Map iteration order is insertion order: re-inserting moves an entry to the end,
  // so the first entry is always the oldest — for conversations (by last record) and
  // for the keys inside each.
  // `agentKeys` holds what the agent supplied to echo-prone tools (#2498): those keys are
  // never taken from such a tool's result. Both maps share the conversation's lifetime,
  // so evicting a conversation drops its sources and its agent input together.
  private readonly conversations = new Map<string, ConversationEntry>();

  constructor(options: IdentifierSourceIndexOptions = {}) {
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxKeys = options.maxKeysPerConversation ?? 5_000;
    this.maxConversations = options.maxConversations ?? 500;
    this.now = options.now ?? Date.now;
  }

  /**
   * Record the identifiers in a source-tool result under `conversationKey`. For an
   * echo-prone tool (#2498), `excludeAgentInputOf` names the scopes (the conversation, a
   * browser session) whose recorded agent input is left out: the result may only be
   * repeating it.
   */
  record(conversationKey: string, text: string, options: { excludeAgentInputOf?: readonly string[] } = {}): void {
    const found = sourceKeysInText(text);
    if (found.size === 0) return;

    const now = this.now();
    for (const scope of options.excludeAgentInputOf ?? []) {
      const agentKeys = this.live(scope, now)?.agentKeys;
      if (agentKeys) {
        for (const key of found) if (agentKeys.has(key)) found.delete(key);
      }
    }
    if (found.size === 0) return;
    this.add(conversationKey, found, now, 'keys');
  }

  /**
   * Record what the agent supplied to an echo-prone source tool under `scopeKey` (a
   * conversation, or a browser session's scope), before the call runs (#2498). Only email
   * and phone keys are kept: those are what a web page can verify for a send, and opaque
   * tokens (element refs, typed codes, passwords) would crowd them out of the cap and keep
   * typed secrets in memory for no gain.
   */
  recordAgentInput(scopeKey: string, text: string): void {
    const found = new Set([...sourceKeysInText(text)].filter((key) => key.startsWith('email:') || key.startsWith('phone:')));
    if (found.size === 0) return;
    this.add(scopeKey, found, this.now(), 'agentKeys');
  }

  /** The conversation's entry, when it has not expired. */
  private live(conversationKey: string, now: number): ConversationEntry | undefined {
    const conversation = this.conversations.get(conversationKey);
    return conversation && now - conversation.recordedAt <= this.ttlMs ? conversation : undefined;
  }

  private add(conversationKey: string, found: ReadonlySet<string>, now: number, into: 'keys' | 'agentKeys'): void {
    // Conversations are ordered by last record, so expired ones sit at the front.
    for (const [key, conversation] of this.conversations) {
      if (now - conversation.recordedAt <= this.ttlMs) break;
      this.conversations.delete(key);
    }

    const conversation = this.conversations.get(conversationKey)
      ?? { recordedAt: now, keys: new Map<string, number>(), agentKeys: new Map<string, number>() };
    conversation.recordedAt = now;
    this.conversations.delete(conversationKey);
    this.conversations.set(conversationKey, conversation);

    const keys = conversation[into];
    for (const key of found) {
      keys.delete(key);
      keys.set(key, now);
    }
    for (const oldest of keys.keys()) {
      if (keys.size <= this.maxKeys) break;
      keys.delete(oldest);
    }
    for (const oldest of this.conversations.keys()) {
      if (this.conversations.size <= this.maxConversations) break;
      this.conversations.delete(oldest);
    }
  }

  has(conversationKey: string, key: string): boolean {
    const addedAt = this.conversations.get(conversationKey)?.keys.get(key);
    return addedAt !== undefined && this.now() - addedAt <= this.ttlMs;
  }

  /** Conversations currently held — for tests and diagnostics. */
  get size(): number {
    return this.conversations.size;
  }
}

/** The index every agent runtime in this process shares unless its config supplies one. */
export const sharedIdentifierSourceIndex = new IdentifierSourceIndex();
