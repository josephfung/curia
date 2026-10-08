// Smoke's fixture people and principal placeholders (#1956).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TestModeStack } from '../../../src/startup/test-mode-stack.js';
import { loadPeople, resolvePrincipalPlaceholders, seedPeople } from '../../smoke/fixtures.js';
import { loadDefaultStubs, loadTestCases } from '../../smoke/loader.js';
import { mergeStubs } from '../../smoke/stub-layer.js';
import { matchToolStub } from '../../scenarios/stub-matcher.js';

function peopleFile(body: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'smoke-people-')), 'people.yaml');
  writeFileSync(file, body);
  return file;
}

describe('loadPeople', () => {
  it('loads the committed fixture office', () => {
    const people = loadPeople('tests/smoke/fixtures/people.yaml');
    expect(people.length).toBeGreaterThan(0);
    expect(people.every(p => p.email === undefined || p.email.endsWith('.example'))).toBe(true);
  });

  it('accepts a person with no email (an address only in mail history, #2014)', () => {
    const [person] = loadPeople(peopleFile('- { display_name: No Address, organization: TechTO }'));
    expect(person).toEqual({ displayName: 'No Address', organization: 'TechTO' });
  });

  it('refuses an address outside the reserved .example TLD', () => {
    expect(() => loadPeople(peopleFile('- { display_name: Real Person, email: someone@gmail.com }'))).toThrow(/\.example/);
    // A real address smuggled in front of a reserved one.
    expect(() => loadPeople(peopleFile('- { display_name: Two, email: "bob@gmail.com,x@y.example" }'))).toThrow(/\.example/);
  });

  it('rejects unknown keys and missing fields', () => {
    expect(() => loadPeople(peopleFile('- { display_name: A, email: a@x.example, phone: 1 }'))).toThrow(/unknown key/);
    expect(() => loadPeople(peopleFile('- { email: a@x.example }'))).toThrow(/needs display_name/);
  });
});

describe('seedPeople', () => {
  // Just the contact-service calls seedPeople makes; `existing` is who is already seeded.
  function stackWith(existing: { email?: string; displayName: string }[]) {
    const contactService = {
      resolveByChannelIdentity: vi.fn(async (_channel: string, id: string) =>
        existing.some(p => p.email === id) ? { contactId: 'c-old' } : null),
      findContactByName: vi.fn(async (name: string) =>
        existing.filter(p => p.displayName.toLowerCase().includes(name.toLowerCase()))),
      createContact: vi.fn(async (opts: { displayName: string }) => ({ id: `c-${opts.displayName}` })),
      linkIdentity: vi.fn(async () => ({})),
    };
    return { stack: { contactService } as unknown as TestModeStack, contactService };
  }

  it('creates a person with no email without an email identity', async () => {
    const { stack, contactService } = stackWith([]);
    expect(await seedPeople(stack, [{ displayName: 'Maya Fischer', organization: 'TechTO' }])).toBe(1);
    expect(contactService.createContact).toHaveBeenCalledWith(expect.not.objectContaining({ primaryEmail: expect.anything() }));
    expect(contactService.linkIdentity).not.toHaveBeenCalled();
  });

  it('skips an email-less person already seeded, but only on an exact name', async () => {
    const { stack, contactService } = stackWith([{ displayName: 'Maya Fischer-Long' }]);
    // A substring hit is a different person: still created.
    expect(await seedPeople(stack, [{ displayName: 'Maya Fischer' }])).toBe(1);
    const again = stackWith([{ displayName: 'maya fischer' }]);
    expect(await seedPeople(again.stack, [{ displayName: 'Maya Fischer' }])).toBe(0);
    expect(again.contactService.createContact).not.toHaveBeenCalled();
    expect(contactService.createContact).toHaveBeenCalledTimes(1);
  });

  it('links a verified identity for a person with an email, and skips one already on file', async () => {
    const { stack, contactService } = stackWith([{ displayName: 'Old', email: 'old@x.example' }]);
    const created = await seedPeople(stack, [
      { displayName: 'Old', email: 'old@x.example' },
      { displayName: 'New', email: 'new@x.example' },
    ]);
    expect(created).toBe(1);
    expect(contactService.linkIdentity).toHaveBeenCalledWith(expect.objectContaining({ channelIdentifier: 'new@x.example', verified: true }));
  });
});

describe('resolvePrincipalPlaceholders', () => {
  const principal = { name: 'Pat Example', contactId: 'c-1' };

  it('fills name, first name and contact id at any depth', () => {
    expect(resolvePrincipalPlaceholders({ to: ['{{principal:name}}'], hi: 'Hi {{principal:first}}', id: '{{principal:contact_id}}' }, principal))
      .toEqual({ to: ['Pat Example'], hi: 'Hi Pat', id: 'c-1' });
  });

  it('rejects an unknown field', () => {
    expect(() => resolvePrincipalPlaceholders('{{principal:email}}', principal)).toThrow(/principal:email/);
  });
});

describe('the committed suite', () => {
  it('loads every case and the office stubs, placeholders included', () => {
    expect(loadTestCases('tests/smoke/cases').length).toBeGreaterThan(0);
    expect(Object.keys(loadDefaultStubs('tests/smoke/stubs/office.yaml'))).toContain('calendar-list-events');
  });

  // A listed message the agent cannot open, or an attachment it cannot download, sends
  // ceo-inbox into a retry loop that can exhaust its error budget. The case then
  // measures the fixture, not the model (Triage Batch of Mixed Emails, trim plan PR 11
  // A/B). Checked per turn through the runner's own merge (runner.ts) and matcher, so a
  // case-level catch-all that shadows an office stub counts as a gap too.
  it('lets ceo-inbox open every message and attachment any case lists or finds', () => {
    type Attachment = { id: string; filename: string; size: number };
    type Listed = { id: string; attachments?: Attachment[] };
    const office = loadDefaultStubs('tests/smoke/stubs/office.yaml');
    const gaps: string[] = [];
    let messagesChecked = 0;
    let attachmentsChecked = 0;

    for (const tc of loadTestCases('tests/smoke/cases')) {
      tc.turns.forEach((turn, t) => {
        const where = `${tc.name} (turn ${t + 1})`;
        const stubs = mergeStubs(turn.toolStubs, tc.toolStubs, office);
        const listed = ['ceo-inbox-list', 'ceo-inbox-search']
          .flatMap((tool) => stubs[tool] ?? [])
          .flatMap((stub) => ((stub.return as { messages?: Listed[] } | undefined)?.messages ?? []));

        const readOnly = (stubs['ceo-inbox-read'] ?? [])
          .map((stub) => stub.match.message_id)
          .filter((id): id is string => typeof id === 'string' && !listed.some((m) => m.id === id));
        for (const id of readOnly) {
          const label = matchToolStub('ceo-inbox-label', { message_id: id, labels: ['🚨 Urgent'] }, stubs);
          if (!label || label.error) gaps.push(`${where}: ceo-inbox-label cannot label ${id}`);
        }

        for (const message of listed) {
          messagesChecked++;
          const read = matchToolStub('ceo-inbox-read', { message_id: message.id }, stubs);
          if (!read || read.error) {
            gaps.push(`${where}: ceo-inbox-read cannot open ${message.id}`);
            continue;
          }
          // Triage labels what it reads.
          const label = matchToolStub('ceo-inbox-label', { message_id: message.id, labels: ['🚨 Urgent'] }, stubs);
          if (!label || label.error) gaps.push(`${where}: ceo-inbox-label cannot label ${message.id}`);
          // The agent takes attachment ids from the read (the download tool says so), so
          // check what the read returns as well as what the listing shows.
          const fromRead = (read.return as { attachments?: Attachment[] } | undefined)?.attachments ?? [];
          const attachments = new Map([...(message.attachments ?? []), ...fromRead].map((a) => [a.id, a]));
          for (const attachment of attachments.values()) {
            attachmentsChecked++;
            const download = matchToolStub(
              'ceo-inbox-download-attachment',
              { message_id: message.id, attachment_id: attachment.id },
              stubs,
            );
            if (!download || download.error) {
              gaps.push(`${where}: ceo-inbox-download-attachment cannot fetch ${attachment.filename}`);
              continue;
            }
            // The download must describe the listed file, and the agent's next step on it
            // (file-parse, which test mode cannot run) must have an answer for that file.
            const file = download.return as { filename: string; size: number; temp_file_url?: string };
            if (file.filename !== attachment.filename || file.size !== attachment.size) {
              gaps.push(`${where}: ${attachment.filename} download does not match its listing`);
            }
            const parsed = file.temp_file_url
              ? matchToolStub('file-parse', { temp_file_url: file.temp_file_url, mime_type: 'application/pdf' }, stubs)
              : undefined;
            if (!parsed || parsed.error) gaps.push(`${where}: file-parse cannot read ${attachment.filename}`);
          }
        }
      });
    }
    expect([...new Set(gaps)]).toEqual([]);
    // Not vacuous: a renamed `messages` key or a broken YAML anchor would check nothing.
    expect(messagesChecked).toBeGreaterThan(8);
    expect(attachmentsChecked).toBeGreaterThan(1);
  });
});
