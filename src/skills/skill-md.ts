// skill-md.ts — parse Anthropic-compatible SKILL.md (YAML frontmatter + Markdown body).
//
// Required Anthropic fields: name, description.
// Curia extensions (native skills): version, tools, heartbeat, document_workspace.
// Extra unknown frontmatter keys are ignored so unmodified Anthropic skills can
// load later (Phase 3) without failing on license/compatibility/metadata/etc.

import * as yaml from 'js-yaml';

export interface ParsedSkillMd {
  name: string;
  description: string;
  version?: string;
  /** Explicit tool list from frontmatter; undefined → discover from tools/. */
  tools?: string[];
  heartbeat?: boolean;
  document_workspace?: boolean;
  instructions: string;
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Parse a SKILL.md file. Throws on missing/invalid required fields.
 * Body may be empty (tool-only bundles such as calendar).
 */
export function parseSkillMd(raw: string, sourceLabel = 'SKILL.md'): ParsedSkillMd {
  const trimmed = raw.replace(/^\uFEFF/, '');
  if (!trimmed.startsWith('---')) {
    throw new Error(`${sourceLabel}: missing YAML frontmatter (expected leading ---)`);
  }
  const end = trimmed.indexOf('\n---', 3);
  if (end === -1) {
    throw new Error(`${sourceLabel}: unclosed YAML frontmatter`);
  }
  const frontmatterRaw = trimmed.slice(4, end).trim();
  const body = trimmed.slice(end + 4).replace(/^\r?\n/, '');

  let parsed: unknown;
  try {
    parsed = yaml.load(frontmatterRaw);
  } catch (err) {
    throw new Error(
      `${sourceLabel}: invalid YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${sourceLabel}: frontmatter must be a YAML mapping`);
  }
  // Runtime-validated YAML object — cast through unknown (CLAUDE.md pattern).
  const fm = parsed as unknown as Record<string, unknown>;

  const name = fm.name;
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error(`${sourceLabel}: frontmatter.name is required`);
  }
  if (!NAME_RE.test(name)) {
    throw new Error(
      `${sourceLabel}: frontmatter.name '${name}' must be lowercase alphanumeric with hyphens`,
    );
  }

  const description = fm.description;
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error(`${sourceLabel}: frontmatter.description is required`);
  }

  let version: string | undefined;
  if (fm.version !== undefined) {
    if (typeof fm.version !== 'string' || !fm.version.trim()) {
      throw new Error(`${sourceLabel}: frontmatter.version must be a non-empty string when set`);
    }
    version = fm.version.trim();
  }

  let tools: string[] | undefined;
  if (fm.tools !== undefined) {
    if (!Array.isArray(fm.tools) || !fm.tools.every((t): t is string => typeof t === 'string')) {
      throw new Error(`${sourceLabel}: frontmatter.tools must be a string array when set`);
    }
    tools = fm.tools.map(t => t.trim()).filter(Boolean);
  }

  if (fm.heartbeat !== undefined && typeof fm.heartbeat !== 'boolean') {
    throw new Error(`${sourceLabel}: frontmatter.heartbeat must be a boolean when set`);
  }
  if (fm.document_workspace !== undefined && typeof fm.document_workspace !== 'boolean') {
    throw new Error(`${sourceLabel}: frontmatter.document_workspace must be a boolean when set`);
  }
  // Only `true` is meaningful today; omit/`false` both mean "flag unset".
  const heartbeat = fm.heartbeat === true ? true : undefined;
  const document_workspace = fm.document_workspace === true ? true : undefined;

  return {
    name: name.trim(),
    description: description.trim(),
    version,
    tools,
    heartbeat,
    document_workspace,
    instructions: body.trimEnd(),
  };
}
