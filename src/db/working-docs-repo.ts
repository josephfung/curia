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
  removeSection,
  okfByteSize,
  normalizeDocPath,
  type ExtractedLink,
} from '../memory/okf.js';
import { DURABLE_DOC_PREFIXES } from '../memory/durable-doc-prefixes.js';

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

/** Live/archived selector for console reads (#1821). */
export type WorkingDocStatusFilter = 'live' | 'archived' | 'all';

/** A document row without its body — for listing the store cheaply (#1821). */
export type WorkingDocSummary = Omit<WorkingDocRow, 'body' | 'sectionVersions'>;

export interface ListWorkingDocSummariesOptions {
  /** Path prefix (`ls`-on-a-prefix, as `listByPrefix`). Defaults to the whole store. */
  prefix?: string;
  status?: WorkingDocStatusFilter;
}

export interface WorkingDocLinkRow {
  sourcePath: string;
  targetPath: string;
  linkKind: 'markdown' | 'wikilink';
}

export type WorkingDocWriteResult =
  | { ok: true; document: WorkingDocRow }
  | { ok: false; conflict: true; document: WorkingDocRow };

export type WorkingDocRestoreResult =
  | { ok: true; document: WorkingDocRow }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_archived' | 'path_in_use'; document?: WorkingDocRow };

export interface CreateWorkingDocParams {
  path: string;
  type: string;
  frontmatter?: Record<string, unknown>;
  body?: string;
  /** Explicit `null` leaves the row unowned (durable prefixes, #2322). */
  taskId?: string | null;
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
  /**
   * Claim ownership when the document currently has `task_id IS NULL`.
   * Existing owners are preserved (COALESCE semantics).
   */
  taskId?: string;
}

export interface EditSectionParams {
  section: string;
  content: string;
  mode?: 'replace' | 'append';
  /** Per-section optimistic version — independent of document version. */
  expectedSectionVersion?: number;
  /**
   * Claim ownership when the document currently has `task_id IS NULL`.
   * Existing owners are preserved (COALESCE semantics).
   */
  taskId?: string;
}

export interface DeleteSectionParams {
  section: string;
  /** Per-section optimistic version, as for editSection. */
  expectedSectionVersion?: number;
}

/** editSection's results, plus a section that is not in the document (#2339). */
export type WorkingDocDeleteSectionResult =
  | WorkingDocWriteResult
  | { ok: false; missingSection: true; document: WorkingDocRow };

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

/**
 * Normalize a prefix for LIKE matching, keeping a trailing slash: `/projects/x/` must
 * not match `/projects/xy/…`, but `normalizeDocPath` alone drops the slash.
 */
function normalizeLikePrefix(prefix: string | undefined): string {
  const raw = prefix ?? '/';
  const normalized = normalizeDocPath(raw);
  return raw.trim().endsWith('/') && normalized !== '/' ? `${normalized}/` : normalized;
}

const SUMMARY_COLUMNS = `
  id, path, type, frontmatter, version, byte_size,
  task_id, conversation_id, agent_id, created_at, updated_at, archived_at
`;

/** SQL predicate for a status filter — a fixed string per value, never user input. */
function statusPredicate(status: WorkingDocStatusFilter): string {
  if (status === 'live') return 'archived_at IS NULL';
  if (status === 'archived') return 'archived_at IS NOT NULL';
  return 'TRUE';
}

function mapSummaryRow(row: Omit<DbWorkingDocRow, 'body' | 'section_versions'>): WorkingDocSummary {
  const { body: _body, sectionVersions: _sv, ...summary } = mapRow({ ...row, body: '', section_versions: null });
  void _body;
  void _sv;
  return summary;
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

  /**
   * True when any row exists at the path, including an archived one.
   * Minutes and transcripts count as already written once, so a later
   * recovery must not create a new live row over an archive (#2322).
   */
  async existsAtPath(path: string): Promise<boolean> {
    const normalized = normalizeDocPath(path);
    const { rows } = await this.pool.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM working_documents WHERE path = $1
       ) AS present`,
      [normalized],
    );
    return rows[0]?.present === true;
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
             task_id = CASE
               WHEN NOT ($6::boolean) THEN task_id
               WHEN $7::uuid IS NULL THEN NULL
               ELSE COALESCE(task_id, $7::uuid)
             END,
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
      // Claim-if-null is enforced in update()'s COALESCE semantics.
      ...(params.taskId ? { taskId: params.taskId } : {}),
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
             task_id = CASE
               WHEN $7::boolean AND task_id IS NULL THEN $8::uuid
               ELSE task_id
             END,
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
          params.taskId !== undefined && params.taskId !== null,
          params.taskId ?? null,
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

  /**
   * Delete one `##` section, heading and body, and drop its section version (#2339).
   * Same row lock and section-version check as editSection. A section that is not in
   * the document changes nothing and says so, so a caller never confirms a removal
   * that did not happen.
   */
  async deleteSection(path: string, params: DeleteSectionParams): Promise<WorkingDocDeleteSectionResult> {
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
      const removed = removeSection(locked.body, sectionKey);
      if (!removed) {
        await client.query('ROLLBACK');
        return { ok: false, missingSection: true, document: locked };
      }
      // editSection keys versions by the heading as the caller wrote it, and headings
      // match case-insensitively, so every spelling of this heading goes.
      const matchesHeading = (key: string) => key.trim().toLowerCase() === sectionKey.toLowerCase();
      const currentSectionVersion = locked.sectionVersions[sectionKey]
        ?? locked.sectionVersions[removed.heading]
        ?? 0;
      if (params.expectedSectionVersion !== undefined
        && params.expectedSectionVersion !== currentSectionVersion) {
        await client.query('ROLLBACK');
        return { ok: false, conflict: true, document: locked };
      }

      const sectionVersions = Object.fromEntries(
        Object.entries(locked.sectionVersions).filter(([key]) => !matchesHeading(key)),
      );
      const byteSize = okfByteSize({ type: locked.type, frontmatter: locked.frontmatter, body: removed.body });
      const links = extractLinks(normalized, removed.body);

      const { rows } = await client.query<DbWorkingDocRow>(
        `UPDATE working_documents
         SET body = $2,
             version = version + 1,
             section_versions = $3::jsonb,
             byte_size = $4,
             updated_at = now()
         WHERE path = $1
           AND archived_at IS NULL
           AND version = $5
         RETURNING ${DOC_COLUMNS}`,
        [normalized, removed.body, JSON.stringify(sectionVersions), byteSize, locked.version],
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
        { path: normalized, section: removed.heading, version: document.version },
        'working-docs-repo: deleted section',
      );
      return { ok: true, document };
    } catch (err) {
      await client.query('ROLLBACK');
      this.logger.error({ err, path: normalized, section: sectionKey }, 'working-docs-repo: deleteSection transaction failed');
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

  /** Live documents associated with a task via `task_id` (#1819 placement ownership). */
  async listLiveByTaskId(taskId: string): Promise<WorkingDocRow[]> {
    const { rows } = await this.pool.query<DbWorkingDocRow>(
      `SELECT ${DOC_COLUMNS}
       FROM working_documents
       WHERE task_id = $1::uuid
         AND archived_at IS NULL
       ORDER BY updated_at DESC, path ASC`,
      [taskId],
    );
    return rows.map(mapRow);
  }

  /**
   * Cheap occupancy check for `/projects/<slug>/` — no body columns (#1819 review).
   */
  async projectPrefixHasLiveDocs(slug: string): Promise<boolean> {
    const prefix = `/projects/${slug}/`;
    const { rows } = await this.pool.query<{ ok: number }>(
      `SELECT 1 AS ok
         FROM working_documents
        WHERE archived_at IS NULL
          AND path LIKE $1 ESCAPE '\\'
        LIMIT 1`,
      [`${escapeLikePattern(prefix)}%`],
    );
    return rows.length > 0;
  }

  /** True when a live document exists at exactly `path` (no body load). */
  async livePathExists(path: string): Promise<boolean> {
    const normalized = normalizeDocPath(path);
    const { rows } = await this.pool.query<{ ok: number }>(
      `SELECT 1 AS ok
         FROM working_documents
        WHERE path = $1
          AND archived_at IS NULL
        LIMIT 1`,
      [normalized],
    );
    return rows.length > 0;
  }

  /**
   * Top-level `/projects/` directory summaries without loading document bodies (#1819).
   * Ordered by recent activity so the prompt-sized window prefers live work.
   */
  async listProjectDirectorySummaries(options?: { maxDirectories?: number }): Promise<Array<{
    slug: string;
    directoryPrefix: string;
    documentCount: number;
    samplePaths: string[];
    sampleTitles: string[];
  }>> {
    const max = options?.maxDirectories ?? 40;
    const { rows } = await this.pool.query<{
      slug: string;
      document_count: string;
      sample_paths: string[] | null;
      sample_titles: Array<string | null> | null;
    }>(
      `SELECT
         (regexp_match(path, '^/projects/([^/]+)'))[1] AS slug,
         COUNT(*)::text AS document_count,
         (array_agg(path ORDER BY updated_at DESC))[1:5] AS sample_paths,
         (array_agg(
            NULLIF(BTRIM(frontmatter->>'title'), '')
            ORDER BY updated_at DESC
          ) FILTER (WHERE NULLIF(BTRIM(frontmatter->>'title'), '') IS NOT NULL))[1:5] AS sample_titles
       FROM working_documents
       WHERE archived_at IS NULL
         AND path LIKE '/projects/%/%'
         AND (regexp_match(path, '^/projects/([^/]+)'))[1] IS NOT NULL
       GROUP BY 1
       ORDER BY MAX(updated_at) DESC, 1 ASC
       LIMIT $1`,
      [max],
    );
    return rows.map(row => ({
      slug: row.slug,
      directoryPrefix: `/projects/${row.slug}/`,
      documentCount: Number.parseInt(row.document_count, 10),
      samplePaths: (row.sample_paths ?? []).filter(Boolean),
      sampleTitles: (row.sample_titles ?? []).filter((t): t is string => typeof t === 'string' && t.length > 0),
    }));
  }

  /**
   * Soft-delete expired `/scratch/<conversation-id>/…` documents past their TTL (#1212).
   * Non-scratch paths are never touched. TTL is derived from `updated_at` and either
   * frontmatter `ttl_days` (scratch only) or the configured default.
   *
   * Link cleanup: removes outbound `source_path` links from archived docs (same as
   * `softDelete()`). Inbound links whose `target_path` points at an archived doc are
   * left in place — `getBacklinks()` joins on live sources only, so they are harmless.
   *
   * The archive runs as a single `UPDATE … RETURNING` so the TTL predicate is enforced
   * at write time (no snapshot-then-delete race).
   */
  async purgeExpiredScratch(defaultTtlDays: number): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query<{ archived_count: string }>(
        `WITH archived AS (
           UPDATE working_documents
              SET archived_at = now(),
                  updated_at = now()
            WHERE path ~ '^/scratch/[^/]+/'
              AND archived_at IS NULL
              AND COALESCE(
                CASE
                  WHEN (frontmatter->>'ttl_days') ~ '^[0-9]+$'
                    AND (frontmatter->>'ttl_days')::int = 0 THEN 0
                  WHEN (frontmatter->>'ttl_days') ~ '^[0-9]{1,5}$'
                    AND (frontmatter->>'ttl_days')::int BETWEEN 1 AND 36500
                    THEN (frontmatter->>'ttl_days')::int
                  ELSE NULL
                END,
                $1
              ) > 0
              AND updated_at < now() - (
                COALESCE(
                  CASE
                    WHEN (frontmatter->>'ttl_days') ~ '^[0-9]{1,5}$'
                      AND (frontmatter->>'ttl_days')::int BETWEEN 1 AND 36500
                      THEN (frontmatter->>'ttl_days')::int
                    ELSE NULL
                  END,
                  $1
                ) * INTERVAL '1 day'
              )
           RETURNING path
         ),
         _links AS (
           DELETE FROM working_document_links
            WHERE source_path IN (SELECT path FROM archived)
         )
         SELECT COUNT(*)::text AS archived_count FROM archived`,
        [defaultTtlDays],
      );

      await client.query('COMMIT');
      const archived = Number.parseInt(rows[0]?.archived_count ?? '0', 10);
      this.logger.info(
        { archived, defaultTtlDays },
        'working-docs-repo: archived expired scratch documents',
      );
      return archived;
    } catch (err) {
      await client.query('ROLLBACK');
      this.logger.error({ err, defaultTtlDays }, 'working-docs-repo: purgeExpiredScratch failed');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Archive all live workspace documents for a completed project (#1241 / #1819).
   *
   * Matches rows by:
   * - `task_id = root` (ownership — required for shared slug folders), or
   * - legacy path prefix `/projects/<root-uuid>/…` only (pre-#1819 UUID directories that
   *   may lack task_id).
   *
   * Never archives by a shared readable slug prefix — that would silently delete
   * another task's documents when one project completes.
   *
   * Reserved directory `log.md` files are never archived here: they are a shared
   * audit trail and must stay unowned (#1819 CodeRabbit).
   */
  async archiveProjectWorkspaceDocs(rootTaskId: string): Promise<number> {
    const pathPrefix = `/projects/${rootTaskId}/`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query<{ archived_count: string }>(
        `WITH archived AS (
           UPDATE working_documents
              SET archived_at = now(),
                  updated_at = now()
            WHERE archived_at IS NULL
              AND path !~ '/log\\.md$'
              -- #2322 / #2338: durable prefixes are never task-owned.
              AND NOT (path LIKE ANY($3::text[]))
              AND (
                task_id = $1::uuid
                OR path LIKE $2 ESCAPE '\\'
              )
           RETURNING path
         ),
         _links AS (
           DELETE FROM working_document_links
            WHERE source_path IN (SELECT path FROM archived)
         )
         SELECT COUNT(*)::text AS archived_count FROM archived`,
        [
          rootTaskId,
          `${escapeLikePattern(pathPrefix)}%`,
          DURABLE_DOC_PREFIXES.map((prefix) => `${prefix}%`),
        ],
      );

      await client.query('COMMIT');
      const archived = Number.parseInt(rows[0]?.archived_count ?? '0', 10);
      this.logger.info(
        { rootTaskId, archived },
        'working-docs-repo: archived project workspace documents',
      );
      return archived;
    } catch (err) {
      await client.query('ROLLBACK');
      this.logger.error({ err, rootTaskId }, 'working-docs-repo: archiveProjectWorkspaceDocs failed');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Soft-delete only if the live document is still at `expectedVersion` (#1822 console
   * archive). The version predicate is in the UPDATE itself, so an agent write that lands
   * between the caller's read and this call yields a conflict instead of archiving a
   * version nobody looked at. Returns null when no live document exists at the path.
   */
  async softDeleteAtVersion(path: string, expectedVersion: number): Promise<WorkingDocWriteResult | null> {
    const normalized = normalizeDocPath(path);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<DbWorkingDocRow>(
        `UPDATE working_documents
         SET archived_at = now(), updated_at = now()
         WHERE path = $1 AND archived_at IS NULL AND version = $2
         RETURNING ${DOC_COLUMNS}`,
        [normalized, expectedVersion],
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        const current = await this.read(normalized);
        return current ? { ok: false, conflict: true, document: current } : null;
      }
      await client.query(`DELETE FROM working_document_links WHERE source_path = $1`, [normalized]);
      await client.query('COMMIT');
      const document = mapRow(rows[0]);
      this.logger.info({ path: normalized, version: expectedVersion }, 'working-docs-repo: soft-deleted document at version');
      return { ok: true, document };
    } catch (err) {
      await client.query('ROLLBACK');
      this.logger.error({ err, path: normalized }, 'working-docs-repo: softDeleteAtVersion transaction failed');
      throw err;
    } finally {
      client.release();
    }
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

  /**
   * Return an archived row to live (#1822). Refused when another live document now holds
   * the path — the live-path unique index would reject it anyway; checking first gives the
   * caller a reason instead of a constraint error. Bumps `version` (a stale editor must not
   * save over a restore) and rebuilds the outbound links `softDelete` removed.
   */
  async restore(id: string): Promise<WorkingDocRestoreResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: lockedRows } = await client.query<DbWorkingDocRow>(
        `SELECT ${DOC_COLUMNS} FROM working_documents WHERE id = $1::uuid FOR UPDATE`,
        [id],
      );
      const locked = lockedRows[0];
      if (!locked) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'not_found' };
      }
      if (locked.archived_at === null) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'not_archived', document: mapRow(locked) };
      }
      const { rows: liveRows } = await client.query<DbWorkingDocRow>(
        `SELECT ${DOC_COLUMNS} FROM working_documents WHERE path = $1 AND archived_at IS NULL`,
        [locked.path],
      );
      if (liveRows[0]) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'path_in_use', document: mapRow(liveRows[0]) };
      }
      const { rows } = await client.query<DbWorkingDocRow>(
        `UPDATE working_documents
            SET archived_at = NULL, version = version + 1, updated_at = now()
          WHERE id = $1::uuid
          RETURNING ${DOC_COLUMNS}`,
        [id],
      );
      const restored = mapRow(rows[0]!);
      await this.replaceLinks(client, restored.path, extractLinks(restored.path, restored.body));
      await client.query('COMMIT');
      this.logger.info({ path: restored.path, id }, 'working-docs-repo: restored document');
      return { ok: true, document: restored };
    } catch (err) {
      await client.query('ROLLBACK');
      // 23505: a concurrent create took the path between the check and the update.
      if ((err as { code?: string }).code === '23505') {
        this.logger.warn({ id }, 'working-docs-repo: restore lost a race for its path');
        return { ok: false, reason: 'path_in_use' };
      }
      this.logger.error({ err, id }, 'working-docs-repo: restore transaction failed');
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

  /**
   * List documents without their bodies (#1821 console tree). Unlike `listByPrefix`,
   * this can include archived rows — several archived rows may share one path, so
   * callers identify archived documents by `id`, not path.
   */
  async listSummaries(options: ListWorkingDocSummariesOptions = {}): Promise<WorkingDocSummary[]> {
    const status = options.status ?? 'live';
    const prefix = normalizeLikePrefix(options.prefix);
    const { rows } = await this.pool.query<Omit<DbWorkingDocRow, 'body' | 'section_versions'>>(
      `SELECT ${SUMMARY_COLUMNS}
       FROM working_documents
       WHERE path LIKE $1 ESCAPE '\\'
         AND ${statusPredicate(status)}
       ORDER BY path ASC, updated_at DESC`,
      [`${escapeLikePattern(prefix)}%`],
    );
    return rows.map(mapSummaryRow);
  }

  /** Read one document by row id, live or archived (#1821). */
  async readById(id: string): Promise<WorkingDocRow | null> {
    const { rows } = await this.pool.query<DbWorkingDocRow>(
      `SELECT ${DOC_COLUMNS}
       FROM working_documents
       WHERE id = $1::uuid`,
      [id],
    );
    const row = rows[0];
    return row ? mapRow(row) : null;
  }

  /**
   * Documents whose path or body contains `query`, case-insensitively (#1821 console
   * search). Returns whole rows; the caller extracts match context. `strpos` rather
   * than ILIKE so the query needs no wildcard escaping.
   */
  async searchText(
    query: string,
    options: { prefix?: string; status?: WorkingDocStatusFilter } = {},
  ): Promise<WorkingDocRow[]> {
    const status = options.status ?? 'live';
    const prefix = normalizeLikePrefix(options.prefix);
    const { rows } = await this.pool.query<DbWorkingDocRow>(
      `SELECT ${DOC_COLUMNS}
       FROM working_documents
       WHERE path LIKE $1 ESCAPE '\\'
         AND ${statusPredicate(status)}
         AND (strpos(lower(path), lower($2)) > 0 OR strpos(lower(body), lower($2)) > 0)
       ORDER BY updated_at DESC, path ASC`,
      [`${escapeLikePattern(prefix)}%`, query],
    );
    return rows.map(mapRow);
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
