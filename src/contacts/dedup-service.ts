// Stub interface for DedupService — implementation lives in a future task.
// Declared here so ContactServiceOptions in types.ts can reference it without
// creating a circular dependency or import error.
// @TODO: Replace this stub with the real implementation in the dedup task.

export interface DedupService {
  // Returns candidate match IDs with their confidence scores for a given contact ID.
  findDuplicates(
    contactId: string,
  ): Promise<Array<{ matchId: string; score: number; reason: string }>>;
}
