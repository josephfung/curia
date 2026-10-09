import { describe, expect, it } from 'vitest';
import { extractSchedulingEmails } from '../../../src/agents/scheduling-email.js';

describe('extractSchedulingEmails (#2055)', () => {
  it('lifts a block into a draft and removes it from the text', () => {
    const text = [
      'Placed two holds.',
      '',
      '<scheduling_email subject="Meeting: Intro call">',
      'Hi Jamie,',
      '',
      'Would Tuesday at 10:30 work?',
      '</scheduling_email>',
      '',
      'Rules: loaded 0 active',
    ].join('\n');
    const { drafts, text: rest } = extractSchedulingEmails(text);
    expect(drafts).toEqual([{ subject: 'Meeting: Intro call', body: 'Hi Jamie,\n\nWould Tuesday at 10:30 work?' }]);
    expect(rest).toBe('Placed two holds.\n\n\n\nRules: loaded 0 active');
  });

  it('keeps every block in order', () => {
    const text = '<scheduling_email subject="A">one</scheduling_email> and <scheduling_email subject=\'B\'>two</scheduling_email>';
    expect(extractSchedulingEmails(text).drafts).toEqual([
      { subject: 'A', body: 'one' },
      { subject: 'B', body: 'two' },
    ]);
  });

  it('does not end the tag at a > inside the subject', () => {
    expect(extractSchedulingEmails('<scheduling_email subject="Q3 > Q4 planning">Hi</scheduling_email>').drafts)
      .toEqual([{ subject: 'Q3 > Q4 planning', body: 'Hi' }]);
  });

  it('accepts a block with no subject', () => {
    expect(extractSchedulingEmails('<scheduling_email>Hi</scheduling_email>').drafts).toEqual([{ body: 'Hi' }]);
  });

  it('leaves text without a block alone', () => {
    const text = '## Email sent to Jamie\n\nHi Jamie, would Tuesday work?';
    expect(extractSchedulingEmails(text)).toEqual({ drafts: [], text });
  });

  it('ignores an unclosed block', () => {
    const text = '<scheduling_email subject="A">Hi';
    expect(extractSchedulingEmails(text)).toEqual({ drafts: [], text });
  });
});
