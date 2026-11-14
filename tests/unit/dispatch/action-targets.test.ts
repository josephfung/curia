import { describe, it, expect } from 'vitest';
import { extractActionTargets } from '../../../src/dispatch/action-targets.js';

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

  it('propagates isContact rejection', async () => {
    await expect(
      extractActionTargets('t', { r: X }, { principalContactId: undefined, isContact: async () => { throw new Error('db'); } }),
    ).rejects.toThrow('db');
  });
});
