import { describe, it, expect } from 'vitest';
import { serializeWorkingHours, validateWorkingHours } from './working-hours.js';

describe('serializeWorkingHours', () => {
  it('formats weekdays as a Mon–Fri range', () => {
    expect(serializeWorkingHours({ start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] }))
      .toBe('Mon–Fri, 9:00 AM–5:00 PM');
  });
  it('formats all seven days as Sun–Sat', () => {
    expect(serializeWorkingHours({ start: '08:30', end: '16:00', days: [0, 1, 2, 3, 4, 5, 6] }))
      .toBe('Sun–Sat, 8:30 AM–4:00 PM');
  });
  it('lists non-contiguous days individually', () => {
    expect(serializeWorkingHours({ start: '10:00', end: '14:00', days: [1, 3, 5] }))
      .toBe('Mon, Wed, Fri, 10:00 AM–2:00 PM');
  });
  it('formats a single day', () => {
    expect(serializeWorkingHours({ start: '00:00', end: '12:00', days: [2] }))
      .toBe('Tue, 12:00 AM–12:00 PM');
  });
});

describe('validateWorkingHours', () => {
  it('accepts a well-formed object and sorts/dedupes days', () => {
    expect(validateWorkingHours({ start: '09:00', end: '17:00', days: [5, 1, 1, 3] }))
      .toEqual({ start: '09:00', end: '17:00', days: [1, 3, 5] });
  });
  it('rejects a bad time', () => {
    expect(validateWorkingHours({ start: '9am', end: '17:00', days: [1] })).toBeNull();
  });
  it('rejects an out-of-range day', () => {
    expect(validateWorkingHours({ start: '09:00', end: '17:00', days: [7] })).toBeNull();
  });
  it('rejects an empty day list', () => {
    expect(validateWorkingHours({ start: '09:00', end: '17:00', days: [] })).toBeNull();
  });
  it('rejects non-objects', () => {
    expect(validateWorkingHours(null)).toBeNull();
    expect(validateWorkingHours('mon-fri')).toBeNull();
  });
});
