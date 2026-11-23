// memory-working-docs-repo.ts — an in-memory stand-in for the working-docs table: enough of it
// for AgendaStore unit tests (create, read, listByPrefix, versioned update, versioned archive).

import type { WorkingDocRow, WorkingDocsRepo } from '../../../src/db/working-docs-repo.js';

export function memoryWorkingDocsRepo(now: Date): WorkingDocsRepo {
  const rows = new Map<string, WorkingDocRow>();
  const row = (path: string, type: string, frontmatter: Record<string, unknown>, body: string, version: number): WorkingDocRow => ({
    id: path, path, type, frontmatter, body, version, sectionVersions: {}, byteSize: body.length,
    taskId: null, conversationId: null, agentId: null, createdAt: now.toISOString(), updatedAt: now.toISOString(), archivedAt: null,
  });
  const repo = {
    async create(p: { path: string; type: string; frontmatter?: Record<string, unknown>; body?: string }) {
      const created = row(p.path, p.type, structuredClone(p.frontmatter ?? {}), p.body ?? '', 1);
      rows.set(p.path, created);
      return created;
    },
    async read(path: string) {
      return rows.get(path) ?? null;
    },
    async listByPrefix(prefix: string) {
      return [...rows.values()].filter((r) => r.path.startsWith(prefix));
    },
    async update(path: string, p: { type?: string; frontmatter?: Record<string, unknown>; expectedVersion: number }) {
      const current = rows.get(path)!;
      if (current.version !== p.expectedVersion) return { ok: false as const, conflict: true as const, document: current };
      const next = row(path, p.type ?? current.type, structuredClone(p.frontmatter ?? current.frontmatter), current.body, current.version + 1);
      rows.set(path, next);
      return { ok: true as const, document: next };
    },
    async softDeleteAtVersion(path: string, expectedVersion: number) {
      const current = rows.get(path);
      if (!current) return null;
      if (current.version !== expectedVersion) return { ok: false as const, conflict: true as const, document: current };
      rows.delete(path);
      return { ok: true as const, document: current };
    },
  };
  return repo as unknown as WorkingDocsRepo;
}
