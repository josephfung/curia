// Working-docs adapter for the standing inbox rules (/shared/inbox/rules.md), the document
// ceo-inbox keeps its rules in. Reads the body; a write replaces the body only if the
// document is unchanged since the read, so a rule edited meanwhile is never overwritten.
import type { WorkingDocsRepo } from '../db/working-docs-repo.js';

export const INBOX_RULES_PATH = '/shared/inbox/rules.md';

export function createRulesDoc(repo: Pick<WorkingDocsRepo, 'read' | 'update'>): {
  read(): Promise<string | null>;
  write(s: string): Promise<void>;
} {
  let readVersion: number | null = null;
  return {
    async read() {
      const doc = await repo.read(INBOX_RULES_PATH);
      readVersion = doc ? doc.version : null;
      return doc ? doc.body : null;
    },
    async write(body: string) {
      if (readVersion === null) throw new Error('rules document written before it was read');
      const result = await repo.update(INBOX_RULES_PATH, { body, expectedVersion: readVersion });
      if (!result.ok) throw new Error('the inbox rules changed while they were being updated');
    },
  };
}
