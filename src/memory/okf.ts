// okf.ts — Open Knowledge Format (de)serialization and link extraction.
//
// OKF documents are YAML frontmatter + markdown body. The store persists
// frontmatter and body separately; this module round-trips the on-disk OKF shape.

import * as yaml from 'js-yaml';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface OkfFrontmatter {
  type: string;
  title?: string;
  description?: string;
  tags?: string[];
  timestamp?: string;
  resource?: string;
  [key: string]: unknown;
}

export interface ParsedOkfDocument {
  type: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface ExtractedLink {
  targetPath: string;
  linkKind: 'markdown' | 'wikilink';
}

/**
 * Parse an OKF markdown document (YAML frontmatter + body).
 * `type` is required in frontmatter.
 */
export function parseOkfDocument(raw: string): ParsedOkfDocument {
  const trimmed = raw.trimStart();
  const match = FRONTMATTER_RE.exec(trimmed);
  if (!match) {
    throw new Error('OKF document must begin with YAML frontmatter delimited by ---');
  }

  const frontmatterRaw = match[1]!;
  const body = match[2] ?? '';
  const loaded = yaml.load(frontmatterRaw, { schema: yaml.JSON_SCHEMA });
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
    throw new Error('OKF frontmatter must be a YAML mapping');
  }

  const frontmatter = loaded as Record<string, unknown>;
  const type = frontmatter.type;
  if (typeof type !== 'string' || type.trim() === '') {
    throw new Error('OKF frontmatter requires a non-empty type field');
  }

  return { type, frontmatter, body };
}

/**
 * Emit an OKF markdown document from structured parts.
 * `type` is written to frontmatter; other conventional keys are preserved.
 */
export function emitOkfDocument(parts: {
  type: string;
  frontmatter?: Record<string, unknown>;
  body: string;
}): string {
  const merged: Record<string, unknown> = { ...(parts.frontmatter ?? {}), type: parts.type };
  const yamlBlock = yaml.dump(merged, { lineWidth: -1, noRefs: true, schema: yaml.JSON_SCHEMA }).trimEnd();
  const body = parts.body.endsWith('\n') || parts.body.length === 0 ? parts.body : `${parts.body}\n`;
  return `---\n${yamlBlock}\n---\n${body}`;
}

/** Compute byte size of the serialized OKF document. */
export function okfByteSize(parts: { type: string; frontmatter?: Record<string, unknown>; body: string }): number {
  return Buffer.byteLength(emitOkfDocument(parts), 'utf8');
}

/**
 * Normalize a document path to a canonical absolute form: leading slash, forward slashes,
 * resolved `.` / `..` segments, optional .md suffix for extensionless leaf names.
 */
export function normalizeDocPath(path: string, options?: { ensureMd?: boolean }): string {
  let normalized = path.trim().replace(/\\/g, '/');
  if (!normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }

  const segments = normalized.split('/').filter(Boolean);
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === '.') continue;
    if (segment === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  normalized = resolved.length > 0 ? `/${resolved.join('/')}` : '/';

  if (options?.ensureMd && normalized !== '/') {
    const leaf = normalized.split('/').pop() ?? '';
    if (leaf && !leaf.includes('.')) {
      normalized = `${normalized}.md`;
    }
  }
  return normalized.replace(/\/+/g, '/');
}

/** Directory prefix of a document path (always ends with /). */
export function docDirectory(path: string): string {
  const normalized = normalizeDocPath(path);
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return `${normalized.slice(0, lastSlash + 1)}`;
}

/** Resolve a link target relative to the source document path. */
export function resolveDocLink(sourcePath: string, target: string, linkKind: 'markdown' | 'wikilink'): string {
  const trimmed = target.trim();
  if (!trimmed || trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('#')) {
    return '';
  }

  let resolved: string;
  if (trimmed.startsWith('/')) {
    resolved = trimmed;
  } else {
    resolved = `${docDirectory(sourcePath)}${trimmed}`;
  }

  resolved = normalizeDocPath(resolved);
  if (linkKind === 'wikilink') {
    resolved = normalizeDocPath(resolved, { ensureMd: true });
  }
  return resolved;
}

/**
 * Extract markdown `[text](path)` and `[[wikilink]]` targets from a document body.
 * External URLs and fragment-only links are ignored. Broken links are tolerated.
 */
export function extractLinks(sourcePath: string, body: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const seen = new Set<string>();

  const markdownRe = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of body.matchAll(markdownRe)) {
    const target = resolveDocLink(sourcePath, match[1]!, 'markdown');
    if (!target) continue;
    const key = `markdown:${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ targetPath: target, linkKind: 'markdown' });
  }

  const wikiRe = /\[\[([^\]]+)\]\]/g;
  for (const match of body.matchAll(wikiRe)) {
    const target = resolveDocLink(sourcePath, match[1]!, 'wikilink');
    if (!target) continue;
    const key = `wikilink:${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ targetPath: target, linkKind: 'wikilink' });
  }

  return links;
}

export interface DocSection {
  heading: string;
  content: string;
}

/**
 * Split a markdown body into `##` sections. Text before the first `##` is returned
 * as the preamble with an empty heading.
 */
export function splitSections(body: string): { preamble: string; sections: DocSection[] } {
  const lines = body.split('\n');
  const sections: DocSection[] = [];
  let preamble = '';
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentHeading === null) {
      preamble = currentLines.join('\n');
    } else {
      sections.push({ heading: currentHeading, content: currentLines.join('\n') });
    }
    currentLines = [];
  };

  for (const line of lines) {
    const sectionMatch = /^##\s+(.+?)\s*$/.exec(line);
    if (sectionMatch) {
      flush();
      currentHeading = sectionMatch[1]!.trim();
      continue;
    }
    currentLines.push(line);
  }
  flush();

  return { preamble, sections };
}

/** Reassemble a body from preamble + sections. */
export function joinSections(preamble: string, sections: DocSection[]): string {
  const parts: string[] = [];
  if (preamble.length > 0) {
    parts.push(preamble.replace(/\n$/, ''));
  }
  for (const section of sections) {
    parts.push(`## ${section.heading}`);
    if (section.content.length > 0) {
      parts.push(section.content.replace(/^\n/, '').replace(/\n$/, ''));
    }
  }
  const joined = parts.join('\n\n');
  return joined.length === 0 ? '' : `${joined}\n`;
}

/**
 * Replace or append content within a `##` section. Creates the section when missing.
 * `mode`: 'replace' swaps section body; 'append' adds after existing section content.
 */
export function editSectionBody(
  body: string,
  sectionHeading: string,
  newContent: string,
  mode: 'replace' | 'append' = 'replace',
): string {
  const normalizedHeading = sectionHeading.trim();
  const { preamble, sections } = splitSections(body);
  const idx = sections.findIndex(s => s.heading.toLowerCase() === normalizedHeading.toLowerCase());

  if (idx === -1) {
    const content = mode === 'append' && newContent.length > 0 ? `${newContent}\n` : newContent;
    sections.push({ heading: normalizedHeading, content });
    return joinSections(preamble, sections);
  }

  const existing = sections[idx]!;
  const updatedContent = mode === 'append'
    ? (existing.content.length > 0 ? `${existing.content.replace(/\n$/, '')}\n\n${newContent}` : newContent)
    : newContent;
  sections[idx] = { heading: existing.heading, content: updatedContent };
  return joinSections(preamble, sections);
}
