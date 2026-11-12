import { describe, it, expect } from 'vitest';
import { migrateSendingKey } from '../../../src/principal-mailboxes/migrate-config-keys.js';

function store(initial: string | null) {
  let value = initial;
  const writes: string[] = [];
  return {
    get: async (_ns: string, _key: string) => value,
    set: async (_ns: string, _key: string, v: string) => { value = v; writes.push(v); return { stored: true, action: 'created' }; },
    current: () => value,
    writes,
  };
}

describe('migrateSendingKey', () => {
  it('renames default once and is idempotent', async () => {
    const s = store('{"default":"routine"}');
    expect(await migrateSendingKey(s, 'work')).toBe('renamed');
    expect(JSON.parse(s.current()!)).toEqual({ work: 'routine' });
    expect(await migrateSendingKey(s, 'work')).toBe('nothing');
    expect(s.writes).toHaveLength(1);
  });
  it('does nothing when unset, unparseable or without a default key', async () => {
    for (const raw of [null, 'not json', '[1]', '{"work":"all"}']) {
      const s = store(raw);
      expect(await migrateSendingKey(s, 'work'), String(raw)).toBe('nothing');
      expect(s.writes).toHaveLength(0);
    }
  });
  it('keeps an existing entry for the id and drops the stale default', async () => {
    const s = store('{"default":"all","work":"off"}');
    expect(await migrateSendingKey(s, 'work')).toBe('renamed');
    expect(JSON.parse(s.current()!)).toEqual({ work: 'off' });
  });
  it('keeps other mailboxes entries', async () => {
    const s = store('{"default":"all","personal":"routine"}');
    await migrateSendingKey(s, 'work');
    expect(JSON.parse(s.current()!)).toEqual({ work: 'all', personal: 'routine' });
  });
});
