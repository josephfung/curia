// Smoke's fixture people and principal placeholders (#1956).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TestModeStack } from '../../../src/startup/test-mode-stack.js';
import { loadPeople, resolvePrincipalPlaceholders, seedPeople } from '../../smoke/fixtures.js';
import { loadDefaultStubs, loadTestCases } from '../../smoke/loader.js';

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
});
