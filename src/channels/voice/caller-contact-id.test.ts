import { describe, expect, it } from 'vitest';
import { persistableCallerContactId } from './caller-contact-id.js';

describe('persistableCallerContactId', () => {
  it('keeps a real contact UUID', () => {
    const id = '11111111-1111-1111-1111-111111111111';
    expect(persistableCallerContactId(id)).toBe(id);
  });

  it('leaves the synthetic primary-user id unset', () => {
    expect(persistableCallerContactId('primary-user')).toBeUndefined();
  });

  it('leaves a non-UUID caller id unset', () => {
    expect(persistableCallerContactId('+15551212')).toBeUndefined();
  });
});
