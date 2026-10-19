import { describe, it, expect } from 'vitest';
import { parseApprovalRefInput } from './approval-ref.js';

describe('parseApprovalRefInput', () => {
  it.each([
    [undefined, undefined],
    [null, undefined],
  ])('treats %s as absent (sole-pending fallback allowed)', (raw, ref) => {
    expect(parseApprovalRefInput(raw)).toEqual({ ok: true, ref });
  });

  it.each([
    [3, '3'],
    [0, '0'],
    [999, '999'],
    ['3', '3'],
    [' 3 ', '3'],
    ['a3f7c12b', 'a3f7c12b'],
  ])('reads %j as %j', (raw, ref) => {
    expect(parseApprovalRefInput(raw)).toEqual({ ok: true, ref });
  });

  it.each([
    '', '   ', {}, [], true, false, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
  ])('fails closed on %j instead of falling back', (raw) => {
    const parsed = parseApprovalRefInput(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/short_ref/);
  });
});
