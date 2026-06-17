import type { StoreFactOptions } from '../memory/types.js';
import type { KgNode } from '../memory/types.js';

export interface WriteExclusionOptions {
  /** The other contact's ID that this node is excluding. */
  contactBId: string;
  /** The KG node on which to record the exclusion fact (belongs to the other contact, A). */
  kgNodeId: string;
  storeFact: (options: StoreFactOptions) => Promise<unknown>;
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
 */
export async function writeExclusion(opts: WriteExclusionOptions): Promise<void> {
  const { contactBId, kgNodeId, storeFact, source = 'contacts-dedup' } = opts;
  await storeFact({
    entityNodeId: kgNodeId,
    label: `dedup_exclusion: ${contactBId}`,
    properties: { attribute: 'dedup_exclusion', value: contactBId },
    // Permanent decay — exclusion decisions must not quietly expire
    decayClass: 'permanent',
    confidence: 1.0,
    source,
    sensitivity: 'internal',
  });
}

export interface HasExclusionOptions {
  contactAId: string;
  contactBId: string;
  kgNodeIdA: string | null;
  kgNodeIdB: string | null;
  getFacts: (kgNodeId: string) => Promise<KgNode[]>;
}

/**
 * Check whether either contact has a dedup_exclusion fact naming the other.
 * Returns true if an exclusion exists in either direction (A→B or B→A).
 * Short-circuits immediately when neither contact has a KG node.
 */
export async function hasExclusion(opts: HasExclusionOptions): Promise<boolean> {
  const { contactAId, contactBId, kgNodeIdA, kgNodeIdB, getFacts } = opts;

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
