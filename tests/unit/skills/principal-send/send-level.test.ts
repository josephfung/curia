import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { parseSendLevel, createSendLevelReader } from '../../../../src/skills/principal-send/send-level.js';

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
  it('returns on_request and warns when get throws', async () => {
    const warn = vi.fn();
    const log = { ...logger, warn } as unknown as typeof logger;
    const read = createSendLevelReader({ get: async () => { throw new Error('db down'); }, logger: log });
    expect(await read('default')).toBe('on_request');
    expect(warn).toHaveBeenCalled();
  });
});
