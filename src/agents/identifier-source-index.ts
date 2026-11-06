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
  /** Keys kept per conversation (and per agent-input scope); the oldest go first. Default 5 000. */
  maxKeysPerConversation?: number;
  /** Conversations kept; the least recently recorded goes first. Default 500. */
  maxConversations?: number;
  /**
   * Agent-input scopes kept (conversations and browser sessions, #2498). Default 2 000:
   * kept apart from the sources and larger, so heavy browsing neither evicts conversations'
   * sources nor drops a live session's typing early. Only email and phone keys are held.
   */
  maxAgentInputScopes?: number;
  now?: () => number;
}

/**
 * Keys per scope with a TTL and two caps. Map iteration order is insertion order:
 * re-inserting moves an entry to the end, so the first entry is always the oldest, for
 * scopes (by last record) and for the keys inside each.
 */
class ScopedKeys {
  private readonly scopes = new Map<string, { recordedAt: number; keys: Map<string, number> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxKeys: number,
    private readonly maxScopes: number,
  ) {}

  add(scope: string, found: ReadonlySet<string>, now: number): void {
    // Scopes are ordered by last record, so expired ones sit at the front.
    for (const [key, entry] of this.scopes) {
      if (now - entry.recordedAt <= this.ttlMs) break;
      this.scopes.delete(key);
    }
    const entry = this.scopes.get(scope) ?? { recordedAt: now, keys: new Map<string, number>() };
    entry.recordedAt = now;
    this.scopes.delete(scope);
    this.scopes.set(scope, entry);
    for (const key of found) {
      entry.keys.delete(key);
      entry.keys.set(key, now);
    }
    for (const oldest of entry.keys.keys()) {
      if (entry.keys.size <= this.maxKeys) break;
      entry.keys.delete(oldest);
    }
    for (const oldest of this.scopes.keys()) {
      if (this.scopes.size <= this.maxScopes) break;
      this.scopes.delete(oldest);
    }
  }

  has(scope: string, key: string, now: number): boolean {
    const addedAt = this.scopes.get(scope)?.keys.get(key);
    return addedAt !== undefined && now - addedAt <= this.ttlMs;
  }

  get size(): number {
    return this.scopes.size;
  }
}

export class IdentifierSourceIndex {
  private readonly now: () => number;
  /** Identifiers found in source-tool results, per conversation. */
  private readonly sources: ScopedKeys;
  /**
   * Identifiers the agent supplied to echo-prone source tools (#2498), per conversation
   * and per browser session: never taken from such a tool's result.
   */
  private readonly agentInput: ScopedKeys;

  constructor(options: IdentifierSourceIndexOptions = {}) {
    const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    const maxKeys = options.maxKeysPerConversation ?? 5_000;
    this.sources = new ScopedKeys(ttlMs, maxKeys, options.maxConversations ?? 500);
    this.agentInput = new ScopedKeys(ttlMs, maxKeys, options.maxAgentInputScopes ?? 2_000);
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
    const now = this.now();
    for (const scope of options.excludeAgentInputOf ?? []) {
      for (const key of found) if (this.agentInput.has(scope, key, now)) found.delete(key);
    }
    if (found.size === 0) return;
    this.sources.add(conversationKey, found, now);
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
    this.agentInput.add(scopeKey, found, this.now());
  }

  has(conversationKey: string, key: string): boolean {
    return this.sources.has(conversationKey, key, this.now());
  }

  /** Conversations currently held — for tests and diagnostics. */
  get size(): number {
    return this.sources.size;
  }
}

/** The index every agent runtime in this process shares unless its config supplies one. */
export const sharedIdentifierSourceIndex = new IdentifierSourceIndex();
