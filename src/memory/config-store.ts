// src/memory/config-store.ts
//
// Lightweight KG-backed key-value store for system infrastructure code.
// Mirrors the logic in skills/config-store/handler.ts but without SkillContext
// overhead, so non-agent callers (e.g. EmailAdapter, ceo-inbox-list) can read
// and write config values directly.
//
// Storage model (same as the skill):
//   Namespace anchor: type=concept, label="config:{namespace}"
//   Per-key facts on the anchor: label=key, properties: { key, value, namespace }, decayClass=permanent
//
// Writes use confidence=0.9 so the dedup path auto-resolves updates. The skill
// uses 1.0, which would produce a 'conflict' result when writing the same key
// twice. At 0.9, the second write (equal cosine similarity, higher confidence
// than the stored 0.9 only on the very first write — after that equal) may
// produce conflict too, but the storeFact dedup logic treats the first stored
// node as authoritative and updates its properties in place for the 'update'
// action. Handling: log a warning and continue — the value stored on the
// PREVIOUS call is still valid, so a failed write is non-fatal for heartbeat use.

import type { EntityMemory } from './entity-memory.js';
import type { Logger } from '../logger.js';

// Fixed source string — never attributed to any agent task, so not subject to
// per-task rate limiting.
const SYSTEM_SOURCE = 'system:config-store';

function anchorLabel(namespace: string): string {
  return `config:${namespace}`;
}

export class ConfigStore {
  constructor(
    private readonly entityMemory: EntityMemory,
    private readonly logger: Logger,
  ) {}

  /**
   * Read a stored value. Returns null when the namespace has never been written
   * to, or when the key does not exist within the namespace.
   *
   * Propagates infrastructure errors (DB down, KG unavailable, etc.) so callers
   * can distinguish "key not found" (null) from "read failed" (thrown error).
   * Callers that want fall-through-on-error behaviour must catch explicitly.
   */
  async get(namespace: string, key: string): Promise<string | null> {
    const anchors = await this.entityMemory.findEntities(anchorLabel(namespace));
    if (anchors.length === 0) return null;

    const allFacts = await Promise.all(anchors.map((a) => this.entityMemory.getFacts(a.id)));
    const facts = allFacts.flat();

    // Primary match on label; fallback on properties.key for forward-compat.
    // Pick the most-recently confirmed fact when there are duplicates (e.g. from
    // a race between two concurrent anchor-create calls, which is unlikely in
    // practice but possible across restarts).
    const matching = facts.filter(
      (f) => f.label === key || (f.properties.key as string | undefined) === key,
    );
    const fact = matching.sort(
      (a, b) => b.temporal.lastConfirmedAt.getTime() - a.temporal.lastConfirmedAt.getTime(),
    )[0];

    if (!fact) return null;
    return (fact.properties.value as string) ?? null;
  }

  /**
   * Write or update a value. Propagates infrastructure errors after logging so
   * callers (e.g. EmailAdapter.poll) can catch and emit their own diagnostic.
   * A soft storeFact rejection (result.stored === false) is logged as a warning
   * and does not throw — the prior value is still valid in that case.
   */
  async set(namespace: string, key: string, value: string): Promise<void> {
    try {
      const anchor = await this.findOrCreateAnchor(namespace);

      // confidence=0.9 (not 1.0) so the dedup path can auto-resolve updates:
      // a second write with equal cosine similarity and 0.9 confidence against
      // an existing 0.9 node triggers 'conflict', but a first write at 0.9
      // followed by a second at 0.9 on the same label uses the dedup
      // 'auto_resolved' path when the new value has the same or higher confidence.
      // In practice the write may occasionally be rejected with stored=false;
      // we log and continue — the prior value is still valid.
      const result = await this.entityMemory.storeFact({
        entityNodeId: anchor.id,
        label: key,
        properties: { key, value, namespace },
        confidence: 0.9,
        decayClass: 'permanent',
        source: SYSTEM_SOURCE,
      });

      if (!result.stored) {
        this.logger.warn(
          { namespace, key, action: result.action },
          'ConfigStore.set: storeFact rejected the write — prior value still in effect',
        );
      }
    } catch (err) {
      // Log at the ConfigStore level for observability, then rethrow so callers
      // can emit their own domain-specific diagnostic (e.g. "failed to persist
      // poll watermark") without relying on log correlation.
      this.logger.error({ err, namespace, key }, 'ConfigStore.set: failed to write value');
      throw err;
    }
  }

  private async findOrCreateAnchor(namespace: string): Promise<{ id: string }> {
    const label = anchorLabel(namespace);
    const existing = await this.entityMemory.findEntities(label);
    if (existing.length > 0) return existing[0]!;

    const { entity } = await this.entityMemory.createEntity({
      type: 'concept',
      label,
      properties: { category: 'config', namespace },
      source: SYSTEM_SOURCE,
    });
    return entity;
  }
}
