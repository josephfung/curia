// pinned-context.ts — agent YAML `pinned_context` (#2338).
//
// An agent declares the `/shared/` documents and config-store keys that are part
// of how it works. The runtime renders a `## Pinned context` block with their
// current contents into the system string on every turn (buildBaseSystemPrompt),
// and doc-write lets only a declaring agent write a `/shared/` path. See ADR-056.
//
// Three pieces live here:
//   - parsePinnedContext(): validate the YAML field at agent load. A bad entry
//     fails the load with an error naming the agent and the entry.
//   - createPinnedContextReader(): the per-turn reads, from the document
//     workspace and config-store.
//   - renderPinnedContextBlock(): the block itself. Never throws; a missing or
//     blank item renders as such, and a failed read as unavailable.

import type { Logger } from '../logger.js';
import type { WorkingDocsRepo } from '../db/working-docs-repo.js';
import type { EntityMemory } from '../memory/entity-memory.js';
import { ConfigStore } from '../memory/config-store.js';
import { SHARED_DOC_PREFIX } from '../memory/durable-doc-prefixes.js';
import { normalizeDocPath } from '../memory/okf.js';
import { RESERVED_LEAF_NAMES } from './document-workspace.js';

export type PinnedContextEntry =
  | { kind: 'doc'; path: string; description?: string }
  | { kind: 'config'; namespace: string; key: string; description?: string };

/** Same caps config-store applies on write, so a declared key is one it can hold. */
const MAX_CONFIG_NAMESPACE_LENGTH = 100;
const MAX_CONFIG_KEY_LENGTH = 200;
/** A description is one or two sentences, sent every turn; keep it short. */
export const MAX_PINNED_DESCRIPTION_LENGTH = 300;

/** Default `documentWorkspace.pinnedContextWarnChars`: warn, never truncate, above this. */
export const DEFAULT_PINNED_CONTEXT_WARN_CHARS = 16_000;

/**
 * Validate and normalize an agent's `pinned_context`:
 *
 *   pinned_context:
 *     docs:                              # a string, or a list
 *       - /shared/inbox/rules.md
 *       - path: /shared/priorities.md
 *         description: The principal's priorities, learned by asking them.
 *     configs: ceo_inbox/decision_tagging  # a string, or a list
 *
 * A list item is a string or a mapping with `path` (docs) / `key` (configs) and an
 * optional `description`. Returns [] when the field, or both lists, are absent or
 * empty. Throws on anything else malformed, a doc outside `/shared/`, a config
 * without exactly one `/`, or a duplicate. Docs come first, in declared order.
 */
export function parsePinnedContext(raw: unknown, agentName: string): PinnedContextEntry[] {
  if (raw === undefined || raw === null) return [];
  const fail = (detail: string, entry?: unknown): never => {
    const shown = entry === undefined ? '' : ` (entry: ${JSON.stringify(entry)})`;
    throw new Error(`Invalid pinned_context in agent '${agentName}': ${detail}${shown}`);
  };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    fail('must be a mapping with `docs` and/or `configs`');
  }
  const section = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(section).filter((k) => k !== 'docs' && k !== 'configs');
  if (unknownKeys.length > 0) {
    fail(`unknown key(s) ${unknownKeys.map((k) => `\`${k}\``).join(', ')} — use \`docs\` and \`configs\``);
  }

  // A string or a list; null (a bare `docs:`) means none.
  const listOf = (name: 'docs' | 'configs'): unknown[] => {
    const value = section[name];
    if (value === undefined || value === null) return [];
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value;
    return fail(`\`${name}\` must be a string or a list`, value);
  };

  // One item: a string, or a mapping with the id field and an optional description.
  const readItem = (name: 'docs' | 'configs', item: unknown): { id: string; description?: string } => {
    const idField = name === 'docs' ? 'path' : 'key';
    let id: unknown = item;
    let description: unknown;
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const fields = item as Record<string, unknown>;
      const extra = Object.keys(fields).filter((k) => k !== idField && k !== 'description');
      if (extra.length > 0) fail(`a \`${name}\` item has only \`${idField}\` and \`description\``, item);
      id = fields[idField];
      description = fields.description;
    }
    if (typeof id !== 'string' || id.trim() === '') {
      fail(`each \`${name}\` item must be a non-empty string or have a non-empty \`${idField}\``, item);
    }
    if (description === undefined || description === null) return { id: (id as string).trim() };
    if (typeof description !== 'string' || description.trim() === '') {
      fail('`description` must be a non-empty string', item);
    }
    const text = (description as string).trim().replace(/\s+/g, ' ');
    if (text.length > MAX_PINNED_DESCRIPTION_LENGTH) {
      fail(`\`description\` must be ${MAX_PINNED_DESCRIPTION_LENGTH} characters or fewer`, item);
    }
    return { id: (id as string).trim(), description: text };
  };

  const entries: PinnedContextEntry[] = [];
  const seen = new Set<string>();
  const add = (entry: PinnedContextEntry, item: unknown): void => {
    const label = pinnedEntryLabel(entry);
    if (seen.has(label)) fail(`duplicate entry ${label}`, item);
    seen.add(label);
    entries.push(entry);
  };

  for (const item of listOf('docs')) {
    const { id, description } = readItem('docs', item);
    // Normalize first so `..` cannot climb out of /shared/ and the declared path
    // matches what doc-write compares against.
    const path = normalizeDocPath(id);
    if (!path.startsWith(SHARED_DOC_PREFIX) || path.length === SHARED_DOC_PREFIX.length) {
      fail(`a \`docs\` path must be a document under ${SHARED_DOC_PREFIX}`, item);
    }
    const leaf = path.split('/').pop() ?? '';
    if (RESERVED_LEAF_NAMES.has(leaf)) {
      fail(`a \`docs\` path cannot be the reserved file ${leaf}`, item);
    }
    // The console edits only `.md` paths; a declared document must stay editable there.
    if (!leaf.endsWith('.md')) {
      fail('a `docs` path must end in .md so the principal can edit it in the console', item);
    }
    add({ kind: 'doc', path, ...(description ? { description } : {}) }, item);
  }

  for (const item of listOf('configs')) {
    const { id, description } = readItem('configs', item);
    // Whole namespaces are deliberately unsupported: they mix principal settings
    // with agent runtime state (#940).
    const parts = id.split('/');
    if (parts.length !== 2 || !parts[0]!.trim() || !parts[1]!.trim()) {
      fail('a `configs` key must be `<namespace>/<key>` with exactly one `/`', item);
    }
    const namespace = parts[0]!.trim();
    const key = parts[1]!.trim();
    if (namespace.length > MAX_CONFIG_NAMESPACE_LENGTH || key.length > MAX_CONFIG_KEY_LENGTH) {
      fail(
        `a \`configs\` namespace must be ${MAX_CONFIG_NAMESPACE_LENGTH} characters or fewer and key ${MAX_CONFIG_KEY_LENGTH} or fewer`,
        item,
      );
    }
    add({ kind: 'config', namespace, key, ...(description ? { description } : {}) }, item);
  }

  return entries;
}

/** The `/shared/` paths an agent declares — what doc-write checks a write against. */
export function pinnedDocPaths(entries: readonly PinnedContextEntry[]): string[] {
  return entries.flatMap((e) => (e.kind === 'doc' ? [e.path] : []));
}

function pinnedEntryLabel(entry: PinnedContextEntry): string {
  return entry.kind === 'doc' ? `doc:${entry.path}` : `config:${entry.namespace}/${entry.key}`;
}

/**
 * A pinned document's state: live (serialized as OKF markdown, frontmatter + body,
 * with its version), archived (a row exists but none is live), or null when no row
 * has ever existed at the path.
 */
export type PinnedDocRead =
  | { status: 'live'; version: number; content: string }
  | { status: 'archived' }
  | null;

/**
 * Per-turn reads for the block. Both return null for "does not exist yet" and
 * throw when the read itself failed, so the two render differently.
 */
export interface PinnedContextReader {
  readDoc(path: string): Promise<PinnedDocRead>;
  readConfig(namespace: string, key: string): Promise<string | null>;
  /** An injected item longer than this logs a warning. It is still injected in full. */
  warnChars: number;
}

/**
 * Build the reader from the services bootstrap already has. Absent services make
 * the matching reads throw, so the entry renders as unavailable rather than as
 * "not yet created" — an agent must not create over a document it cannot see.
 */
export function createPinnedContextReader(deps: {
  workingDocsRepo?: WorkingDocsRepo;
  entityMemory?: EntityMemory;
  logger: Logger;
  warnChars?: number;
}): PinnedContextReader {
  const configStore = deps.entityMemory ? new ConfigStore(deps.entityMemory, deps.logger) : undefined;
  return {
    warnChars: deps.warnChars ?? DEFAULT_PINNED_CONTEXT_WARN_CHARS,
    async readDoc(path) {
      if (!deps.workingDocsRepo) throw new Error('document workspace not configured');
      const doc = await deps.workingDocsRepo.read(path);
      if (doc) return { status: 'live', version: doc.version, content: deps.workingDocsRepo.toOkf(doc) };
      // read() skips archived rows. An archived document is not a missing one: telling
      // the agent to create it would put a live row over the principal's archive.
      return (await deps.workingDocsRepo.existsAtPath(path)) ? { status: 'archived' } : null;
    },
    async readConfig(namespace, key) {
      if (!configStore) throw new Error('knowledge graph not configured');
      return configStore.get(namespace, key);
    },
  };
}

/**
 * A code fence longer than any backtick run in `text`, so a document containing
 * its own fences (or `##` headings) cannot break out of the block.
 */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

export function fenced(text: string): string {
  const fence = fenceFor(text);
  return `${fence}\n${text.replace(/\n+$/, '')}\n${fence}`;
}

const NOT_YET_CREATED_DOC =
  '_Not yet created._ Create it with `doc-write` mode `create` when you first need to write it.';
const ARCHIVED_DOC =
  '_Archived by the principal._ Do not recreate it; the principal can restore it in the console.';
const EMPTY_DOC = '_Exists, but has no content yet._';
const NOT_YET_SET_CONFIG = '_Not set yet._';
const BLANK_CONFIG = '_Set, but blank._';
const UNAVAILABLE =
  '_Unavailable this turn: the read failed._ Do not treat it as empty, and do not create or overwrite it this turn.';

/** Heading plus the declared description, if any, so a missing item still says what it is for. */
function header(heading: string, description: string | undefined): string {
  return description ? `${heading}\nPurpose: ${description}` : heading;
}

/**
 * Render `## Pinned context` for the declared entries, read fresh now. Returns
 * null when nothing is declared. Never throws: a missing, archived or blank item
 * renders as such, and a failed or malformed read renders as unavailable and logs
 * a warning.
 */
export async function renderPinnedContextBlock(
  entries: readonly PinnedContextEntry[],
  reader: PinnedContextReader,
  opts: { agentId: string; logger: Logger },
): Promise<string | null> {
  if (entries.length === 0) return null;
  const { agentId, logger } = opts;

  const warnIfLarge = (entry: string, length: number): void => {
    if (length > reader.warnChars) {
      logger.warn(
        { agentId, entry, chars: length, warnChars: reader.warnChars },
        'pinned_context: injected item exceeds the size warning threshold — injected in full',
      );
    }
  };

  const renderDoc = async (entry: Extract<PinnedContextEntry, { kind: 'doc' }>): Promise<string> => {
    const heading = `### Document ${entry.path}`;
    const doc = await reader.readDoc(entry.path);
    if (doc === null || doc === undefined) return `${header(heading, entry.description)}\n${NOT_YET_CREATED_DOC}`;
    if (doc.status === 'archived') return `${header(heading, entry.description)}\n${ARCHIVED_DOC}`;
    if (doc.status !== 'live' || typeof doc.content !== 'string' || !Number.isInteger(doc.version)) {
      throw new Error('reader returned a malformed document');
    }
    const versioned = header(`${heading} (version ${doc.version})`, entry.description);
    if (doc.content.trim() === '') return `${versioned}\n${EMPTY_DOC}`;
    warnIfLarge(pinnedEntryLabel(entry), doc.content.length);
    return `${versioned}\n${fenced(doc.content)}`;
  };

  const renderConfig = async (entry: Extract<PinnedContextEntry, { kind: 'config' }>): Promise<string> => {
    const heading = header(`### Config ${entry.namespace}/${entry.key}`, entry.description);
    const value = await reader.readConfig(entry.namespace, entry.key);
    if (value === null || value === undefined) return `${heading}\n${NOT_YET_SET_CONFIG}`;
    if (typeof value !== 'string') throw new Error('reader returned a non-string config value');
    if (value.trim() === '') return `${heading}\n${BLANK_CONFIG}`;
    warnIfLarge(pinnedEntryLabel(entry), value.length);
    return `${heading}\n${fenced(value)}`;
  };

  // Each entry renders on its own, so one bad read never costs the others.
  const sections = await Promise.all(entries.map(async (entry): Promise<string> => {
    try {
      return entry.kind === 'doc' ? await renderDoc(entry) : await renderConfig(entry);
    } catch (err) {
      logger.warn(
        { err, agentId, entry: pinnedEntryLabel(entry) },
        'pinned_context: read failed — rendered as unavailable',
      );
      const heading = entry.kind === 'doc' ? `### Document ${entry.path}` : `### Config ${entry.namespace}/${entry.key}`;
      return `${header(heading, entry.description)}\n${UNAVAILABLE}`;
    }
  }));

  return [
    '## Pinned context',
    'Current contents of the documents and settings you work from, read fresh this turn. Do not call a tool to load them. Write documents with `doc-write`, passing the version shown; change settings with `config-store`.',
    ...sections,
  ].join('\n\n');
}
