import { describe, it, expect, vi } from 'vitest';
import { declarerLabel, forceRemoveConfirmation, removeSecretFlow } from './secrets-utils.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('secrets-utils', () => {
  it('labels declarers by kind', () => {
    expect(declarerLabel({ kind: 'tool', name: 'web-search', required: false, enabled: true })).toBe('Tool web-search');
    expect(declarerLabel({ kind: 'principal-mailbox', name: 'Calendar and principal inbox', required: true, enabled: true })).toBe('Calendar and principal inbox');
    expect(declarerLabel({ kind: 'email-account', name: 'work', required: true, enabled: true })).toBe('Email account work');
  });

  it('marks a disabled declarer so it reads as not needed yet', () => {
    expect(declarerLabel({ kind: 'channel', name: 'slack', required: true, enabled: false })).toBe('Channel slack (disabled)');
  });

  it('puts the server message in the force-remove confirmation', () => {
    expect(forceRemoveConfirmation("'k' is required by enabled tool 'x'.")).toBe("'k' is required by enabled tool 'x'.\n\nRemove it anyway?");
  });

  describe('removeSecretFlow', () => {
    it('sends an unforced DELETE first and stops there when it succeeds', async () => {
      const del = vi.fn().mockResolvedValue(json(200, { ok: true, removed: true }));
      const confirm = vi.fn().mockReturnValue(true);
      expect(await removeSecretFlow('k', { confirm, del })).toBe('removed');
      expect(del.mock.calls).toEqual([[false]]);
      expect(confirm).toHaveBeenCalledTimes(1);
    });

    it('after a 409, shows the server message and forces only on a second yes', async () => {
      const del = vi.fn()
        .mockResolvedValueOnce(json(409, { error: "'k' is required by enabled tool 'x'." }))
        .mockResolvedValueOnce(json(200, { ok: true, removed: true }));
      const confirm = vi.fn().mockReturnValue(true);
      expect(await removeSecretFlow('k', { confirm, del })).toBe('removed');
      expect(del.mock.calls).toEqual([[false], [true]]);
      expect(confirm).toHaveBeenLastCalledWith(forceRemoveConfirmation("'k' is required by enabled tool 'x'."));
    });

    it('sends no forced request when the second confirmation is declined', async () => {
      const del = vi.fn().mockResolvedValue(json(409, { error: 'needed' }));
      const confirm = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
      expect(await removeSecretFlow('k', { confirm, del })).toBe('cancelled');
      expect(del.mock.calls).toEqual([[false]]);
    });

    it('sends nothing when the first confirmation is declined', async () => {
      const del = vi.fn();
      expect(await removeSecretFlow('k', { confirm: () => false, del })).toBe('cancelled');
      expect(del).not.toHaveBeenCalled();
    });

    it('throws the server error on any other failure', async () => {
      const del = vi.fn().mockResolvedValue(json(500, { error: 'Failed to remove secret.' }));
      await expect(removeSecretFlow('k', { confirm: () => true, del })).rejects.toThrow('Failed to remove secret.');
    });
  });
});
