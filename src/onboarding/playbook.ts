// playbook.ts — the onboarding playbook: default file, parser and seeding (#2360).
//
// The default lives in config/onboarding/playbook.md. Each install gets its own copy at
// PLAYBOOK_PATH (an OKF document the operator can edit); seeding never overwrites it.
// `#` headings are sessions, `##` headings are topics.

import fs from 'node:fs';
import path from 'node:path';
import type { WorkingDocsRepo } from '../db/working-docs-repo.js';
import type { Logger } from '../logger.js';

export type PlaybookTopic = { id: string; title: string; body: string; needsMailbox: boolean };
export type PlaybookSession = { id: string; title: string; topics: PlaybookTopic[] };

/** Onboarding's documents: doc-write guards this folder (#2360). */
export const ONBOARDING_DOCS_PREFIX = '/meetings/onboarding/';
export const PLAYBOOK_PATH = '/meetings/onboarding/playbook.md';
export const RESEARCH_BRIEF_PATH = '/meetings/onboarding/research-brief.md';
/**
 * Longest session or topic title kept. Topic titles become subtask titles, which ride into every
 * live principal turn, so an edited playbook cannot push a long text in there.
 */
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
  const title = raw.replace(/<!--.*?-->/g, '').trim().slice(0, PLAYBOOK_TITLE_MAX).trim();
  // Ids are only [a-z0-9-]: they become task tags and ride into turns. Anything else is slugified.
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

/** Create the install's playbook from the repo default if nothing is at PLAYBOOK_PATH. Never overwrites. */
export async function seedPlaybook(
  repo: WorkingDocsRepo,
  logger: Logger,
  defaultFile?: string,
): Promise<'created' | 'exists'> {
  if (await repo.read(PLAYBOOK_PATH)) return 'exists';
  const body = fs.readFileSync(defaultFile ?? defaultPlaybookFile(), 'utf-8');
  try {
    await repo.create({ path: PLAYBOOK_PATH, type: PLAYBOOK_DOC_TYPE, body, taskId: null });
  } catch (err) {
    // A concurrent seed can win the race to the unique path; the playbook then exists, which is the goal.
    if (await repo.read(PLAYBOOK_PATH)) return 'exists';
    logger.error({ err, path: PLAYBOOK_PATH }, 'onboarding: failed to seed the playbook');
    throw err;
  }
  logger.info({ path: PLAYBOOK_PATH }, 'onboarding: seeded the playbook from the default');
  return 'created';
}

/** The install's playbook, seeding it first if missing. */
export async function readPlaybook(repo: WorkingDocsRepo, logger: Logger): Promise<PlaybookSession[]> {
  await seedPlaybook(repo, logger);
  const row = await repo.read(PLAYBOOK_PATH);
  return row ? parsePlaybook(row.body) : [];
}
