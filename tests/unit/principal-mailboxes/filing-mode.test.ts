import { describe, it, expect } from 'vitest';
import { readFilingMode, checkFilingWrite } from '../../../src/principal-mailboxes/filing-mode.js';

describe('readFilingMode', () => {
  it('null → archive, not malformed', () => expect(readFilingMode(null, 'work')).toEqual({ mode: 'archive', malformed: false }));
  it('reads the mailbox own entry', () => expect(readFilingMode('{"work":"leave_in_inbox"}', 'work')).toEqual({ mode: 'leave_in_inbox', malformed: false }));
  it('another mailbox entry never applies', () => expect(readFilingMode('{"work":"leave_in_inbox"}', 'home')).toEqual({ mode: 'archive', malformed: false }));
  it.each(['not json', '[]', '"leave_in_inbox"', '{"work":"keep"}', '{"work":true}'])('%s → archive, malformed', (raw) =>
    expect(readFilingMode(raw, 'work')).toEqual({ mode: 'archive', malformed: true }));
});

describe('checkFilingWrite', () => {
  const live = [{ id: 'work', label: 'Work' }, { id: 'home', label: 'Personal' }];
  it('accepts live ids with valid modes', () => expect(checkFilingWrite('{"work":"leave_in_inbox","home":"archive"}', live)).toEqual({ ok: true }));
  it('refuses with no mailboxes', () => expect(checkFilingWrite('{}', [])).toMatchObject({ ok: false }));
  it('refuses non-JSON and non-objects', () => { expect(checkFilingWrite('x', live).ok).toBe(false); expect(checkFilingWrite('[]', live).ok).toBe(false); });
  it('refuses an unknown mailbox, naming it and the live ones', () => {
    const r = checkFilingWrite('{"wrk":"archive"}', live);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toContain('wrk'); expect(r.error).toContain('work (Work)'); expect(r.error).toContain('Nothing was stored'); }
  });
  it('refuses an unknown mode, naming the mailbox', () => {
    const r = checkFilingWrite('{"work":"keep"}', live);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('work');
  });
});
