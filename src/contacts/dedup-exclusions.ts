import type { StoreFactOptions } from '../memory/types.js';
import type { KgNode } from '../memory/types.js';

// Minimal structural return type for storeFact — matches StoreFactResult in entity-memory.ts
// without creating a cross-module dependency. action values are the full union from that type.
export interface StoreFactSummary {
  stored: boolean;
  action: 'created' | 'updated' | 'conflict' | 'auto_rejected' | 'auto_resolved' | 'entity_not_found' | 'rate_limited';
  conflict?: string;
}

export interface WriteExclusionOptions {
  /** The other contact's ID that this node is excluding. */
  contactBId: string;
  /** The KG node on which to record the exclusion fact (belongs to the other contact, A). */
  kgNodeId: string;
  storeFact: (options: StoreFactOptions) => Promise<StoreFactSummary>;
  /** Source key for the storeFact call. Skills should pass ctx.memoryWriteSource.
   *  Defaults to 'contacts-dedup' for backward compatibility with the sweep script. */
  source?: string;
}

/**
 * Record a dedup_exclusion KG fact on kgNodeId naming contactBId.
 *
 * Uses permanent decay so the exclusion survives the normal decay schedule.
 * Format: label "dedup_exclusion: <contactBId>", properties.attribute = 'dedup_exclusion',
 * properties.value = contactBId — matching what hasExclusion() queries for.
 *
 * Throws if the fact was not stored (action: 'conflict' | 'auto_rejected' | ...).
 * The 'conflict' case typically fires when a contact already has a dedup_exclusion
 * for a DIFFERENT pair — EntityMemory's contradiction detection treats same-attribute,
 * different-label facts at equal confidence as conflicts. Callers should catch and
 * surface this rather than treating a non-throwing return as a guarantee of persistence.
 *
 * @TODO: The underlying fix is to key contradiction detection on (attribute + value)
 * rather than (attribute + label), so multiple dedup_exclusion facts per node are
 * permitted. That change touches shared memory-validation semantics and should be
 * done in a dedicated issue (see curia#1027 discussion).
 */
export async function writeExclusion(opts: WriteExclusionOptions): Promise<void> {
  const { contactBId: rawContactBId, kgNodeId, storeFact, source = 'contacts-dedup' } = opts;
  // Normalize to lowercase so writes and reads are always comparable regardless of
  // input casing (the UUID validator accepts uppercase; the DB always returns lowercase).
  const contactBId = rawContactBId.toLowerCase();
  const result = await storeFact({
    entityNodeId: kgNodeId,
    label: `dedup_exclusion: ${contactBId}`,
    properties: { attribute: 'dedup_exclusion', value: contactBId },
    // Permanent decay — exclusion decisions must not quietly expire
    decayClass: 'permanent',
    confidence: 1.0,
    source,
    sensitivity: 'internal',
  });
  if (!result.stored) {
    throw new Error(
      `dedup_exclusion fact for ${contactBId} was not stored (action: ${result.action}${result.conflict ? `, reason: ${result.conflict}` : ''})`,
    );
  }
}

export interface HasExclusionOptions {
  contactAId: string;
  contactBId: string;
  kgNodeIdA: string | null;
  kgNodeIdB: string | null;
  /** getFacts errors propagate to the caller — callers must decide their own failure policy. */
  getFacts: (kgNodeId: string) => Promise<KgNode[]>;
}

/**
 * Check whether either contact has a dedup_exclusion fact naming the other.
 * Returns true if an exclusion exists in either direction (A→B or B→A).
 * Short-circuits immediately when neither contact has a KG node.
 *
 * Any error thrown by getFacts propagates to the caller unchanged — this function
 * has no internal retry or fallback. Callers that treat a getFacts error as "no
 * exclusion" would silently re-file tasks for previously-rejected pairs; callers
 * should treat the error as "unknown" and skip the pair rather than proceeding.
 */
export async function hasExclusion(opts: HasExclusionOptions): Promise<boolean> {
  const { contactAId: rawContactAId, contactBId: rawContactBId, kgNodeIdA, kgNodeIdB, getFacts } = opts;
  const contactAId = rawContactAId.toLowerCase();
  const contactBId = rawContactBId.toLowerCase();

  // Short-circuit: no KG nodes means no facts can exist
  if (kgNodeIdA === null && kgNodeIdB === null) return false;

  // Check A's node for an exclusion naming B
  if (kgNodeIdA !== null) {
    const factsA = await getFacts(kgNodeIdA);
    for (const fact of factsA) {
      const props = fact.properties as Record<string, unknown>;
      if (props.attribute === 'dedup_exclusion' && props.value === contactBId) {
        return true;
      }
    }
  }

  // Check B's node for an exclusion naming A
  if (kgNodeIdB !== null) {
    const factsB = await getFacts(kgNodeIdB);
    for (const fact of factsB) {
      const props = fact.properties as Record<string, unknown>;
      if (props.attribute === 'dedup_exclusion' && props.value === contactAId) {
        return true;
      }
    }
  }

  return false;
}
