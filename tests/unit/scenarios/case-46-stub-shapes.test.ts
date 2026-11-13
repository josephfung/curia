// Cases 46a–46j (#2475): their stubbed ceo-inbox results must have the shape the real tools
// return, or a case can pass against a result production never gives (Task 20b review, item 7).
// The reference shapes come from the real code where it is cheap to run (mailbox evidence,
// mailboxFields) and from the tool manifests otherwise.
import * as path from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadScenarioCase } from '../../scenarios/loader.js';
import { chosenAccountFields, classifyEvidence, mailboxEvidence, type EvidenceVerdict } from '../../../src/principal-mailboxes/evidence.js';
import { mailboxFields } from '../../../skills/_shared/principal-mailbox-client.js';
import { mailboxView, stubPrincipalMailboxes } from '../../../skills/_shared/principal-mailboxes-test-helpers.js';

const CASES_DIR = path.resolve(import.meta.dirname, '../../scenarios/cases');
const SKILLS_DIR = path.resolve(import.meta.dirname, '../../../skills/ceo-inbox/tools');
const cases = readdirSync(CASES_DIR).filter((f) => /^46[a-z]-.*\.yaml$/.test(f)).sort();

function manifest(tool: string): { description: string; outputs: Record<string, string> } {
  return JSON.parse(readFileSync(path.join(SKILLS_DIR, tool, 'tool.json'), 'utf8')) as { description: string; outputs: Record<string, string> };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every stubbed `return` of `tool` across the 46 cases (their own stubs and their stub sets). */
function returnsOf(tool: string): Array<{ file: string; value: Obj; match: Obj }> {
  return cases.flatMap((file) => {
    const scenario = loadScenarioCase(path.join(CASES_DIR, file));
    return (scenario.toolStubs[tool] ?? []).flatMap((s) => (isObj(s.return) ? [{ file, value: s.return, match: s.match }] : []));
  });
}

/** A compose result without its draft id: the account fields. */
const account = (value: Obj): Obj => Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'draft_id'));

/** The keys of one real per-mailbox evidence entry, from mailboxEvidence itself. */
async function realEvidenceKeys(): Promise<string[]> {
  const folders = [{ id: 'SENT', name: 'Sent', attributes: ['\\Sent'] }, { id: 'INBOX', name: 'Inbox', attributes: ['\\Inbox'] }];
  const client = { listFolders: async () => folders, listMessages: async () => [] };
  const svc = stubPrincipalMailboxes({ mailboxes: [mailboxView('work', 'Work', 'w@example.com', true)], gatewayClients: { work: client } });
  const [entry] = await mailboxEvidence(svc, ['a@example.org']);
  return Object.keys(entry!).sort();
}

describe('cases 46a–46j: stubbed results match the real tools (#2475 item 7)', () => {
  it('finds the cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  it('draft-compose: needs_mailbox carries only needs_mailbox and evidence, with real evidence entries', async () => {
    const keys = await realEvidenceKeys();
    const desc = manifest('ceo-inbox-draft-compose').description;
    const needs = returnsOf('ceo-inbox-draft-compose').filter((r) => r.value['needs_mailbox'] !== undefined);
    expect(needs.length).toBeGreaterThan(0);
    for (const { file, value } of needs) {
      expect(Object.keys(value).sort(), file).toEqual(['evidence', 'needs_mailbox']);
      expect(value['needs_mailbox'], file).toBe(true);
      expect(desc).toContain('needs_mailbox');
      for (const e of value['evidence'] as Obj[]) {
        // `error` is optional (an unreadable mailbox); every other key is always present.
        expect(Object.keys(e).filter((k) => k !== 'error').sort(), file).toEqual(keys);
      }
    }
  });

  it('draft-compose: a created draft names its mailbox as chosenAccountFields does, with a real verdict', () => {
    const created = returnsOf('ceo-inbox-draft-compose').filter((r) => r.value['draft_id'] !== undefined);
    expect(created.length).toBeGreaterThan(0);
    for (const { file, value, match } of created) {
      const verdict = value['evidence'] as EvidenceVerdict;
      expect(['agrees', 'leans_other', 'none', 'split'], file).toContain(verdict);
      // The account fields exactly as the handler builds them for this verdict and topic (D5).
      // A noted answer has no label, and chosenAccountFields ignores it then.
      const label = (value['mailbox_label'] as string | undefined) ?? null;
      expect(account(value), file).toEqual(chosenAccountFields(String(value['mailbox']), label, { evidence: verdict }, match['topic_matches_account'] === true));
    }
  });

  // #2475 review I2: a stub's verdict must be the one the case's own evidence gives, or a case can
  // pass on a note the real handler would never return (46h, 0/0 evidence, got `agrees`).
  it('draft-compose: each answer a case actually gets carries the verdict its needs_mailbox evidence gives', () => {
    let checked = 0;
    for (const file of cases) {
      const stubs = loadScenarioCase(path.join(CASES_DIR, file)).toolStubs['ceo-inbox-draft-compose'] ?? [];
      const needs = stubs.find((s) => isObj(s.return) && s.return['needs_mailbox'] === true);
      if (!needs) continue;
      const evidence = (needs.return as Obj)['evidence'] as Array<{ mailbox: string; mailbox_label: string; sent_count: number; received_count: number; domain_match: boolean }>;
      // The case's own stubs come first (mergeStubSets), so a later stub with the same match is shadowed.
      const seen = new Set<string>();
      for (const s of stubs) {
        const key = JSON.stringify(s.match);
        if (seen.has(key)) continue;
        seen.add(key);
        if (!isObj(s.return) || s.return['draft_id'] === undefined) continue;
        const mailbox = String(s.return['mailbox']);
        const entry = evidence.find((e) => e.mailbox === mailbox)!;
        expect(s.return['evidence'], `${file} ${key}`).toBe(classifyEvidence(evidence, mailbox));
        expect(account(s.return), `${file} ${key}`).toEqual(
          chosenAccountFields(mailbox, entry.mailbox_label, { evidence: classifyEvidence(evidence, mailbox) }, s.match['topic_matches_account'] === true),
        );
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(8);
  });

  it('list: each stubbed draft names its mailbox as mailboxFields does', () => {
    const fieldKeys = Object.keys(mailboxFields(mailboxView('work', 'Work', 'w@example.com'))).sort();
    const listed = returnsOf('ceo-inbox-list').filter((r) => Array.isArray(r.value['drafts']));
    expect(listed.length).toBeGreaterThan(0);
    for (const { file, value } of listed) {
      for (const d of value['drafts'] as Obj[]) for (const k of fieldKeys) expect(d, file).toHaveProperty(k);
    }
  });

  it('draft-edit: moved_from has the manifest\'s { mailbox, draft_id } shape', () => {
    const declared = manifest('ceo-inbox-draft-edit').outputs['moved_from']!;
    const keys = /^\{\s*([^}]*)\}/.exec(declared)![1]!.split(',').map((k) => k.trim()).sort();
    const moved = returnsOf('ceo-inbox-draft-edit').filter((r) => r.value['moved_from'] !== undefined);
    expect(moved.length).toBeGreaterThan(0);
    for (const { file, value } of moved) {
      expect(Object.keys(value['moved_from'] as Obj).sort(), file).toEqual(keys);
    }
  });
});
