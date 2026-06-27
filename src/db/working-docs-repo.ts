// working-docs-repo.ts — database operations for OKF working documents (#1208).
//
// Postgres is the store; OKF is the format agents read and write. All queries
// are parameterized. Optimistic concurrency returns conflict results, not errors.

import type { Pool, PoolClient } from 'pg';
import type { Logger } from '../logger.js';
import {
  emitOkfDocument,
  extractLinks,
  editSectionBody,
  okfByteSize,
  normalizeDocPath,
  type ExtractedLink,
} from '../memory/okf.js';

const DOC_COLUMNS = `
  id, path, type, frontmatter, body, version, section_versions, byte_size,
  task_id, conversation_id, agent_id, created_at, updated_at, archived_at
`;

export interface WorkingDocRow {
  id: string;
  path: string;
  type: string;
  frontmatter: Record<string, unknown>;
  body: string;
  version: number;
  sectionVersions: Record<string, number>;
  byteSize: number;
  taskId: string | null;
  conversationId: string | null;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface WorkingDocLinkRow {
  sourcePath: string;
  targetPath: string;
  linkKind: 'markdown' | 'wikilink';
}

export type WorkingDocWriteResult =
  | { ok: true; document: WorkingDocRow }
  | { ok: false; conflict: true; document: WorkingDocRow };

export interface CreateWorkingDocParams {
  path: string;
  type: string;
  frontmatter?: Record<string, unknown>;
  body?: string;
  taskId?: string;
  conversationId?: string;
  agentId?: string;
}

export interface UpdateWorkingDocParams {
  type?: string;
  frontmatter?: Record<string, unknown>;
  body?: string;
  taskId?: string | null;
  conversationId?: string | null;
  agentId?: string | null;
  expectedVersion: number;
}

export interface AppendWorkingDocParams {
  content: string;
  expectedVersion: number;
}

export interface EditSectionParams {
  section: string;
  content: string;
  mode?: 'replace' | 'append';
  /** Per-section optimistic version — independent of document version. */
  expectedSectionVersion?: number;
}

interface DbWorkingDocRow {
  id: string;
  path: string;
  type: string;
  frontmatter: Record<string, unknown>;
  body: string;
  version: number;
  section_versions: Record<string, number> | null;
  byte_size: number;
  task_id: string | null;
  conversation_id: string | null;
  agent_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  archived_at: Date | string | null;
}

function mapRow(row: DbWorkingDocRow): WorkingDocRow {
  return {
    id: row.id,
    path: row.path,
    type: row.type,
    frontmatter: row.frontmatter ?? {},
    body: row.body,
    version: row.version,
    sectionVersions: row.section_versions ?? {},
    byteSize: row.byte_size,
    taskId: row.task_id,
    conversationId: row.conversation_id,
    agentId: row.agent_id,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    archivedAt: row.archived_at
      ? (row.archived_at instanceof Date ? row.archived_at.toISOString() : String(row.archived_at))
      : null,
  };
}

function stripTypeFromFrontmatter(frontmatter?: Record<string, unknown>): Record<string, unknown> {
  const { type: _ignoredType, ...rest } = frontmatter ?? {};
  void _ignoredType;
  return rest;
}

/** Escape SQL LIKE wildcards so prefix matching is literal. */
function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export class WorkingDocsRepo {
  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
  ) {}

  /** Serialize a row to OKF markdown. */
  toOkf(document: WorkingDocRow): string {
    return emitOkfDocument({
      type: document.type,
      frontmatter: document.frontmatter,
      body: document.body,
    });
  }

  async create(params: CreateWorkingDocParams): Promise<WorkingDocRow> {
    const path = normalizeDocPath(params.path);
    const body = params.body ?? '';
    const frontmatter = stripTypeFromFrontmatter(params.frontmatter);
    const byteSize = okfByteSize({ type: params.type, frontmatter, body });
    const links = extractLinks(path, body);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<DbWorkingDocRow>(
        `INSERT INTO working_documents
           (path, type, frontmatter, body, version, section_versions, byte_size,
            task_id, conversation_id, agent_id)
         VALUES ($1, $2, $3::jsonb, $4, 1, '{}'::jsonb, $5, $6, $7, $8)
         RETURNING ${DOC_COLUMNS}`,
        [
          path,
          params.type,
          JSON.stringify(frontmatter),
          body,
          byteSize,
          params.taskId ?? null,
          params.conversationId ?? null,
          params.agentId ?? null,
        ],
      );
      const row = rows[0]!;
      await this.replaceLinks(client, path, links);
      await client.query('COMMIT');
      const document = mapRow(row);
      this.logger.info({ path, type: params.type }, 'working-docs-repo: created document');
      return document;
    } catch (err) {
      await client.query('ROLLBACK');
      this.logger.error({ err, path }, 'working-docs-repo: create transaction failed');
      throw err;
    } finally {
      client.release();
    }
  }

  async read(path: string): Promise<WorkingDocRow | null> {
    const normalized = normalizeDocPath(path);
    const { rows } = await this.pool.query<DbWorkingDocRow>(
      `SELECT ${DOC_COLUMNS}
       FROM working_documents
       WHERE path = $1 AND archived_at IS NULL`,
      [normalized],
    );
    const row = rows[0];
    return row ? mapRow(row) : null;
  }

  async update(path: string, params: UpdateWorkingDocParams): Promise<WorkingDocWriteResult> {
    const normalized = normalizeDocPath(path);
    const current = await this.read(normalized);
    if (!current) {
      throw new Error(`working-docs-repo: document not found at ${normalized}`);
    }
    if (current.version !== params.expectedVersion) {
      return { ok: false, conflict: true, document: current };
    }

    const type = params.type ?? current.type;
    const frontmatter = params.frontmatter !== undefined
      ? stripTypeFromFrontmatter(params.frontmatter)
      : current.frontmatter;
    const body = params.body ?? current.body;
    const byteSize = okfByteSize({ type, frontmatter, body });
    const links = extractLinks(normalized, body);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<DbWorkingDocRow>(
        `UPDATE working_documents
         SET type = $2,
             frontmatter = $3::jsonb,
             body = $4,
             version = version + 1,
             byte_size = $5,
             task_id = CASE WHEN $6 THEN $7 ELSE task_id END,
             conversation_id = CASE WHEN $8 THEN $9 ELSE conversation_id END,
             agent_id = CASE WHEN $10 THEN $11 ELSE agent_id END,
             updated_at = now()
         WHERE path = $1
           AND archived_at IS NULL
           AND version = $12
         RETURNING ${DOC_COLUMNS}`,
        [
          normalized,
          type,
          JSON.stringify(frontmatter),
          body,
          byteSize,
          params.taskId !== undefined,
          params.taskId ?? null,
          params.conversationId !== undefined,
          params.conversationId ?? null,
          params.agentId !== undefined,
          params.agentId ?? null,
          params.expectedVersion,
        ],
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        const latest = await this.read(normalized);
        return { ok: false, conflict: true, document: latest ?? current };
      }
      await this.replaceLinks(client, normalized, links);
      await client.query('COMMIT');
      const document = mapRow(rows[0]);
      this.logger.info({ path: normalized, version: document.version }, 'working-docs-repo: updated document');
      return { ok: true, document };
    } catch (err) {
      await client.query('ROLLBACK');
      this.logger.error({ err, path: normalized }, 'working-docs-repo: update transaction failed');
      throw err;
    } finally {
      client.release();
    }
  }

  async append(path: string, params: AppendWorkingDocParams): Promise<WorkingDocWriteResult> {
    const current = await this.read(path);
    if (!current) {
      throw new Error(`working-docs-repo: document not found at ${normalizeDocPath(path)}`);
    }
    const body = current.body.length > 0
      ? `${current.body.replace(/\n$/, '')}\n\n${params.content}`
      : params.content;
    return this.update(path, {
      body,
      expectedVersion: params.expectedVersion,
    });
  }

  async editSection(path: string, params: EditSectionParams): Promise<WorkingDocWriteResult> {
    const normalized = normalizeDocPath(path);
    const sectionKey = params.section.trim();

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: lockedRows } = await client.query<DbWorkingDocRow>(
        `SELECT ${DOC_COLUMNS}
         FROM working_documents
         WHERE path = $1 AND archived_at IS NULL
         FOR UPDATE`,
        [normalized],
      );
      const lockedRow = lockedRows[0];
      if (!lockedRow) {
        await client.query('ROLLBACK');
        throw new Error(`working-docs-repo: document not found at ${normalized}`);
      }

      const locked = mapRow(lockedRow);
      const currentSectionVersion = locked.sectionVersions[sectionKey] ?? 0;
      if (params.expectedSectionVersion !== undefined
        && params.expectedSectionVersion !== currentSectionVersion) {
        await client.query('ROLLBACK');
        return { ok: false, conflict: true, document: locked };
      }

      const newBody = editSectionBody(locked.body, sectionKey, params.content, params.mode ?? 'replace');
      const byteSize = okfByteSize({
        type: locked.type,
        frontmatter: locked.frontmatter,
        body: newBody,
      });
      const links = extractLinks(normalized, newBody);
      const nextSectionVersion = currentSectionVersion + 1;
      const sectionVersions = { ...locked.sectionVersions, [sectionKey]: nextSectionVersion };

      const { rows } = await client.query<DbWorkingDocRow>(
        `UPDATE working_documents
         SET body = $2,
             version = version + 1,
             section_versions = $3::jsonb,
             byte_size = $4,
             updated_at = now()
         WHERE path = $1
           AND archived_at IS NULL
           AND COALESCE((section_versions->>$5)::int, 0) = $6
         RETURNING ${DOC_COLUMNS}`,
        [
          normalized,
          newBody,
          JSON.stringify(sectionVersions),
          byteSize,
          sectionKey,
          currentSectionVersion,
        ],
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        const latest = await this.read(normalized);
        return { ok: false, conflict: true, document: latest ?? locked };
      }
      await this.replaceLinks(client, normalized, links);
      await client.query('COMMIT');
      const document = mapRow(rows[0]);
      this.logger.info(
        { path: normalized, section: sectionKey, sectionVersion: nextSectionVersion },
        'working-docs-repo: edited section',
      );
      return { ok: true, document };
    } catch (err) {
      await client.query('ROLLBACK');
      this.logger.error({ err, path: normalized, section: sectionKey }, 'working-docs-repo: editSection transaction failed');
      throw err;
    } finally {
      client.release();
    }
  }

  async listByPrefix(prefix: string): Promise<WorkingDocRow[]> {
    const normalized = normalizeDocPath(prefix);
    const pattern = `${escapeLikePattern(normalized)}%`;
    const { rows } = await this.pool.query<DbWorkingDocRow>(
      `SELECT ${DOC_COLUMNS}
       FROM working_documents
       WHERE path LIKE $1 ESCAPE '\\'
         AND archived_at IS NULL
       ORDER BY path ASC`,
      [pattern],
    );
    return rows.map(mapRow);
  }

  async softDelete(path: string): Promise<WorkingDocRow | null> {
    const normalized = normalizeDocPath(path);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<DbWorkingDocRow>(
        `UPDATE working_documents
         SET archived_at = now(), updated_at = now()
         WHERE path = $1 AND archived_at IS NULL
         RETURNING ${DOC_COLUMNS}`,
        [normalized],
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query(
        `DELETE FROM working_document_links WHERE source_path = $1`,
        [normalized],
      );
      await client.query('COMMIT');
      const document = mapRow(rows[0]);
      this.logger.info({ path: normalized }, 'working-docs-repo: soft-deleted document');
      return document;
    } catch (err) {
      await client.query('ROLLBACK');
      this.logger.error({ err, path: normalized }, 'working-docs-repo: softDelete transaction failed');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Backlinks — live documents that link to `targetPath` ("what links here"). */
  async getBacklinks(targetPath: string): Promise<WorkingDocLinkRow[]> {
    const normalized = normalizeDocPath(targetPath);
    const { rows } = await this.pool.query<{ source_path: string; target_path: string; link_kind: string }>(
      `SELECT l.source_path, l.target_path, l.link_kind
       FROM working_document_links l
       INNER JOIN working_documents d
         ON d.path = l.source_path AND d.archived_at IS NULL
       WHERE l.target_path = $1
       ORDER BY l.source_path ASC`,
      [normalized],
    );
    return rows.map(r => ({
      sourcePath: r.source_path,
      targetPath: r.target_path,
      linkKind: r.link_kind as 'markdown' | 'wikilink',
    }));
  }

  private async replaceLinks(client: PoolClient, sourcePath: string, links: ExtractedLink[]): Promise<void> {
    await client.query(`DELETE FROM working_document_links WHERE source_path = $1`, [sourcePath]);
    for (const link of links) {
      await client.query(
        `INSERT INTO working_document_links (source_path, target_path, link_kind)
         VALUES ($1, $2, $3)
         ON CONFLICT (source_path, target_path, link_kind) DO NOTHING`,
        [sourcePath, link.targetPath, link.linkKind],
      );
    }
  }
}
