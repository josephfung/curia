import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { parseSendLevel, readSendLevelValue, createSendLevelReader } from '../../../../src/skills/principal-send/send-level.js';

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
  it('a legacy default key applies only while exactly one mailbox is live (R41)', async () => {
    const warn = vi.fn();
    const log = { ...logger, warn } as unknown as typeof logger;
    const raw = '{"default":"routine"}';
    const one = createSendLevelReader({ get: async () => raw, logger: log, liveMailboxIds: async () => ['work'] });
    expect(await one('work')).toBe('routine');
    // A second mailbox was added (and perhaps made the default): nobody inherits the level.
    const two = createSendLevelReader({ get: async () => raw, logger: log, liveMailboxIds: async () => ['work', 'personal'] });
    expect(await two('work')).toBe('on_request');
    expect(await two('personal')).toBe('on_request');
    // An own key wins over a leftover default.
    const own = createSendLevelReader({ get: async () => '{"default":"all","work":"off"}', logger: log, liveMailboxIds: async () => ['work'] });
    expect(await own('work')).toBe('off');
    // Only the two-mailbox read of a leftover default warns (once per value).
    expect(warn).toHaveBeenCalledOnce();
  });
  it('warns once per value when two mailboxes are live and a leftover default key is ignored', async () => {
    const warn = vi.fn();
    const log = { ...logger, warn } as unknown as typeof logger;
    const read = createSendLevelReader({ get: async () => '{"default":"routine"}', logger: log, liveMailboxIds: async () => ['work', 'personal'] });
    expect(await read('work')).toBe('on_request');
    expect(await read('personal')).toBe('on_request');
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]!.at(-1))).toMatch(/set a level per mailbox/);
    // One live mailbox: the key applies, nothing to warn about.
    const w2 = vi.fn();
    const one = createSendLevelReader({ get: async () => '{"default":"routine"}', logger: { ...logger, warn: w2 } as unknown as typeof logger, liveMailboxIds: async () => ['work'] });
    expect(await one('work')).toBe('routine');
    expect(w2).not.toHaveBeenCalled();
  });
  it('warns once per process per value when no key is a live id or default', async () => {
    const warn = vi.fn();
    const log = { ...logger, warn } as unknown as typeof logger;
    const read = createSendLevelReader({ get: async () => '{"Default":"off"}', logger: log, liveMailboxIds: async () => ['work', 'personal'] });
    expect(await read('work')).toBe('on_request');
    expect(await read('personal')).toBe('on_request');
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Default');
    // A live id or default among the keys: nothing to warn about.
    const ok = vi.fn();
    const quiet = createSendLevelReader({ get: async () => '{"work":"all"}', logger: { ...logger, warn: ok } as unknown as typeof logger, liveMailboxIds: async () => ['work', 'personal'] });
    await quiet('personal');
    expect(ok).not.toHaveBeenCalled();
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
