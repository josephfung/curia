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
  /** Keys kept per conversation; the oldest go first. Default 5 000. */
  maxKeysPerConversation?: number;
  /** Conversations kept; the least recently recorded goes first. Default 500. */
  maxConversations?: number;
  now?: () => number;
}

export class IdentifierSourceIndex {
  private readonly ttlMs: number;
  private readonly maxKeys: number;
  private readonly maxConversations: number;
  private readonly now: () => number;
  // Map iteration order is insertion order: re-inserting moves an entry to the end,
  // so the first entry is always the oldest — for conversations (by last record) and
  // for the keys inside each.
  private readonly conversations = new Map<string, { recordedAt: number; keys: Map<string, number> }>();

  constructor(options: IdentifierSourceIndexOptions = {}) {
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxKeys = options.maxKeysPerConversation ?? 5_000;
    this.maxConversations = options.maxConversations ?? 500;
    this.now = options.now ?? Date.now;
  }

  record(conversationKey: string, text: string): void {
    const found = sourceKeysInText(text);
    if (found.size === 0) return;

    const now = this.now();
    // Conversations are ordered by last record, so expired ones sit at the front.
    for (const [key, conversation] of this.conversations) {
      if (now - conversation.recordedAt <= this.ttlMs) break;
      this.conversations.delete(key);
    }

    const conversation = this.conversations.get(conversationKey) ?? { recordedAt: now, keys: new Map<string, number>() };
    conversation.recordedAt = now;
    this.conversations.delete(conversationKey);
    this.conversations.set(conversationKey, conversation);

    for (const key of found) {
      conversation.keys.delete(key);
      conversation.keys.set(key, now);
    }
    for (const oldest of conversation.keys.keys()) {
      if (conversation.keys.size <= this.maxKeys) break;
      conversation.keys.delete(oldest);
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
