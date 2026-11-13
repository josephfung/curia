// Every live mailbox gets a registered home calendar (#2475, R103): the boot/runtime catch-up.
import { describe, it, expect, vi } from 'vitest';
import { registerMissingHomeCalendars } from '../../../src/principal-mailboxes/register-home-calendars.js';

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('registerMissingHomeCalendars', () => {
  it('registers only mailboxes without a home, and counts', async () => {
    const registerHome = vi.fn(async () => 'registered' as const);
    const r = await registerMissingHomeCalendars({
      liveMailboxes: async () => [{ id: 'work', label: 'Work' }, { id: 'personal', label: 'Personal' }],
      hasHome: async (id) => id === 'work',
      registerHome,
      logger: logger(),
    });
    expect(r).toEqual({ registered: 1, failed: 0 });
    expect(registerHome).toHaveBeenCalledWith('personal', 'Personal');
  });

  it('one failing mailbox is logged at error with its id and does not stop the others', async () => {
    const log = logger();
    const registerHome = vi.fn(async (id: string) => {
      if (id === 'a') throw new Error('db down');
      if (id === 'b') return 'no_primary_calendar' as const;
      return 'moved' as const;
    });
    const r = await registerMissingHomeCalendars({
      liveMailboxes: async () => [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
      hasHome: async () => false,
      registerHome,
      logger: log,
    });
    expect(r).toEqual({ registered: 1, failed: 2 });
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ mailboxId: 'a', errMessage: 'db down' }), expect.any(String));
    expect(log.error).toHaveBeenCalledWith({ mailboxId: 'b' }, expect.any(String));
  });

  it('a mailbox list that cannot be read is an error, never a throw', async () => {
    const log = logger();
    const r = await registerMissingHomeCalendars({
      liveMailboxes: async () => { throw new Error('registry down'); },
      hasHome: async () => false,
      registerHome: vi.fn(),
      logger: log,
    });
    expect(r).toEqual({ registered: 0, failed: 1 });
    expect(log.error).toHaveBeenCalled();
  });
});
