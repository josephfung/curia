import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { parseSendLevel, readSendLevelValue, createSendLevelReader, checkSendLevelWrite } from '../../../../src/skills/principal-send/send-level.js';

const logger = pino({ level: 'silent' });

describe('parseSendLevel', () => {
  it('defaults to on_request when unset', () => {
    expect(parseSendLevel(null)).toBe('on_request');
  });
  it('reads a valid level for the mailbox', () => {
    expect(parseSendLevel('{"default":"routine"}')).toBe('routine');
  });
  it('falls back on an unknown level', () => {
    expect(parseSendLevel('{"default":"everything"}')).toBe('on_request');
  });
  it('falls back on invalid JSON', () => {
    expect(parseSendLevel('not json')).toBe('on_request');
  });
  it('falls back when the mailbox has no entry', () => {
    expect(parseSendLevel('{"work":"all"}', 'default')).toBe('on_request');
  });
});

describe('createSendLevelReader', () => {
  it('reads the stored level', async () => {
    const read = createSendLevelReader({ get: async () => '{"default":"off"}', logger });
    expect(await read('default')).toBe('off');
  });
  it('warns when a stored value is malformed or names an unknown level, and still uses on_request (final review M2)', async () => {
    for (const raw of ['not json', '[1]', '"off"', '{"default":"of"}', '{"default":7}']) {
      const warn = vi.fn();
      const log = { ...logger, warn } as unknown as typeof logger;
      const read = createSendLevelReader({ get: async () => raw, logger: log });
      expect(await read('default'), raw).toBe('on_request');
      expect(warn, raw).toHaveBeenCalledOnce();
      // The stored value is not logged.
      expect(JSON.stringify(warn.mock.calls), raw).not.toContain(raw.replace(/"/g, '\\"'));
    }
  });
  it('new mailbox with no key reads on_request, without a warning', async () => {
    for (const raw of ['{"Default":"off"}', '{"work":"all"}']) {
      const warn = vi.fn();
      const log = { ...logger, warn } as unknown as typeof logger;
      expect(await createSendLevelReader({ get: async () => raw, logger: log })('personal'), raw).toBe('on_request');
      expect(warn, raw).not.toHaveBeenCalled();
    }
    expect(readSendLevelValue('{"work":"all"}', 'personal')).toEqual({ level: 'on_request', malformed: false });
  });
  // Live mailboxes as the reader sees them: `migrated` has no triage start (the flat migration's row).
  const migrated = (id: string) => ({ id, triageStartAt: null });
  const added = (id: string) => ({ id, triageStartAt: new Date('2026-11-01T00:00:00Z') });

  it('a legacy default key applies only to the migrated mailbox while it is the one live mailbox (R41, S-I1)', async () => {
    const warn = vi.fn();
    const log = { ...logger, warn } as unknown as typeof logger;
    const raw = '{"default":"routine"}';
    const one = createSendLevelReader({ get: async () => raw, logger: log, liveMailboxes: async () => [migrated('work')] });
    expect(await one('work')).toBe('routine');
    // A second mailbox was added (and perhaps made the default): nobody inherits the level.
    const two = createSendLevelReader({ get: async () => raw, logger: log, liveMailboxes: async () => [migrated('work'), added('personal')] });
    expect(await two('work')).toBe('on_request');
    expect(await two('personal')).toBe('on_request');
    // An own key wins over a leftover default.
    const own = createSendLevelReader({ get: async () => '{"default":"all","work":"off"}', logger: log, liveMailboxes: async () => [migrated('work')] });
    expect(await own('work')).toBe('off');
    // Only the two-mailbox read of a leftover default warns (once per key).
    expect(warn).toHaveBeenCalledOnce();
  });

  it('with the mailbox list unreadable, a legacy default applies only where it is stricter', async () => {
    const failing = async () => { throw new Error('registry down'); };
    const off = createSendLevelReader({ get: async () => '{"default":"off"}', logger, liveMailboxes: failing });
    expect(await off('work')).toBe('off');
    // A permissive legacy level is not applied without knowing whose it is.
    const all = createSendLevelReader({ get: async () => '{"default":"all"}', logger, liveMailboxes: failing });
    expect(await all('work')).toBe('on_request');
    // An own key still wins.
    const own = createSendLevelReader({ get: async () => '{"default":"off","work":"routine"}', logger, liveMailboxes: failing });
    expect(await own('work')).toBe('routine');
  });

  it('a sole mailbox added after the migrated one was removed never inherits the legacy key (S-I1)', async () => {
    const read = createSendLevelReader({ get: async () => '{"default":"all"}', logger, liveMailboxes: async () => [added('home')] });
    expect(await read('home')).toBe('on_request');
    // The fallback (no registry row yet) is the install's one mailbox: the key applies.
    const fallback = createSendLevelReader({ get: async () => '{"default":"all"}', logger, liveMailboxes: async () => [migrated('mailbox')] });
    expect(await fallback('mailbox')).toBe('all');
  });

  it('warns once per process per key that sets no live mailbox, naming the key, never the level (SF5)', async () => {
    const warn = vi.fn();
    const log = { ...logger, warn } as unknown as typeof logger;
    const read = createSendLevelReader({ get: async () => '{"Default":"off","work":"all","gone":"routine"}', logger: log, liveMailboxes: async () => [added('work'), added('personal')] });
    expect(await read('work')).toBe('all');
    expect(await read('personal')).toBe('on_request');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map((c) => (c[0] as { key: string }).key).sort()).toEqual(['Default', 'gone']);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/routine|"off"/);
    // Only live ids among the keys: nothing to warn about.
    const ok = vi.fn();
    const quiet = createSendLevelReader({ get: async () => '{"work":"all"}', logger: { ...logger, warn: ok } as unknown as typeof logger, liveMailboxes: async () => [added('work'), added('personal')] });
    await quiet('personal');
    expect(ok).not.toHaveBeenCalled();
  });

  it('warns once about a leftover default with two live mailboxes', async () => {
    const warn = vi.fn();
    const log = { ...logger, warn } as unknown as typeof logger;
    const read = createSendLevelReader({ get: async () => '{"default":"routine","work":"all"}', logger: log, liveMailboxes: async () => [migrated('work'), added('personal')] });
    expect(await read('work')).toBe('all');
    expect(await read('personal')).toBe('on_request');
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]!.at(-1))).toMatch(/set a level per mailbox/);
  });

  describe('checkSendLevelWrite (SF5)', () => {
    const live = [{ ...added('work'), label: 'Work' }, { ...added('personal'), label: 'Personal' }];
    it('accepts an object keyed by live ids with valid levels', () => {
      expect(checkSendLevelWrite('{"work":"routine","personal":"off"}', live)).toEqual({ ok: true });
      expect(checkSendLevelWrite('{}', live)).toEqual({ ok: true });
    });
    it('refuses an unknown key, naming the live mailboxes', () => {
      const r = checkSendLevelWrite('{"wrk":"routine"}', live);
      expect(r).toEqual({ ok: false, error: expect.stringContaining('Not a connected mailbox: wrk') });
      if (!r.ok) expect(r.error).toContain('work (Work), personal (Personal)');
    });
    it('refuses default unless it applies to the migrated sole mailbox', () => {
      expect(checkSendLevelWrite('{"default":"routine"}', live).ok).toBe(false);
      expect(checkSendLevelWrite('{"default":"routine"}', [{ ...migrated('work'), label: 'Work' }]).ok).toBe(true);
    });
    it('names a legacy default apart, and says there is nothing to set with no mailbox (M2, M3)', () => {
      const r = checkSendLevelWrite('{"default":"routine","wrk":"off"}', live);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toMatch(/^"default" no longer applies; set a level per mailbox id\. Not a connected mailbox: wrk\./);
      }
      expect(checkSendLevelWrite('{"work":"routine"}', [])).toEqual({ ok: false, error: expect.stringMatching(/^No principal mailbox is connected yet/) });
    });
    it('refuses a bare level, non-JSON and a bad level', () => {
      expect(checkSendLevelWrite('"routine"', live).ok).toBe(false);
      expect(checkSendLevelWrite('routine', live).ok).toBe(false);
      expect(checkSendLevelWrite('{"work":"everything"}', live)).toEqual({ ok: false, error: expect.stringContaining('Not a level for work') });
    });
  });

  it('does not warn for an unset value, an empty object, or another mailbox when default is set', async () => {
    for (const [raw, mailbox] of [[null, 'default'], ['{}', 'default'], ['{"default":"off"}', 'work']] as const) {
      const warn = vi.fn();
      const log = { ...logger, warn } as unknown as typeof logger;
      expect(await createSendLevelReader({ get: async () => raw, logger: log })(mailbox)).toBe('on_request');
      expect(warn).not.toHaveBeenCalled();
    }
  });
  it('readSendLevelValue flags a malformed value', () => {
    expect(readSendLevelValue('{"default":"off"}')).toEqual({ level: 'off', malformed: false });
    expect(readSendLevelValue('{"default":"of"}')).toEqual({ level: 'on_request', malformed: true });
    expect(readSendLevelValue(null)).toEqual({ level: 'on_request', malformed: false });
  });
  it('returns on_request and warns when get throws', async () => {
    const warn = vi.fn();
    const log = { ...logger, warn } as unknown as typeof logger;
    const read = createSendLevelReader({ get: async () => { throw new Error('db down'); }, logger: log });
    expect(await read('default')).toBe('on_request');
    expect(warn).toHaveBeenCalled();
  });
});
