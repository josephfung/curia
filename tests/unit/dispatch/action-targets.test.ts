import { describe, it, expect, vi } from 'vitest';
import { extractActionTargets, type ActionTargetDeps } from '../../../src/dispatch/action-targets.js';
import type { Logger } from '../../../src/logger.js';

const X = '11111111-1111-4111-8111-111111111111';
const Y = '22222222-2222-4222-8222-222222222222';
const M = '33333333-3333-4333-8333-333333333333';
const P = '44444444-4444-4444-8444-444444444444';

const contacts = new Set([X, Y, P]);
const isContact = async (id: string): Promise<boolean> => contacts.has(id);
const deps = { principalContactId: P, isContact };

describe('extractActionTargets', () => {
  it('send to a contact targets the contact only', async () => {
    const t = await extractActionTargets('email-send', { recipient: X, account_id: M }, deps);
    expect(t).toEqual([{ kind: 'contact', value: X }]);
  });

  it('shared mailbox uuid does not leak into contact sends', async () => {
    const a = await extractActionTargets('email-send', { recipient: X, mailbox: M }, deps);
    const b = await extractActionTargets('email-send', { recipient: Y, mailbox: M }, deps);
    const keys = (ts: typeof a) => new Set(ts.map((x) => `${x.kind}:${x.value}`));
    const ka = keys(a);
    expect([...keys(b)].filter((k) => ka.has(k))).toEqual([]);
  });

  it('principal contact id is excluded', async () => {
    const t = await extractActionTargets('email-send', { recipient: P, cc: X }, deps);
    expect(t).toEqual([{ kind: 'contact', value: X }]);
  });

  it("Curia's own agent contact id is excluded like the principal's", async () => {
    const A = '55555555-5555-4555-8555-555555555555';
    const withAgent = { ...deps, agentContactId: A, isContact: async (id: string) => contacts.has(id) || id === A };
    const t = await extractActionTargets('email-send', { recipient: A, cc: X }, withAgent);
    expect(t).toEqual([{ kind: 'contact', value: X }]);
  });

  it('url becomes its host without www', async () => {
    const t = await extractActionTargets('web-fetch', { url: 'https://www.cal.com/alan/30min' }, deps);
    expect(t).toEqual([{ kind: 'site', value: 'cal.com' }]);
  });

  it('no contact or site falls back to ids only', async () => {
    const t = await extractActionTargets('email-draft-send', { draft_id: 'r-12ab34cd' }, deps);
    expect(t).toEqual([{ kind: 'id', value: 'r-12ab34cd' }]);
  });

  it('two calls on different ids share no target', async () => {
    const a = await extractActionTargets('email-reply', { reply_to_message_id: 'msg-1111aaaa' }, deps);
    const b = await extractActionTargets('email-reply', { reply_to_message_id: 'msg-2222bbbb' }, deps);
    const keys = (ts: typeof a) => new Set(ts.map((x) => `${x.kind}:${x.value}`));
    const ka = keys(a);
    expect([...keys(b)].filter((k) => ka.has(k))).toEqual([]);
  });

  it('empty input falls back to tool name only', async () => {
    expect(await extractActionTargets('t', {}, deps)).toEqual([{ kind: 'tool', value: 't' }]);
  });

  it('email addresses are not ids', async () => {
    const t = await extractActionTargets('t', { to: 'alan1234@example.com' }, deps);
    expect(t).toEqual([{ kind: 'tool', value: 't' }]);
  });

  it('non-contact uuids fall back to ids', async () => {
    const t = await extractActionTargets('t', { account_id: M }, deps);
    expect(t).toEqual([{ kind: 'id', value: M }]);
  });

  it('walk is bounded to 50 string values', async () => {
    const filler = Array.from({ length: 50 }, () => 'a');
    const t = await extractActionTargets('t', { list: [...filler, 'https://late.example.org/'] }, deps);
    expect(t).toEqual([{ kind: 'tool', value: 't' }]);
    const t2 = await extractActionTargets('t', { list: [...filler.slice(1), 'https://late.example.org/'] }, deps);
    expect(t2).toEqual([{ kind: 'site', value: 'late.example.org' }]);
  });

  it('walk is bounded to depth 6', async () => {
    // Containers nest 6 levels below the top-level object at most; a 7th is ignored.
    const deep = { a: { b: { c: { d: { e: { f: { g: X } } } } } } };
    expect(await extractActionTargets('t', deep, deps)).toEqual([{ kind: 'contact', value: X }]);
    const tooDeep = { a: { b: { c: { d: { e: { f: { g: { h: X } } } } } } } };
    expect(await extractActionTargets('t', tooDeep, deps)).toEqual([{ kind: 'tool', value: 't' }]);
    const ok = { a: { b: { c: { d: { e: { f: X } } } } } };
    expect(await extractActionTargets('t', ok, deps)).toEqual([{ kind: 'contact', value: X }]);
  });

  it('a rejected isContact counts as not a contact and is logged by id kind only', async () => {
    const warn = vi.fn();
    const logger = { warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger;
    const t = await extractActionTargets('t', { r: X, s: Y }, {
      principalContactId: undefined,
      isContact: async (id) => {
        // The rejection quotes the id it was given, as a driver error can.
        if (id === X) throw new TypeError(`no row for ${id}`);
        return true;
      },
      logger,
    });
    expect(t).toEqual([{ kind: 'contact', value: Y }]);
    expect(warn).toHaveBeenCalledTimes(1);
    const fields = warn.mock.calls[0]![0] as Record<string, unknown>;
    expect(fields).toEqual({ errName: 'TypeError', toolName: 't', idKind: 'uuid' });
    expect(JSON.stringify(fields)).not.toContain(X);
  });
});

describe('extractActionTargets email addresses (#2588)', () => {
  const B = '55555555-5555-4555-8555-555555555555';
  const byEmail: Record<string, string> = {
    'barbara@example.com': B,
    'principal@example.com': P,
  };
  const emailDeps = (over: Partial<ActionTargetDeps> = {}): ActionTargetDeps => ({
    ...deps,
    contactIdForEmail: async (email) => byEmail[email],
    excludedEmails: new Set(['principal@example.com', 'curia@office.example.com']),
    ...over,
  });

  it('a calendar attendee address resolves to a contact target', async () => {
    const t = await extractActionTargets(
      'calendar-create-event',
      { title: 'Sync', attendees: [{ email: 'Barbara@Example.com', name: 'Barbara Liskov' }] },
      emailDeps(),
    );
    expect(t).toEqual([{ kind: 'contact', value: B }]);
  });

  it("the principal's and Curia's own addresses are never looked up", async () => {
    const lookup = vi.fn(async (email: string) => byEmail[email]);
    const t = await extractActionTargets(
      'calendar-create-event',
      { attendees: [{ email: 'principal@example.com' }, { email: 'curia@office.example.com' }] },
      emailDeps({ contactIdForEmail: lookup }),
    );
    expect(lookup).not.toHaveBeenCalled();
    expect(t).toEqual([{ kind: 'tool', value: 'calendar-create-event' }]);
  });

  it("an address that resolves to the principal's contact is excluded", async () => {
    const t = await extractActionTargets('t', { to: 'principal@example.com' }, emailDeps({ excludedEmails: new Set() }));
    expect(t).toEqual([{ kind: 'tool', value: 't' }]);
  });

  it('an unresolved address is ignored', async () => {
    const t = await extractActionTargets('t', { to: 'stranger@example.org' }, emailDeps());
    expect(t).toEqual([{ kind: 'tool', value: 't' }]);
  });

  it('a uuid and an address of the same contact give one target', async () => {
    const t = await extractActionTargets('t', { contact_id: B, to: 'barbara@example.com' }, emailDeps({
      isContact: async (id) => id === B,
    }));
    expect(t).toEqual([{ kind: 'contact', value: B }]);
  });

  it('uuid checks and email lookups share the cap of 10, uuids first', async () => {
    const uuids = Array.from({ length: 9 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
    const lookup = vi.fn(async (email: string) => byEmail[email]);
    const debug = vi.fn();
    const logger = { warn: vi.fn(), debug, info: vi.fn(), error: vi.fn() } as unknown as Logger;
    await extractActionTargets(
      't',
      { ids: uuids, to: ['barbara@example.com', 'other@example.com'] },
      emailDeps({ isContact: async () => false, contactIdForEmail: lookup, logger }),
    );
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('barbara@example.com');
    expect(debug).toHaveBeenCalledWith(expect.objectContaining({ lookups: 10, lookupCandidates: 11 }), expect.any(String));
  });

  it('a rejected email lookup is logged without the address, even when its error quotes it', async () => {
    const warn = vi.fn();
    const logger = { warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger;
    const t = await extractActionTargets('t', { to: 'barbara@example.com', cc: 'carol@example.com' }, emailDeps({
      contactIdForEmail: async (email) => {
        if (email === 'carol@example.com') throw `lookup failed for ${email}`;
        throw new Error(`no identity for ${email}`);
      },
      logger,
    }));
    expect(t).toEqual([{ kind: 'tool', value: 't' }]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      { errName: 'Error', toolName: 't', idKind: 'email' },
      { errName: 'string', toolName: 't', idKind: 'email' },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/barbara|carol/);
  });

  it('without an email lookup, addresses are ignored', async () => {
    const t = await extractActionTargets('t', { to: 'barbara@example.com' }, deps);
    expect(t).toEqual([{ kind: 'tool', value: 't' }]);
  });
});

describe('extractActionTargets truncation logging', () => {
  it('logs counts at debug when the string walk is capped', async () => {
    const debug = vi.fn();
    const logger = { warn: vi.fn(), debug, info: vi.fn(), error: vi.fn() } as unknown as Logger;
    const filler = Array.from({ length: 60 }, () => 'a');
    await extractActionTargets('t', { list: filler }, { ...deps, logger });
    expect(debug).toHaveBeenCalledWith(expect.objectContaining({ stringsSeen: 50, stringCapReached: true }), expect.any(String));
  });

  it('logs at debug when a container is too deep', async () => {
    const debug = vi.fn();
    const logger = { warn: vi.fn(), debug, info: vi.fn(), error: vi.fn() } as unknown as Logger;
    await extractActionTargets('t', { a: { b: { c: { d: { e: { f: { g: { h: X } } } } } } } }, { ...deps, logger });
    expect(debug).toHaveBeenCalledWith(expect.objectContaining({ depthCapReached: true }), expect.any(String));
  });
});
