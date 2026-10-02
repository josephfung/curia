// Smoke's fixture people and principal placeholders (#1956).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPeople, resolvePrincipalPlaceholders } from '../../smoke/fixtures.js';
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
    expect(people.every(p => p.email.endsWith('.example'))).toBe(true);
  });

  it('refuses an address outside the reserved .example TLD', () => {
    expect(() => loadPeople(peopleFile('- { display_name: Real Person, email: someone@gmail.com }'))).toThrow(/\.example/);
    // A real address smuggled in front of a reserved one.
    expect(() => loadPeople(peopleFile('- { display_name: Two, email: "bob@gmail.com,x@y.example" }'))).toThrow(/\.example/);
  });

  it('rejects unknown keys and missing fields', () => {
    expect(() => loadPeople(peopleFile('- { display_name: A, email: a@x.example, phone: 1 }'))).toThrow(/unknown key/);
    expect(() => loadPeople(peopleFile('- { display_name: A }'))).toThrow(/display_name and email/);
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
