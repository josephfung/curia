// identifier-source-index.ts — identifiers seen in source-tool results, per conversation
// (#2061, ADR-047).
//
// When a tool whose manifest sets `provenance_source` returns (a web page, a document,
// a mail listing), the runtime records the identifiers in its result under the task's
// root conversation. A delegated specialist records under the conversation it came
// from, so a page a specialist read counts when the coordinator then creates the
// contact, and the reverse. Contact skills look identifiers up here before verifying.
//
// Process memory only. Tool results are not persisted anywhere an agent could write,
// and losing the index (restart, TTL) only means a later write is refused and the
// agent asks again — it never verifies anything.

import { sourceKeysInText } from '../contacts/identifier-provenance.js';

export interface IdentifierSourceIndexOptions {
  /** How long a recorded key counts. Default 24 hours. */
  ttlMs?: number;
  /** Keys kept per conversation; the oldest go first. Default 20 000. */
  maxKeysPerConversation?: number;
  /** Conversations kept; the least recently recorded goes first. Default 1 000. */
  maxConversations?: number;
  now?: () => number;
}

export class IdentifierSourceIndex {
  private readonly ttlMs: number;
  private readonly maxKeys: number;
  private readonly maxConversations: number;
  private readonly now: () => number;
  // Map iteration order is insertion order: re-inserting moves an entry to the end,
  // so the first entry is always the oldest.
  private readonly conversations = new Map<string, Map<string, number>>();

  constructor(options: IdentifierSourceIndexOptions = {}) {
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxKeys = options.maxKeysPerConversation ?? 20_000;
    this.maxConversations = options.maxConversations ?? 1_000;
    this.now = options.now ?? Date.now;
  }

  record(conversationKey: string, text: string): void {
    const keys = sourceKeysInText(text);
    if (keys.size === 0) return;

    const entries = this.conversations.get(conversationKey) ?? new Map<string, number>();
    this.conversations.delete(conversationKey);
    this.conversations.set(conversationKey, entries);

    const addedAt = this.now();
    for (const key of keys) {
      entries.delete(key);
      entries.set(key, addedAt);
    }
    for (const oldest of entries.keys()) {
      if (entries.size <= this.maxKeys) break;
      entries.delete(oldest);
    }
    for (const oldest of this.conversations.keys()) {
      if (this.conversations.size <= this.maxConversations) break;
      this.conversations.delete(oldest);
    }
  }

  has(conversationKey: string, key: string): boolean {
    const addedAt = this.conversations.get(conversationKey)?.get(key);
    return addedAt !== undefined && this.now() - addedAt <= this.ttlMs;
  }
}

/** The index every agent runtime in this process shares unless its config supplies one. */
export const sharedIdentifierSourceIndex = new IdentifierSourceIndex();
