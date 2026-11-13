import { describe, it, expect } from 'vitest';
import { applyRemoval, parseRuleScopes } from '../../../src/principal-mailboxes/rules-scope.js';

const DOC = [
  '## Newsletters',
  '- When: a newsletter arrives',
  '- Do: mark it Seen',
  '- Status: active',
  '',
  '## Work invoices',
  '- When: an invoice arrives',
  '- Do: file it',
  '- Mailbox: work',
  '- Status: active',
  '',
  '## Travel',
  '- When: a booking arrives',
  '- Do: note it',
  '- Mailbox: work, personal',
  '- Status: paused',
  '',
].join('\n');

describe('parseRuleScopes', () => {
  it('rules without a Mailbox line apply everywhere', () => {
    const scopes = parseRuleScopes(DOC);
    expect(scopes.map((s) => [s.title, s.mailboxes])).toEqual([
      ['Newsletters', null],
      ['Work invoices', ['work']],
      ['Travel', ['work', 'personal']],
    ]);
    expect(DOC.slice(scopes[1]!.start, scopes[1]!.end).startsWith('## Work invoices')).toBe(true);
    expect(scopes[2]!.end).toBe(DOC.length);
  });
});

describe('applyRemoval', () => {
  it('rules scoped to a removed id are deleted', () => {
    const out = applyRemoval(DOC, 'work', 'delete');
    expect(out).not.toContain('Work invoices');
    expect(out).toContain('## Newsletters');
    expect(out).toContain('- Mailbox: personal');
  });

  it('rules scoped to a removed id are rescoped', () => {
    const out = applyRemoval(DOC, 'work', { rescopeTo: 'personal' });
    expect(out).toContain('## Work invoices\n- When: an invoice arrives\n- Do: file it\n- Mailbox: personal\n');
    expect(parseRuleScopes(out).find((s) => s.title === 'Travel')!.mailboxes).toEqual(['personal']);
  });

  it('a multi-mailbox rule keeps the others', () => {
    const out = applyRemoval(DOC, 'personal', 'delete');
    expect(out).toContain('- Mailbox: work\n- Status: paused');
    expect(out).toContain('## Work invoices');
  });

  it('leaves the document byte-identical when nothing is scoped to the id', () => {
    expect(applyRemoval(DOC, 'other', 'delete')).toBe(DOC);
    expect(applyRemoval(DOC, 'other', { rescopeTo: 'work' })).toBe(DOC);
  });

  it('keeps CRLF line endings on a rewritten line', () => {
    const crlf = DOC.replace(/\n/g, '\r\n');
    expect(applyRemoval(crlf, 'personal', 'delete')).toContain('- Mailbox: work\r\n- Status: paused');
  });
});

describe('rules parser edge cases (SEC-L8)', () => {
  const doc = [
    '## Board mail',
    '- When: from the board',
    '- Do: label it, for example:',
    '  - Mailbox: personal',
    '```',
    '## Not a rule',
    '- Mailbox: work',
    '```',
    '- Mailbox: work',
    '',
    '## Newsletters',
    '- Do: archive',
    '',
  ].join('\n');

  it('skips headings and Mailbox lines inside fenced code, and nested Mailbox bullets', () => {
    const rules = parseRuleScopes(doc);
    expect(rules.map((r) => r.title)).toEqual(['Board mail', 'Newsletters']);
    expect(rules[0]!.mailboxes).toEqual(['work']);
  });

  it('rewrites only the top-level line outside the fence', () => {
    const out = applyRemoval(doc, 'work', { rescopeTo: 'home' });
    expect(out).toContain('```\n## Not a rule\n- Mailbox: work\n```\n- Mailbox: home\n');
    expect(out).toContain('  - Mailbox: personal');
  });

  it('a shorter run or a run with text after it does not close a fence (CommonMark)', () => {
    const fenced = (open: string, inner: string, close: string) => [
      '## Real one', '- Mailbox: work', '', open, '## Example', '- Mailbox: work', inner, '## Still example', close,
      '## Real two', '- Mailbox: work', '',
    ].join('\n');
    // Four-backtick block holding a three-backtick line: the real close is the four-backtick one.
    const four = parseRuleScopes(fenced('````', '```', '````'));
    expect(four.map((r) => r.title)).toEqual(['Real one', 'Real two']);
    // A closing run followed by text is content, not a close.
    const trailing = parseRuleScopes(fenced('```', '``` not a close', '```'));
    expect(trailing.map((r) => r.title)).toEqual(['Real one', 'Real two']);
    // Tildes never close a backtick fence.
    expect(parseRuleScopes(fenced('```', '~~~', '```')).map((r) => r.title)).toEqual(['Real one', 'Real two']);
    // A rescope rewrites both real rules and leaves the example inside the block as written.
    const out = applyRemoval(fenced('````', '```', '````'), 'work', { rescopeTo: 'home' });
    expect(out).toContain('````\n## Example\n- Mailbox: work\n```\n## Still example\n````');
    expect(out).toContain('## Real two\n- Mailbox: home');
  });
});
