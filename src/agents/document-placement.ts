// document-placement.ts — shared OKF project placement policy (#1819).
//
// Path is organisational; task_id is ownership. Suggesting slugs, resolving
// collisions, and the extend / add-to-folder / create-folder decision live here
// so harness (spill, injection, archival) and skills (doc-place) share one
// implementation. Raw doc-read/list/write/search stay path-faithful primitives.

import { docDirectory, normalizeDocPath } from '../memory/okf.js';
import type { WorkingDocRow } from '../db/working-docs-repo.js';
import type { ResumableDocumentPointer } from '../db/resumable-progress.js';

/** Max length for a project folder slug (kebab-case segment under /projects/). */
export const MAX_PROJECT_SLUG_LENGTH = 64;

/** Canonical projects root prefix. */
export const PROJECTS_ROOT_PREFIX = '/projects/';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WELL_FORMED_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function normalizeDirectoryPrefix(prefix: string): string {
  const normalized = normalizeDocPath(prefix);
  if (normalized === '/') return '/';
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

export type PlacementAction = 'extend' | 'add_to_folder' | 'create_folder';

export interface ProjectDirectorySummary {
  slug: string;
  directoryPrefix: string;
  documentCount: number;
  samplePaths: string[];
  sampleTitles: string[];
}

export interface PlacementRecommendation {
  action: PlacementAction;
  /** Suggested document path when action is extend or create (with optional leaf). */
  path?: string;
  slug: string;
  directoryPrefix: string;
  reason: string;
  /** When create_folder allocated a uniqueness suffix. */
  allocated?: boolean;
  collisionShortId?: string;
  alternatives?: ProjectDirectorySummary[];
}

export interface RecommendPlacementInput {
  /** Free-text intent or task title used when proposed_slug is omitted. */
  intent?: string;
  title?: string;
  proposedSlug?: string;
  /** Preferred leaf name (e.g. brief.md) for extend / create path suggestions. */
  leaf?: string;
  /** When true, never reuse an occupied folder — allocate a unique slug. */
  preferNewFolder?: boolean;
  /** Live project directory summaries (from listProjectDirectorySummaries). */
  catalog: ProjectDirectorySummary[];
  /** Optional root task id for deterministic collision suffixes. */
  rootTaskId?: string;
  /** Live documents under matching folders — used to pick an extend target. */
  documentsInFolder?: WorkingDocRow[];
}

/** True when the segment is a legacy UUID project directory name. */
export function isLegacyUuidProjectDir(segment: string): boolean {
  return UUID_RE.test(segment);
}

/** True for kebab-case project slugs suitable as *new* folder names (not UUIDs). */
export function isWellFormedProjectSlug(segment: string): boolean {
  if (!segment || segment.length > MAX_PROJECT_SLUG_LENGTH) return false;
  if (isLegacyUuidProjectDir(segment)) return false;
  return WELL_FORMED_SLUG_RE.test(segment);
}

/** 8-char hex short id from a task UUID (dashes stripped). */
export function collisionShortId(rootTaskId: string): string {
  return rootTaskId.replace(/-/g, '').slice(0, 8).toLowerCase();
}

/**
 * Derive a kebab-case suggested slug from a human title/intent.
 * Hint only — agents may choose a different well-formed slug via doc-place.
 */
export function suggestProjectSlug(title: string): string {
  const raw = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const truncated = raw.slice(0, MAX_PROJECT_SLUG_LENGTH).replace(/-$/g, '');
  if (!truncated || isLegacyUuidProjectDir(truncated)) return 'project';
  return truncated;
}

/** Normalize a caller-proposed slug; returns null when unusable as a new slug. */
export function normalizeProposedSlug(raw: string): string | null {
  const suggested = suggestProjectSlug(raw);
  return isWellFormedProjectSlug(suggested) ? suggested : null;
}

/**
 * Allocate a unique project slug. If `proposed` is free, return it; otherwise
 * `${proposed}-${shortId}`, then `${proposed}-${shortId}-2`, … — never a UUID folder.
 */
export function allocateUniqueProjectSlug(
  proposed: string,
  rootTaskId: string,
  prefixOccupied: (slug: string) => boolean,
): string {
  const base = normalizeProposedSlug(proposed) ?? suggestProjectSlug(proposed);
  if (!prefixOccupied(base)) return base;

  const short = collisionShortId(rootTaskId) || 'task';
  const withShort = `${base}-${short}`.slice(0, MAX_PROJECT_SLUG_LENGTH).replace(/-$/g, '');
  if (!prefixOccupied(withShort)) return withShort;

  for (let n = 2; n < 1000; n++) {
    const candidate = `${withShort}-${n}`.slice(0, MAX_PROJECT_SLUG_LENGTH).replace(/-$/g, '');
    if (isWellFormedProjectSlug(candidate) && !prefixOccupied(candidate)) return candidate;
  }
  // Extremely pathological — still avoid UUID folders.
  return `${withShort}-x`.slice(0, MAX_PROJECT_SLUG_LENGTH);
}

export async function allocateUniqueProjectSlugAsync(
  proposed: string,
  rootTaskId: string,
  prefixOccupied: (slug: string) => boolean | Promise<boolean>,
): Promise<string> {
  const base = normalizeProposedSlug(proposed) ?? suggestProjectSlug(proposed);
  if (!(await prefixOccupied(base))) return base;

  const short = collisionShortId(rootTaskId) || 'task';
  const withShort = `${base}-${short}`.slice(0, MAX_PROJECT_SLUG_LENGTH).replace(/-$/g, '');
  if (!(await prefixOccupied(withShort))) return withShort;

  for (let n = 2; n < 1000; n++) {
    const candidate = `${withShort}-${n}`.slice(0, MAX_PROJECT_SLUG_LENGTH).replace(/-$/g, '');
    if (isWellFormedProjectSlug(candidate) && !(await prefixOccupied(candidate))) return candidate;
  }
  return `${withShort}-x`.slice(0, MAX_PROJECT_SLUG_LENGTH);
}

/** Directory prefix for a project slug. */
export function projectDirectoryPrefix(slug: string): string {
  return normalizeDirectoryPrefix(`${PROJECTS_ROOT_PREFIX}${slug}`);
}

/** Extract the first path segment under /projects/, or null. */
export function projectSlugFromPath(path: string): string | null {
  const normalized = normalizeDocPath(path);
  const match = /^\/projects\/([^/]+)/.exec(normalized);
  return match?.[1] ?? null;
}

/**
 * Validate a create path under /projects/: legacy UUID dirs allowed; new dirs
 * must use a well-formed slug. Returns an error message or null when ok.
 */
export function validateProjectsWritePath(path: string): string | null {
  const normalized = normalizeDocPath(path);
  const match = /^\/projects\/([^/]+)\/(.+)$/.exec(normalized);
  if (!match) {
    if (normalized === '/projects' || normalized === '/projects/') {
      return 'Write under /projects/<slug>/… — not the /projects/ root';
    }
    // Non-/projects paths (e.g. /scratch/…) are not governed here.
    if (!normalized.startsWith('/projects/')) return null;
    return 'Project documents must live at /projects/<slug>/<leaf> (not directly under /projects/)';
  }
  const segment = match[1]!;
  if (isLegacyUuidProjectDir(segment)) return null;
  if (isWellFormedProjectSlug(segment)) return null;
  return (
    `Invalid project folder '${segment}' — use a kebab-case slug (e.g. social-media), ` +
    'not a task UUID. Call doc-place to choose a folder.'
  );
}

/** Summarize top-level /projects/ directories from live document rows. */
export function listProjectDirectorySummaries(
  documents: WorkingDocRow[],
  options?: { maxDirectories?: number },
): ProjectDirectorySummary[] {
  const max = options?.maxDirectories ?? 40;
  const bySlug = new Map<string, ProjectDirectorySummary>();

  for (const doc of documents) {
    const slug = projectSlugFromPath(doc.path);
    if (!slug) continue;
    const prefix = projectDirectoryPrefix(slug);
    // Only count docs whose remainder is a direct child or nested under this slug.
    if (!doc.path.startsWith(prefix) && doc.path !== prefix.slice(0, -1)) continue;

    let entry = bySlug.get(slug);
    if (!entry) {
      entry = {
        slug,
        directoryPrefix: prefix,
        documentCount: 0,
        samplePaths: [],
        sampleTitles: [],
      };
      bySlug.set(slug, entry);
    }
    entry.documentCount += 1;
    if (entry.samplePaths.length < 5) {
      entry.samplePaths.push(doc.path);
      const title = typeof doc.frontmatter.title === 'string' && doc.frontmatter.title.trim()
        ? doc.frontmatter.title.trim()
        : undefined;
      if (title && entry.sampleTitles.length < 5) entry.sampleTitles.push(title);
    }
  }

  return [...bySlug.values()]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .slice(0, max);
}

function normalizeLeaf(leaf?: string): string {
  if (!leaf || !leaf.trim()) return 'brief.md';
  const trimmed = leaf.trim().replace(/^\/+/, '');
  if (trimmed.includes('/')) return 'brief.md';
  return trimmed.includes('.') ? trimmed : `${trimmed}.md`;
}

function findCatalogMatch(
  catalog: ProjectDirectorySummary[],
  slug: string,
): ProjectDirectorySummary | undefined {
  const exact = catalog.find(c => c.slug === slug);
  if (exact) return exact;
  // Soft match: catalog slug equals or contains the suggestion (or vice versa).
  return catalog.find(c => c.slug.includes(slug) || slug.includes(c.slug));
}

function pickExtendPath(
  directoryPrefix: string,
  leaf: string,
  documentsInFolder?: WorkingDocRow[],
  leafWasDefault?: boolean,
): string | undefined {
  const preferred = normalizeDocPath(`${directoryPrefix}${leaf}`);
  if (documentsInFolder?.some(d => d.path === preferred)) return preferred;

  // Only broaden to "any durable leaf" when the caller did not name a specific file.
  if (!leafWasDefault) return undefined;

  const preferredLeaves = ['brief.md', 'plan.md', 'queue.md', 'activity-log.md'];
  for (const name of preferredLeaves) {
    const candidate = normalizeDocPath(`${directoryPrefix}${name}`);
    if (documentsInFolder?.some(d => d.path === candidate)) {
      return candidate;
    }
  }

  const first = documentsInFolder
    ?.filter(d => {
      const remainder = d.path.slice(directoryPrefix.length);
      return remainder.length > 0 && !remainder.includes('/') && !remainder.endsWith('log.md');
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return first?.path;
}

/**
 * Mechanical placement recommendation — prefer extend → add_to_folder → create_folder.
 * Does not call an LLM; agents may override after reading the structured result.
 */
export function recommendPlacement(input: RecommendPlacementInput): PlacementRecommendation {
  const leafWasDefault = !input.leaf || !input.leaf.trim();
  const leaf = normalizeLeaf(input.leaf);
  const shortId = input.rootTaskId ? collisionShortId(input.rootTaskId) : undefined;
  const fromProposed = input.proposedSlug?.trim()
    ? normalizeProposedSlug(input.proposedSlug)
    : null;
  const suggested = fromProposed
    ?? suggestProjectSlug(input.title ?? input.intent ?? 'project');

  const occupied = (slug: string) => input.catalog.some(c => c.slug === slug);

  if (input.preferNewFolder) {
    const allocatedSlug = input.rootTaskId
      ? allocateUniqueProjectSlug(suggested, input.rootTaskId, occupied)
      : (occupied(suggested) ? `${suggested}-new` : suggested);
    const directoryPrefix = projectDirectoryPrefix(allocatedSlug);
    return {
      action: 'create_folder',
      slug: allocatedSlug,
      directoryPrefix,
      path: `${directoryPrefix}${leaf}`,
      reason: occupied(suggested) && allocatedSlug !== suggested
        ? `Folder /projects/${suggested}/ is occupied — allocated unique slug '${allocatedSlug}' for a new folder.`
        : `Create a new project folder at ${directoryPrefix}.`,
      allocated: allocatedSlug !== suggested,
      collisionShortId: shortId,
      alternatives: input.catalog.slice(0, 8),
    };
  }

  const match = findCatalogMatch(input.catalog, suggested);
  if (match) {
    const extendPath = pickExtendPath(
      match.directoryPrefix,
      leaf,
      input.documentsInFolder,
      leafWasDefault,
    );
    if (extendPath) {
      return {
        action: 'extend',
        slug: match.slug,
        directoryPrefix: match.directoryPrefix,
        path: extendPath,
        reason: `Existing document ${extendPath} matches this work — prefer append or section-edit.`,
        collisionShortId: shortId,
        alternatives: input.catalog.filter(c => c.slug !== match.slug).slice(0, 5),
      };
    }
    return {
      action: 'add_to_folder',
      slug: match.slug,
      directoryPrefix: match.directoryPrefix,
      path: `${match.directoryPrefix}${leaf}`,
      reason: `Existing folder ${match.directoryPrefix} matches — add a new document there rather than creating a sibling folder.`,
      collisionShortId: shortId,
      alternatives: input.catalog.filter(c => c.slug !== match.slug).slice(0, 5),
    };
  }

  const directoryPrefix = projectDirectoryPrefix(suggested);
  return {
    action: 'create_folder',
    slug: suggested,
    directoryPrefix,
    path: `${directoryPrefix}${leaf}`,
    reason: `No existing /projects/ folder matches — create ${directoryPrefix} with a readable slug.`,
    allocated: false,
    collisionShortId: shortId,
    alternatives: input.catalog.slice(0, 8),
  };
}

export interface ResolveOwnedWorkspacePrefixParams {
  rootTaskId: string;
  pointer?: ResumableDocumentPointer | null;
  ownedDocuments: WorkingDocRow[];
  /** Live docs under the legacy UUID prefix (may have null task_id). */
  legacyUuidDocuments?: WorkingDocRow[];
}

/**
 * Resolve the workspace directory an agent actually used.
 * Order: document pointer → owned /projects/ docs → legacy UUID prefix → null.
 * Never invents /projects/<uuid>/ when nothing exists yet.
 */
export function resolveOwnedWorkspacePrefix(
  params: ResolveOwnedWorkspacePrefixParams,
): string | null {
  if (params.pointer?.path) {
    return docDirectory(params.pointer.path);
  }

  const projectOwned = params.ownedDocuments
    .filter(d => d.path.startsWith(PROJECTS_ROOT_PREFIX) && !d.archivedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  if (projectOwned[0]) {
    return docDirectory(projectOwned[0].path);
  }

  const legacyPrefix = projectDirectoryPrefix(params.rootTaskId);
  if (params.legacyUuidDocuments && params.legacyUuidDocuments.length > 0) {
    return legacyPrefix;
  }
  // If caller did not separate legacy docs, detect from owned list path shape.
  const legacyHit = params.ownedDocuments.find(d => d.path.startsWith(legacyPrefix));
  if (legacyHit) return legacyPrefix;

  return null;
}

/** Format the Hybrid catalog block injected on task wake (#1819). */
export function formatProjectsCatalogBlock(
  summaries: ProjectDirectorySummary[],
  options?: { suggestedSlug?: string; collisionShortId?: string },
): string {
  const lines = [
    '## Projects Catalog',
    '',
    'Top-level `/projects/` folders (index projection only). Call `doc-place` before creating a new folder.',
    '',
  ];
  if (options?.suggestedSlug) {
    lines.push(`Suggested slug (hint): \`${options.suggestedSlug}\`.`);
    if (options.collisionShortId) {
      lines.push(
        `If that name is taken and you need a *new* folder, use \`<slug>-${options.collisionShortId}\`.`,
      );
    }
    lines.push('');
  }
  if (summaries.length === 0) {
    lines.push('_No project folders yet._');
    return lines.join('\n');
  }
  for (const s of summaries) {
    const titles = s.sampleTitles.length > 0 ? ` — ${s.sampleTitles.slice(0, 2).join('; ')}` : '';
    lines.push(`- \`${s.directoryPrefix}\` (${s.documentCount} docs)${titles}`);
  }
  return lines.join('\n');
}

/** Short placement policy blurb for harness injection — must match skills/documents/SKILL.md. */
export function formatPlacementGuidanceBlock(): string {
  return [
    '## Document Placement',
    '',
    'Prefer, in order: (1) extend an existing document, (2) add to an existing `/projects/<slug>/` folder,',
    '(3) create a new folder with a readable kebab-case slug — never a task UUID.',
    'Call `doc-place` to get a structured recommendation, then `doc-write` at the chosen path.',
  ].join('\n');
}
