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
  it('warns when the stored object has keys but no default entry, and still uses on_request', async () => {
    for (const raw of ['{"Default":"off"}', '{"work":"all"}']) {
      const warn = vi.fn();
      const log = { ...logger, warn } as unknown as typeof logger;
      expect(await createSendLevelReader({ get: async () => raw, logger: log })('default'), raw).toBe('on_request');
      expect(warn, raw).toHaveBeenCalledOnce();
      expect(JSON.stringify(warn.mock.calls), raw).not.toContain('off');
      expect(JSON.stringify(warn.mock.calls), raw).not.toContain('Default');
    }
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
