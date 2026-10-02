// tests/smoke/fixtures.ts — the people in smoke's fixture office (#1956).
//
// Cases talk about Sarah Chen, the board chair, David Kim at Sequoia… Contact tools are
// real (they read the database), so those people are seeded as real contacts into the
// run's throwaway database copy (clone-db.ts) before any case runs. Calendar and mailbox
// contents come from stubs/office.yaml instead. Fixture addresses use the reserved
// `.example` TLD (RFC 2606), so none can ever be a real mailbox.
import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';
import type { TestModeStack } from '../../src/startup/test-mode-stack.js';

export interface FixturePerson {
  displayName: string;
  email: string;
  title?: string;
  organization?: string;
  role?: string;
  notes?: string;
}

const PERSON_KEYS: ReadonlySet<string> = new Set(['display_name', 'email', 'title', 'organization', 'role', 'notes']);

export function loadPeople(filePath: string): FixturePerson[] {
  const raw = yaml.load(readFileSync(filePath, 'utf-8'));
  if (!Array.isArray(raw)) throw new Error(`${filePath}: expected a list of people`);
  return raw.map((p: unknown, i) => {
    if (p === null || typeof p !== 'object') throw new Error(`${filePath}: entry ${i} is not a mapping`);
    const r = p as Record<string, unknown>;
    const unknownKeys = Object.keys(r).filter(k => !PERSON_KEYS.has(k));
    if (unknownKeys.length > 0) throw new Error(`${filePath}: entry ${i} has unknown key(s) ${unknownKeys.join(', ')}`);
    const str = (k: string): string | undefined => {
      if (r[k] === undefined) return undefined;
      if (typeof r[k] !== 'string' || (r[k] as string).trim() === '') throw new Error(`${filePath}: entry ${i}: '${k}' must be a non-empty string`);
      return (r[k] as string).trim();
    };
    const displayName = str('display_name');
    const email = str('email');
    if (!displayName || !email) throw new Error(`${filePath}: entry ${i} needs display_name and email`);
    if (!/@[a-z0-9.-]+\.example$/i.test(email)) {
      throw new Error(`${filePath}: '${email}' must be under the reserved .example TLD`);
    }
    const title = str('title');
    const organization = str('organization');
    const role = str('role');
    const notes = str('notes');
    return {
      displayName,
      email,
      ...(title ? { title } : {}),
      ...(organization ? { organization } : {}),
      ...(role ? { role } : {}),
      ...(notes ? { notes } : {}),
    };
  });
}

/**
 * Create each person as a known contact with a verified email identity. Someone already
 * on that address (an earlier seeding of the same copy) is left as is. Returns how many
 * were created.
 */
export async function seedPeople(stack: TestModeStack, people: FixturePerson[]): Promise<number> {
  let created = 0;
  for (const p of people) {
    if (await stack.contactService.resolveByChannelIdentity('email', p.email)) continue;
    const contact = await stack.contactService.createContact({
      displayName: p.displayName,
      tier: 'known',
      source: 'smoke-fixture',
      primaryEmail: p.email,
      ...(p.title ? { title: p.title } : {}),
      ...(p.organization ? { organization: p.organization } : {}),
      ...(p.role ? { role: p.role } : {}),
      ...(p.notes ? { notes: p.notes } : {}),
    });
    await stack.contactService.linkIdentity({
      contactId: contact.id,
      channel: 'email',
      channelIdentifier: p.email,
      source: 'ceo_stated',
      verified: true,
    });
    created++;
  }
  return created;
}

/** The principal as cases may name them: `{{principal:name}}`, `{{principal:first}}`, `{{principal:contact_id}}`. */
export interface PrincipalRef {
  name: string;
  contactId: string;
}

const PRINCIPAL_PLACEHOLDER = /\{\{\s*principal:([a-z_]+)\s*\}\}/g;

/**
 * Replace principal placeholders in strings at any depth. Cases were once written for a
 * principal called "Alex"; naming the real one keeps a forwarded thread addressed to
 * the person the coordinator actually works for.
 */
export function resolvePrincipalPlaceholders<T>(value: T, principal: PrincipalRef): T {
  const fields: Record<string, string> = {
    name: principal.name,
    first: principal.name.split(/\s+/)[0] ?? principal.name,
    contact_id: principal.contactId,
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return v.replace(PRINCIPAL_PLACEHOLDER, (_, field: string) => {
        const resolved = fields[field];
        if (resolved === undefined) throw new Error(`unknown placeholder {{principal:${field}}} — use name, first or contact_id`);
        return resolved;
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}
