// skill-resources.ts — Phase 3 (#1490) progressive disclosure for imported skills.
//
// Anthropic Agent Skills ship optional `references/` and `assets/` trees that
// the model loads on demand after SKILL.md activation. This module lists those
// files at import time and safely reads a single text file into context.
//
// Scripts (`scripts/`) are detected elsewhere and never executed here (Phase 4).

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Max bytes returned for a single reference/asset read (keeps context bounded). */
export const SKILL_RESOURCE_MAX_BYTES = 64 * 1024;

/** Subdirs that may be listed / read as progressive-disclosure payloads. */
export const SKILL_RESOURCE_KINDS = ['references', 'assets'] as const;
export type SkillResourceKind = (typeof SKILL_RESOURCE_KINDS)[number];

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.tsv', '.xml', '.html',
  '.css', '.js', '.ts', '.py', '.sh', '.toml', '.ini', '.cfg',
]);

// Text files whose real "extension" fools path.extname — e.g. it returns
// '.example' for '.env.example', so an extension entry would never match.
// Matched by full (lowercased) basename instead.
const TEXT_BASENAMES = new Set(['.env.example']);

export interface SkillResourceLists {
  references: string[];
  assets: string[];
  hasScripts: boolean;
}

/**
 * Walk `references/` and `assets/` (non-recursive beyond one level of nesting
 * is fine — Anthropic skills usually keep a flat references/ list; we allow
 * one nested directory so `references/foo/bar.md` still works). Detect
 * `scripts/` presence without reading its contents.
 */
export function discoverSkillResources(skillDir: string): SkillResourceLists {
  return {
    references: listResourceFiles(skillDir, 'references'),
    assets: listResourceFiles(skillDir, 'assets'),
    hasScripts: fs.existsSync(path.join(skillDir, 'scripts'))
      && fs.statSync(path.join(skillDir, 'scripts')).isDirectory(),
  };
}

function listResourceFiles(skillDir: string, kind: SkillResourceKind): string[] {
  const root = path.join(skillDir, kind);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  const out: string[] = [];
  walk(root, root, out);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function walk(absDir: string, root: string, out: string[]): void {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, root, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = path.relative(root, abs).split(path.sep).join('/');
    out.push(rel);
  }
}

export type SkillResourceReadResult =
  | { ok: true; kind: SkillResourceKind; path: string; content: string; truncated: boolean }
  | { ok: false; error: string };

/**
 * Resolve and read a reference/asset path for an activated skill.
 *
 * `requested` may be:
 *   - `common-clauses.md` (ambiguous — try references/ then assets/)
 *   - `references/common-clauses.md`
 *   - `assets/template.txt`
 *
 * Path traversal (`..`, absolute paths, symlinks escaping the skill dir) is rejected.
 */
export function readSkillResource(
  skillDir: string,
  requested: string,
  lists: { references: readonly string[]; assets: readonly string[] },
): SkillResourceReadResult {
  const trimmed = requested.trim();
  if (!trimmed) return { ok: false, error: 'reference path is required' };

  const resolved = resolveResourceRequest(trimmed, lists);
  if (!resolved) {
    return {
      ok: false,
      error:
        `Unknown skill resource '${trimmed}'. ` +
        `Use a path from the skill's references/ or assets/ listing.`,
    };
  }

  const absSkill = path.resolve(skillDir);
  if (!absSkill || !fs.existsSync(absSkill)) {
    return { ok: false, error: `Skill directory is missing: ${skillDir}` };
  }

  const absFile = path.resolve(absSkill, resolved.kind, resolved.rel);
  // Containment: resolved path must stay under skillDir/<kind>/
  const absKindRoot = path.resolve(absSkill, resolved.kind);
  if (!absFile.startsWith(absKindRoot + path.sep) && absFile !== absKindRoot) {
    return { ok: false, error: 'Invalid skill resource path' };
  }

  let realFile: string;
  let realSkill: string;
  try {
    realFile = fs.realpathSync(absFile);
    realSkill = fs.realpathSync(absSkill);
  } catch {
    return { ok: false, error: `Skill resource not found: ${resolved.kind}/${resolved.rel}` };
  }
  if (!realFile.startsWith(realSkill + path.sep)) {
    return { ok: false, error: 'Invalid skill resource path (symlink escape)' };
  }

  const base = path.basename(realFile).toLowerCase();
  const ext = path.extname(realFile).toLowerCase();
  if (ext && !TEXT_EXTENSIONS.has(ext) && !TEXT_BASENAMES.has(base)) {
    return {
      ok: false,
      error:
        `Skill resource '${resolved.kind}/${resolved.rel}' is not a text file ` +
        `(extension '${ext}'). Binary assets are not loaded into context in Phase 3.`,
    };
  }

  const stat = fs.statSync(realFile);
  if (!stat.isFile()) {
    return { ok: false, error: `Skill resource is not a file: ${resolved.kind}/${resolved.rel}` };
  }

  const buf = fs.readFileSync(realFile);
  const truncated = buf.byteLength > SKILL_RESOURCE_MAX_BYTES;
  const slice = truncated ? buf.subarray(0, SKILL_RESOURCE_MAX_BYTES) : buf;
  const content = slice.toString('utf-8');

  return {
    ok: true,
    kind: resolved.kind,
    path: `${resolved.kind}/${resolved.rel}`,
    content,
    truncated,
  };
}

function resolveResourceRequest(
  requested: string,
  lists: { references: readonly string[]; assets: readonly string[] },
): { kind: SkillResourceKind; rel: string } | null {
  // Normalize separators; reject absolute / parent segments early.
  const normalized = requested.replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    normalized.split('/').some((p) => p === '..' || p === '')
  ) {
    return null;
  }

  for (const kind of SKILL_RESOURCE_KINDS) {
    const prefix = `${kind}/`;
    if (normalized.startsWith(prefix)) {
      const rel = normalized.slice(prefix.length);
      if (lists[kind].includes(rel)) return { kind, rel };
      return null;
    }
  }

  // Bare filename: prefer references/, then assets/.
  if (lists.references.includes(normalized)) {
    return { kind: 'references', rel: normalized };
  }
  if (lists.assets.includes(normalized)) {
    return { kind: 'assets', rel: normalized };
  }
  return null;
}
