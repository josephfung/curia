import type { AgentYamlConfig } from './loader.js';
import type { WorkingDocRow } from '../db/working-docs-repo.js';
import {
  docDirectory,
  markdownFenceFor,
  normalizeDocPath,
  splitSections,
} from '../memory/okf.js';
import type { ResumableDocumentPointer } from '../db/resumable-progress.js';
import { isDocumentPointer } from '../db/resumable-progress.js';

/** The four skills every document-workspace-enabled agent can call. */
export const DOCUMENT_WORKSPACE_SKILLS = [
  'doc-read',
  'doc-list',
  'doc-write',
  'doc-search',
] as const;

export const INDEX_FILENAME = 'index.md';
export const LOG_FILENAME = 'log.md';

/** Reserved leaf names — not overwritten by generic create/replace. */
export const RESERVED_LEAF_NAMES = new Set([INDEX_FILENAME, LOG_FILENAME]);

/** Single source of truth for the workspace discipline block injected into every
 *  document-workspace-enabled agent's effective system prompt (#1209). */
export const DOCUMENT_WORKSPACE_BLOCK = [
  '## Document Workspace',
  '',
  'You have an OKF document workspace — a filesystem of markdown concept-files addressed',
  'by path. Use your `doc-*` skills to read, list, write, and search it.',
  '',
  '**Paths.** Documents live at paths like `/projects/<slug>/brief.md` or',
  '`/scratch/<conversation-id>/outline.md`. Directories are path prefixes — `doc-list` on',
  'a prefix is like `ls` on a folder. Each directory has reserved `index.md` (navigation',
  'catalog) and `log.md` (append-only change history).',
  '',
  '**Manifest first, bodies on demand.** On resume you may receive a directory manifest',
  '(the `index.md` projection) at the tail of your task message — that is the map, not',
  'the content. Pull document bodies and specific `##` sections with `doc-read` as tool',
  'results so working text stays out of the cached system prefix.',
  '',
  '**Writes.** `doc-write` creates, appends, replaces, or section-edits at a path and',
  'appends a `log.md` entry in that directory. Re-read with `doc-read` after writes that',
  'need the latest `expected_version`. On conflict, merge from the returned document and',
  'retry with the new version.',
  '',
  '**Conventions.** YAML frontmatter requires `type`; `title`, `tags`, and `timestamp` are',
  'conventional. Link between documents with markdown path links or `[[wikilinks]]`.',
  'Distill durable conclusions to the knowledge graph via `memory-store` / `extract-facts`',
  'when a project completes — the workspace is for mutable working state, not validated facts.',
].join('\n');

export interface DocumentWorkspaceResult {
  systemPrompt: string;
  pinnedSkills: string[];
}

/** Apply the document workspace capability to an agent's prompt + skills.
 *  Gated on `enable_task_management` — resumable-task agents get the workspace surface.
 *  Pure function — no side effects. */
export function applyDocumentWorkspace(
  config: AgentYamlConfig,
  systemPrompt: string,
  pinnedSkills: string[],
): DocumentWorkspaceResult {
  if (!config.enable_task_management) {
    return { systemPrompt, pinnedSkills: [...pinnedSkills] };
  }
  const merged = [...pinnedSkills];
  for (const skill of DOCUMENT_WORKSPACE_SKILLS) {
    if (!merged.includes(skill)) merged.push(skill);
  }
  return {
    systemPrompt: `${systemPrompt}\n\n${DOCUMENT_WORKSPACE_BLOCK}`,
    pinnedSkills: merged,
  };
}

/** Normalize a directory prefix — always ends with `/`, never bare `/` unless root. */
export function normalizeDirectoryPrefix(prefix: string): string {
  const normalized = normalizeDocPath(prefix);
  if (normalized === '/') return '/';
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

/** True when `path` is a direct child of `directoryPrefix`. */
export function isDirectChild(directoryPrefix: string, path: string): boolean {
  const dir = normalizeDirectoryPrefix(directoryPrefix);
  if (!path.startsWith(dir)) return false;
  const remainder = path.slice(dir.length);
  if (!remainder || remainder.includes('/')) return false;
  return true;
}

/** Build the index.md projection for a directory prefix from live document rows. */
export function buildIndexProjection(directoryPrefix: string, documents: WorkingDocRow[]): string {
  const dir = normalizeDirectoryPrefix(directoryPrefix);
  const children = documents
    .filter(d => isDirectChild(dir, d.path))
    .sort((a, b) => a.path.localeCompare(b.path));

  const lines: string[] = ['# Index', ''];
  if (children.length === 0) {
    lines.push('_No documents in this directory yet._');
    return `${lines.join('\n')}\n`;
  }

  for (const doc of children) {
    const leaf = doc.path.slice(dir.length);
    const title = typeof doc.frontmatter.title === 'string' && doc.frontmatter.title.trim()
      ? doc.frontmatter.title.trim()
      : leaf.replace(/\.md$/, '');
    lines.push(`- [${title}](${doc.path}) — \`${doc.type}\``);
  }
  return `${lines.join('\n')}\n`;
}

/** Format a log.md append entry per OKF / LLM-Wiki convention. */
export function formatLogEntry(isoTimestamp: string, operation: string, summary: string): string {
  const op = operation.trim() || 'write';
  const sum = summary.trim() || op;
  return `## [${isoTimestamp}] ${op} | ${sum}\n`;
}

export function logPathForDocument(documentPath: string): string {
  return `${docDirectory(documentPath)}${LOG_FILENAME}`;
}

export function indexPathForDirectory(directoryPrefix: string): string {
  return `${normalizeDirectoryPrefix(directoryPrefix)}${INDEX_FILENAME}`;
}

/** Extract a `##` section body, or the full document when section is omitted. */
export function extractSectionContent(
  body: string,
  section?: string,
): { content: string; section?: string; found?: boolean } {
  if (!section || !section.trim()) {
    return { content: body };
  }
  const key = section.trim();
  const { sections } = splitSections(body);
  const match = sections.find(s => s.heading.toLowerCase() === key.toLowerCase());
  if (!match) {
    return { content: '', found: false };
  }
  const content = match.content.length > 0 ? `${match.content.replace(/\n$/, '')}\n` : '';
  return { content, section: match.heading, found: true };
}

/** True when the path names a document leaf (e.g. ends in `.md`), not a directory prefix. */
export function looksLikeDocumentPath(path: string): boolean {
  const normalized = normalizeDocPath(path);
  const leaf = normalized.split('/').pop() ?? '';
  return leaf.includes('.');
}

export interface GrepMatch {
  path: string;
  lineNumber: number;
  line: string;
}

/** Case-sensitive substring grep across document bodies. */
export function grepDocuments(
  documents: WorkingDocRow[],
  query: string,
  options?: { maxMatches?: number },
): GrepMatch[] {
  const max = options?.maxMatches ?? 50;
  const matches: GrepMatch[] = [];
  for (const doc of documents) {
    const lines = doc.body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.includes(query)) continue;
      matches.push({ path: doc.path, lineNumber: i + 1, line });
      if (matches.length >= max) return matches;
    }
  }
  return matches;
}

/** Parse scheduler / task-wake JSON content. Returns null for non-JSON payloads. */
export function parseTaskWakePayload(content: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function resolveWorkspacePrefixFromPayload(
  payload: Record<string, unknown>,
  rootTaskId?: string,
): string | null {
  const pointer = documentPointerFromProgress(payload.progress);
  if (pointer) {
    return docDirectory(pointer.path);
  }

  const taskId = typeof payload.task_id === 'string' && payload.task_id.length > 0
    ? payload.task_id
    : null;
  if (!taskId) return null;

  // Convention: project documents live under /projects/<root-task-id>/ (#1210).
  const resolvedRoot = rootTaskId ?? taskId;
  return `/projects/${resolvedRoot}/`;
}

/** Parse scheduler / task-wake JSON content for a workspace directory prefix. */
export function resolveWorkspacePrefixFromTaskContent(content: string): string | null {
  const payload = parseTaskWakePayload(content);
  if (!payload) return null;
  return resolveWorkspacePrefixFromPayload(payload);
}

/** Resolve the workspace directory prefix, optionally walking to the project-root task. */
export async function resolveWorkspaceDirectoryPrefix(
  content: string,
  resolveRootTaskId?: (taskId: string) => Promise<string | null>,
): Promise<string | null> {
  const payload = parseTaskWakePayload(content);
  if (!payload) return null;

  let rootTaskId: string | undefined;
  if (resolveRootTaskId && typeof payload.task_id === 'string' && payload.task_id.length > 0) {
    const root = await resolveRootTaskId(payload.task_id);
    if (root) rootTaskId = root;
  }

  return resolveWorkspacePrefixFromPayload(payload, rootTaskId);
}

/** Read a document pointer from scheduler / task-wake JSON content. */
export function documentPointerFromTaskContent(content: string): ResumableDocumentPointer | null {
  const payload = parseTaskWakePayload(content);
  if (!payload) return null;
  return documentPointerFromProgress(payload.progress);
}

/** Build the tail message block injected on task resume (manifest only). */
export function formatWorkspaceManifestBlock(directoryPrefix: string, indexBody: string): string {
  const dir = normalizeDirectoryPrefix(directoryPrefix);
  return [
    '## Workspace Manifest',
    '',
    `Directory \`${dir}\` — index projection only. Use \`doc-read\` for document bodies.`,
    '',
    '```markdown',
    indexBody.trimEnd(),
    '```',
  ].join('\n');
}

/** Build the tail message block for a spilled resumable accumulator document (#1210). */
export function formatAccumulatorResumeBlock(
  pointer: ResumableDocumentPointer,
  content: string,
  resolvedSection?: string,
): string {
  const sectionName = pointer.section ?? resolvedSection;
  const sectionClause = sectionName ? ` (section \`${sectionName}\`)` : '';
  const trimmed = content.trimEnd();
  const fence = markdownFenceFor(trimmed);
  return [
    '## Resumable Accumulator',
    '',
    `Document \`${pointer.path}\`${sectionClause} — checkpoint spill from your last run:`,
    '',
    `${fence}markdown`,
    trimmed,
    fence,
  ].join('\n');
}

export function documentPointerFromProgress(progress: unknown): ResumableDocumentPointer | null {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return null;
  const resumable = (progress as Record<string, unknown>).resumable;
  if (!resumable || typeof resumable !== 'object' || Array.isArray(resumable)) return null;
  const accumulator = (resumable as Record<string, unknown>).accumulator;
  return isDocumentPointer(accumulator) ? accumulator : null;
}
