import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { PLAYBOOK_PATH, parsePlaybook, seedPlaybook } from '../../../src/onboarding/playbook.js';
import type { WorkingDocsRepo, WorkingDocRow } from '../../../src/db/working-docs-repo.js';

const REAL_PLAYBOOK = path.resolve(import.meta.dirname, '../../../config/onboarding/playbook.md');

describe('parsePlaybook', () => {
  it('reads explicit session and topic ids and ignores text before the first #', () => {
    const sessions = parsePlaybook([
      'Intro text that is ignored',
      '# First chat <!-- session: first -->',
      '## Hello <!-- topic: hi -->',
      'Say hello.',
      '## Second <!-- topic: two -->',
      'More.',
    ].join('\n'));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe('first');
    expect(sessions[0]!.title).toBe('First chat');
    expect(sessions[0]!.topics.map((t) => t.id)).toEqual(['hi', 'two']);
    expect(sessions[0]!.topics[0]!.body).toBe('Say hello.');
  });

  it('falls back to a slug of the heading', () => {
    const sessions = parsePlaybook('# Check In\n## How I should sound\nBody');
    expect(sessions[0]!.id).toBe('check-in');
    expect(sessions[0]!.topics[0]!.id).toBe('how-i-should-sound');
  });

  it('slugifies an id outside [a-z0-9-] and caps titles at 120 characters', () => {
    const long = 'x'.repeat(300);
    const [session] = parsePlaybook([
      '# First <!-- session: First_Conversation -->',
      `## ${long} <!-- topic: ok-id -->`,
      '## Odd <!-- topic: Bad]Id! -->',
    ].join('\n'));
    expect(session!.id).toBe('first-conversation');
    expect(session!.topics.map((t) => t.id)).toEqual(['ok-id', 'bad-id']);
    expect(session!.topics[0]!.title).toHaveLength(120);
  });

  it('sets needsMailbox from a "Needs: mailbox" line only', () => {
    const [session] = parsePlaybook('# S\n## A\nNeeds: mailbox\ntext\n## B\nno need');
    expect(session!.topics.map((t) => t.needsMailbox)).toEqual([true, false]);
  });

  it('returns [] for empty input', () => {
    expect(parsePlaybook('')).toEqual([]);
  });

  it('parses the shipped default with the expected sessions and topics', () => {
    const sessions = parsePlaybook(fs.readFileSync(REAL_PLAYBOOK, 'utf-8'));
    expect(sessions.map((s) => s.id)).toEqual([
      'first-conversation', 'review', 'check-in', 'ongoing-rhythm', 'weekly',
    ]);
    const first = sessions[0]!;
    expect(first.topics.map((t) => t.id)).toEqual([
      'hello', 'about-you', 'style', 'independence', 'reach-you', 'connect-mailbox',
      'inbox-expectations', 'spoken-voice', 'drives-imports', 'review-format', 'first-look', 'next-step',
    ]);
    expect(first.topics.find((t) => t.id === 'inbox-expectations')!.needsMailbox).toBe(true);
    expect(first.topics.find((t) => t.id === 'connect-mailbox')!.needsMailbox).toBe(false);
  });
});

describe('seedPlaybook', () => {
  it('creates once, then reports exists without writing again', async () => {
    const docs = new Map<string, WorkingDocRow>();
    const create = vi.fn(async (params: { path: string; body?: string }) => {
      const row = { path: params.path, body: params.body ?? '' } as WorkingDocRow;
      docs.set(params.path, row);
      return row;
    });
    const update = vi.fn();
    const repo = { read: async (p: string) => docs.get(p) ?? null, create, update } as unknown as WorkingDocsRepo;
    const logger = pino({ level: 'silent' });

    expect(await seedPlaybook(repo, logger)).toBe('created');
    expect(await seedPlaybook(repo, logger)).toBe('exists');
    expect(create).toHaveBeenCalledTimes(1);
    // Console-only: doc-write refuses it (editable_by).
    expect(create.mock.calls[0]![0]).toMatchObject({ frontmatter: { editable_by: 'console' } });
    expect(update).not.toHaveBeenCalled();
    expect(docs.get(PLAYBOOK_PATH)!.body).toContain('# First conversation');
  });
});
