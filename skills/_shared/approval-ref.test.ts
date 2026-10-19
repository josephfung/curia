import { describe, it, expect } from 'vitest';
import { parseApprovalRefInput } from './approval-ref.js';

const NO_RETRY = 'Do not retry without a reference; ask the principal which approval they meant.';

describe('parseApprovalRefInput', () => {
  it.each([
    [undefined, undefined],
    [null, undefined],
  ])('treats %s as absent (sole-pending fallback allowed)', (raw, ref) => {
    expect(parseApprovalRefInput({ short_ref: raw })).toEqual({ ok: true, ref });
  });

  it('treats an input with no short_ref key as absent', () => {
    expect(parseApprovalRefInput({})).toEqual({ ok: true, ref: undefined });
  });

  it.each([
    [3, '3'],
    [0, '0'],
    [999, '999'],
    ['3', '3'],
    [' 3 ', '3'],
    ['a3f7c12b', 'a3f7c12b'],
  ])('reads %j as %j', (raw, ref) => {
    expect(parseApprovalRefInput({ short_ref: raw })).toEqual({ ok: true, ref });
  });

  // A model relays what the notification showed ("Approval 3") or how the principal wrote it
  // ("#3"). Only the whole string is read this way, so a description cannot smuggle a number.
  it.each([
    ['#3', '3'],
    ['Approval 3', '3'],
    ['approval 3', '3'],
    ['  Approval 12 ', '12'],
  ])('normalises %j to %j', (raw, ref) => {
    expect(parseApprovalRefInput({ short_ref: raw })).toEqual({ ok: true, ref });
  });

  it.each([
    'Approval 3 and 4', 'approve 3', 'approval three', 'the #3 one',
  ])('does not pull a number out of %j', (raw) => {
    // Passed through as a reference; the repo then finds no such reference and refuses.
    expect(parseApprovalRefInput({ short_ref: raw })).toEqual({ ok: true, ref: raw });
  });

  it.each([
    '', '   ', {}, [], true, false, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
  ])('fails closed on %j instead of falling back', (raw) => {
    const parsed = parseApprovalRefInput({ short_ref: raw });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/short_ref/);
      expect(parsed.error).toContain(NO_RETRY);
      expect(parsed.error).not.toContain('Omit short_ref');
    }
  });

  // A ref under the wrong key would read as "no reference" and fall back to the sole pending
  // approval, approving something the principal never named. Fail closed instead.
  it.each([
    'number', 'shortRef', 'ref', 'reference', 'approval', 'approval_number', 'id',
  ])('fails closed when the reference is under %j, alone or beside short_ref', (key) => {
    for (const input of [{ [key]: 3 }, { [key]: '3', short_ref: '3' }]) {
      const parsed = parseApprovalRefInput(input);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error).toContain(key);
        expect(parsed.error).toContain('short_ref');
        expect(parsed.error).toContain(NO_RETRY);
      }
    }
  });

  it('ignores a mis-named key that carries no value', () => {
    expect(parseApprovalRefInput({ id: null, short_ref: '3' })).toEqual({ ok: true, ref: '3' });
    expect(parseApprovalRefInput({ ref: undefined })).toEqual({ ok: true, ref: undefined });
  });
});
