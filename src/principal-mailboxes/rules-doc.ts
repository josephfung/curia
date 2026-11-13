// Working-docs adapter for the standing inbox rules (/shared/inbox/rules.md), the document
// ceo-inbox keeps its rules in. Reads the body; a write replaces the body only if the
// document is unchanged since the read, so a rule edited meanwhile is never overwritten.
// Every write leaves a directory-log entry (log.md), as doc-write does, attributed to the
// console admin rather than an agent.
import type { Logger } from '../logger.js';
import type { WorkingDocsRepo } from '../db/working-docs-repo.js';
import { appendDirectoryLogEntry } from '../agents/document-workspace.js';

export const INBOX_RULES_PATH = '/shared/inbox/rules.md';

export function createRulesDoc(
  repo: Pick<WorkingDocsRepo, 'read' | 'update' | 'create' | 'append'>,
  logger: Logger,
): {
  read(): Promise<string | null>;
  write(s: string, summary?: string): Promise<void>;
} {
  let readVersion: number | null = null;
  return {
    async read() {
      const doc = await repo.read(INBOX_RULES_PATH);
      readVersion = doc ? doc.version : null;
      return doc ? doc.body : null;
    },
    async write(body: string, summary?: string) {
      if (readVersion === null) throw new Error('rules document written before it was read');
      const result = await repo.update(INBOX_RULES_PATH, { body, expectedVersion: readVersion });
      if (!result.ok) throw new Error('the inbox rules changed while they were being updated');
      // Best-effort, like doc-write: the rewrite stands; a missing entry only warns.
      await appendDirectoryLogEntry(repo, logger, {
        documentPath: INBOX_RULES_PATH,
        operation: 'mailbox-removal',
        summary: summary ?? 'inbox rules rewritten for a removed mailbox',
        source: 'principal mailbox admin',
      });
    },
  };
}
