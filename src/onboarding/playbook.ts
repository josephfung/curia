// playbook.ts — the onboarding playbook: default file, parser and seeding (#2360).
//
// The default lives in config/onboarding/playbook.md. Each install gets its own copy at
// PLAYBOOK_PATH (an OKF document the operator can edit in the console, seeded `editable_by:
// console` so doc-write leaves it alone); seeding never overwrites it.
// `#` headings are sessions, `##` headings are topics.

import fs from 'node:fs';
import path from 'node:path';
import type { WorkingDocsRepo } from '../db/working-docs-repo.js';
import type { Logger } from '../logger.js';
import { EDITABLE_BY_CONSOLE, EDITABLE_BY_KEY, isConsoleOnlyMarked } from '../memory/console-only-docs.js';

export type PlaybookTopic = { id: string; title: string; body: string; needsMailbox: boolean };
export type PlaybookSession = { id: string; title: string; topics: PlaybookTopic[] };

export const PLAYBOOK_PATH = '/meetings/onboarding/playbook.md';
export const RESEARCH_BRIEF_PATH = '/meetings/onboarding/research-brief.md';
/** Longest session or topic title kept: topic titles become subtask titles. */
export const PLAYBOOK_TITLE_MAX = 120;
const ID_RE = /^[a-z0-9-]+$/;
const PLAYBOOK_DOC_TYPE = 'onboarding-playbook';

const ID_COMMENT_RE = /<!--\s*(?:session|topic)\s*:\s*([^\s>]+)\s*-->/;
const NEEDS_MAILBOX_RE = /^\s*Needs:\s*mailbox\s*$/im;

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseHeading(raw: string): { id: string; title: string } {
  const declared = ID_COMMENT_RE.exec(raw)?.[1];
  // Strip every HTML comment, including the `--!>` ending browsers also accept.
  const title = raw.replace(/<!--[\s\S]*?--!?>/g, '').trim().slice(0, PLAYBOOK_TITLE_MAX).trim();
  // Ids are only [a-z0-9-]: they become task tags and ride into live principal turns (the
  // onboarding turn block names open topics by id). Anything else is slugified.
  const id = declared === undefined ? slugify(title) : ID_RE.test(declared) ? declared : slugify(declared);
  return { id, title };
}

/** Parse the playbook markdown into sessions and topics. Text before the first `#` is ignored. */
export function parsePlaybook(markdown: string): PlaybookSession[] {
  const sessions: PlaybookSession[] = [];
  let session: PlaybookSession | null = null;
  let topic: { id: string; title: string; lines: string[] } | null = null;

  const closeTopic = (): void => {
    if (session && topic) {
      const body = topic.lines.join('\n').trim();
      session.topics.push({
        id: topic.id,
        title: topic.title,
        body,
        needsMailbox: NEEDS_MAILBOX_RE.test(body),
      });
    }
    topic = null;
  };

  for (const line of markdown.split(/\r?\n/)) {
    const sessionMatch = /^#\s+(.*)$/.exec(line);
    const topicMatch = /^##\s+(.*)$/.exec(line);
    if (sessionMatch) {
      closeTopic();
      session = { ...parseHeading(sessionMatch[1]!), topics: [] };
      sessions.push(session);
    } else if (topicMatch) {
      closeTopic();
      if (session) topic = { ...parseHeading(topicMatch[1]!), lines: [] };
    } else if (topic) {
      topic.lines.push(line);
    }
  }
  closeTopic();
  return sessions;
}

// The tsup bundle collapses src/ into dist/index.js, so a file-local relative path to config/
// is one level shallower there than under tsx. Try both rather than guess.
function defaultPlaybookFile(): string {
  const candidates = ['../../config/onboarding/playbook.md', '../config/onboarding/playbook.md']
    .map((rel) => path.resolve(import.meta.dirname, rel));
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`onboarding playbook default not found (looked in ${candidates.join(', ')})`);
  }
  return found;
}

/**
 * Make sure the install's playbook is a console-owned copy: create it from the repo default if
 * nothing is at PLAYBOOK_PATH, and replace it with the default when it lacks `editable_by:
 * console`. The playbook is always seeded with the mark and doc-write lets no agent remove it, so
 * an unmarked playbook was planted (or predates the mark) and nothing in it is trusted. A marked
 * playbook is never overwritten.
 */
export async function seedPlaybook(
  repo: WorkingDocsRepo,
  logger: Logger,
  defaultFile?: string,
): Promise<'created' | 'exists' | 'replaced'> {
  const existing = await repo.read(PLAYBOOK_PATH);
  if (existing && isConsoleOnlyMarked(existing.frontmatter)) return 'exists';
  const body = fs.readFileSync(defaultFile ?? defaultPlaybookFile(), 'utf-8');
  // Console-only: agents (which read untrusted mail) never write it; the operator edits it in the console.
  const frontmatter = { [EDITABLE_BY_KEY]: EDITABLE_BY_CONSOLE };
  if (existing) {
    logger.warn(
      { path: PLAYBOOK_PATH },
      `onboarding: the playbook is not marked ${EDITABLE_BY_KEY}: ${EDITABLE_BY_CONSOLE} — replacing it with the default`,
    );
    const replaced = await repo.update(PLAYBOOK_PATH, {
      type: PLAYBOOK_DOC_TYPE,
      frontmatter,
      body,
      expectedVersion: existing.version,
    });
    if (!replaced.ok) {
      // Written meanwhile: the next read checks the mark again.
      throw new Error(`onboarding: the unmarked playbook at ${PLAYBOOK_PATH} changed while it was being replaced`);
    }
    return 'replaced';
  }
  try {
    await repo.create({ path: PLAYBOOK_PATH, type: PLAYBOOK_DOC_TYPE, frontmatter, body, taskId: null });
  } catch (err) {
    // A concurrent seed can win the race to the unique path; the playbook then exists, which is the goal.
    const raced = await repo.read(PLAYBOOK_PATH);
    if (raced && isConsoleOnlyMarked(raced.frontmatter)) return 'exists';
    logger.error({ err, path: PLAYBOOK_PATH }, 'onboarding: failed to seed the playbook');
    throw err;
  }
  logger.info({ path: PLAYBOOK_PATH }, 'onboarding: seeded the playbook from the default');
  return 'created';
}

/** The install's playbook, seeding it first if missing (or replacing an unmarked one). */
export async function readPlaybook(repo: WorkingDocsRepo, logger: Logger): Promise<PlaybookSession[]> {
  await seedPlaybook(repo, logger);
  const row = await repo.read(PLAYBOOK_PATH);
  return row ? parsePlaybook(row.body) : [];
}
