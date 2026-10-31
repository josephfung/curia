import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describeToolCall,
  describerRefs,
  formatTally,
  hasDescriber,
  hiddenToolNames,
  isVisibleTool,
  minutesForCall,
  UNDESCRIBED_CALL_MINUTES,
  timeSavedDetail,
  timeSavedHelp,
  visibleToolNames,
  researchKind,
  type DescribeContext,
  type ToolCall,
} from '../../../src/activity/describers.js';
import { discoverToolManifests } from '../../../src/skills/loader.js';
import { AutonomyService } from '../../../src/autonomy/autonomy-service.js';

const SKILLS_DIR = path.resolve(import.meta.dirname, '../../../skills');

function ctx(names: Record<string, string> = {}, timezone = 'America/Toronto'): DescribeContext {
  return { name: (ref) => names[ref] ?? null, timezone };
}

function call(toolName: string, input: Record<string, unknown>, data: Record<string, unknown> | null, ok = true): ToolCall {
  return { toolName, input, data, ok };
}

/** Same keys the minutes query drops: message bodies, and a document's body. */
function stripHeavy(record: Record<string, unknown>, isInput: boolean): Record<string, unknown> {
  const keys = isInput
    ? ['body', 'content', 'message', 'prompt', 'html', 'text']
    : ['body', 'content', 'message', 'html', 'text'];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (keys.includes(key)) continue;
    if (key === 'document' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const doc: Record<string, unknown> = { ...(value as Record<string, unknown>) };
      delete doc.body;
      out[key] = doc;
    } else {
      out[key] = value;
    }
  }
  return out;
}

describe('describer coverage', () => {
  it('every tool at action_risk medium or above has a describer', () => {
    const threshold = AutonomyService.minScoreForActionRisk('medium');
    const missing: string[] = [];
    for (const disc of discoverToolManifests(SKILLS_DIR)) {
      if (disc.error || !disc.manifest) continue;
      if (AutonomyService.minScoreForActionRisk(disc.manifest.action_risk) < threshold) continue;
      if (!hasDescriber(disc.manifest.name)) missing.push(disc.manifest.name);
    }
    // Add an entry to src/activity/describers.ts for each tool listed here.
    expect(missing).toEqual([]);
  });
});

describe('hiddenToolNames', () => {
  it('lists plumbing the feed skips and leaves visible tools out', () => {
    const hidden = hiddenToolNames();
    expect(hidden).toContain('extract-facts');
    expect(hidden).toContain('web-search');
    expect(hidden).toContain('delegate');
    expect(hidden).not.toContain('email-archive');
    expect(hidden).not.toContain('email-send');
  });
});

describe('visibleToolNames', () => {
  it('is the set the feed classifies, so undescribed tools stay out', () => {
    const visible = visibleToolNames();
    expect(visible).toContain('email-archive');
    expect(visible).toContain('email-send');
    expect(visible).not.toContain('extract-facts');
    expect(visible).not.toContain('web-search');
    expect(visible).not.toContain('contact-lookup');
    expect(isVisibleTool('contact-lookup')).toBe(false);
    expect(isVisibleTool('email-archive')).toBe(true);
  });
});

describe('describeToolCall', () => {
  it('names a draft reply recipient by contact, falling back to the address', () => {
    const draft = call('ceo-inbox-draft-reply', { reply_to_message_id: 'm1', body: 'secret body' }, {
      to: [{ name: 'Johnny (header)', email: 'John@Example.com' }],
    });
    expect(describerRefs(draft)).toEqual(['email:john@example.com']);
    expect(describeToolCall(draft, ctx({ 'email:john@example.com': 'John Doe' }))?.text).toBe('drafted a reply to John Doe');
    expect(describeToolCall(draft, ctx())?.text).toBe('drafted a reply to john@example.com');
  });

  it('writes a calendar event date in the principal timezone', () => {
    // 02:30 UTC on Nov 1 is still Oct 31 in Toronto.
    const create = call('calendar-create-event', { title: 'Board Meeting', start: '2026-11-01T02:30:00Z' }, {
      event: { title: 'Board Meeting', startTime: '2026-10-31T22:30:00-04:00' },
    });
    expect(describeToolCall(create, ctx())?.text).toBe('scheduled “Board Meeting” on Oct 31');
    expect(describeToolCall(create, ctx({}, 'Asia/Tokyo'))?.text).toBe('scheduled “Board Meeting” on Nov 1');
  });

  it('keeps an all-day date on its calendar day in any timezone', () => {
    const allDay = call('calendar-create-event', { title: 'Offsite', start: '2026-10-31' }, null);
    expect(describeToolCall(allDay, ctx())?.text).toBe('scheduled “Offsite” on Oct 31');
    expect(describeToolCall(allDay, ctx({}, 'Pacific/Honolulu'))?.text).toBe('scheduled “Offsite” on Oct 31');
    expect(describeToolCall(allDay, ctx({}, 'Pacific/Kiritimati'))?.text).toBe('scheduled “Offsite” on Oct 31');
  });

  it('treats Object.prototype names as unregistered tools', () => {
    for (const name of ['constructor', 'toString', '__proto__']) {
      expect(hasDescriber(name)).toBe(false);
      expect(isVisibleTool(name)).toBe(false);
      expect(researchKind(name)).toBeUndefined();
      expect(describerRefs(call(name, {}, null))).toEqual([]);
      expect(describeToolCall(call(name, {}, null), ctx())).toBeNull();
    }
  });

  it('describes a failure as a "couldn\'t" line', () => {
    const send = call('email-send', { to: 'c-1', body: 'x' }, null, false);
    expect(describeToolCall(send, ctx({ 'c-1': 'Jane Roe' }))?.text).toBe("couldn't email Jane Roe");
  });

  it('resolves the principal alias and strips #label hints', () => {
    const send = call('signal-send', { recipient: 'principal#personal', message: 'hi' }, { delivered_to: '+1555' });
    expect(describerRefs(send)).toEqual(['principal']);
    expect(describeToolCall(send, ctx({ principal: 'Joseph' }))?.text).toBe('messaged Joseph on Signal');
  });

  it('never reveals a contact id when the name does not resolve', () => {
    const send = call('email-send', { to: '7f1c0c1e-0000-4000-8000-000000000001' }, { to: '' });
    expect(describeToolCall(send, ctx())?.text).toBe('emailed a contact');
  });

  it('hides plumbing and marks web tools as research', () => {
    expect(describeToolCall(call('config-store', {}, {}), ctx())?.prominence).toBe('hidden');
    expect(describeToolCall(call('web-search', { query: 'x' }, {}), ctx())).toMatchObject({ prominence: 'hidden', research: 'search' });
    expect(describeToolCall(call('ceo-inbox-search', {}, {}), ctx())).toBeNull();
  });

  it('hides a dry-run merge and a hold that was not placed', () => {
    expect(describeToolCall(call('contact-merge', { primary_contact_id: 'a', secondary_contact_id: 'b', dry_run: true }, {}), ctx())?.prominence).toBe('hidden');
    expect(describeToolCall(call('calendar-create-hold', { start: '2026-10-31T10:00:00Z' }, { held: false }), ctx())?.prominence).toBe('hidden');
  });
});

describe('minutesForCall', () => {
  it('adds the default for an unlisted tool and zero for hidden plumbing', () => {
    const unlisted = ['contact-lookup', 'entity-context', 'ceo-inbox-search'];
    const hidden = ['extract-facts', 'web-search', 'memory-store'];
    const minutes = [...unlisted, ...hidden, 'ceo-inbox-draft-reply']
      .reduce((sum, name) => sum + minutesForCall(call(name, {}, {})), 0);
    expect(minutes).toBeCloseTo(5 + unlisted.length * UNDESCRIBED_CALL_MINUTES);
    for (const name of hidden) expect(minutesForCall(call(name, {}, {})), name).toBe(0);
    expect(minutesForCall(call('contact-lookup', {}, {}, false))).toBe(0);
    expect(minutesForCall(call('   ', {}, {}))).toBe(0);
  });

  it('weights an archive, a draft, a send, and a meeting apart', () => {
    expect(minutesForCall(call('email-archive', {}, {}))).toBe(0.5);
    expect(minutesForCall(call('ceo-inbox-archive', {}, {}))).toBe(0.5);
    expect(minutesForCall(call('ceo-inbox-draft-reply', {}, {}))).toBe(5);
    expect(minutesForCall(call('email-send', { to: 'c-1' }, {}))).toBe(5);
    expect(minutesForCall(call('email-reply', {}, {}))).toBe(5);
    expect(minutesForCall(call('calendar-create-event', {}, {}))).toBe(10);
    expect(minutesForCall(call('file-parse', {}, {}))).toBe(0);
    expect(minutesForCall(call('constructor', {}, {}))).toBe(UNDESCRIBED_CALL_MINUTES);
    expect(minutesForCall(call('calendar-create-event', {}, {}, false))).toBe(0);
  });

  it('adds nothing the feed would hide', () => {
    expect(minutesForCall(call('contact-merge', { dry_run: true, primary_contact_id: 'a' }, {}))).toBe(0);
    expect(minutesForCall(call('contact-merge', { primary_contact_id: 'a' }, {}))).toBe(5);
    expect(minutesForCall(call('calendar-create-hold', { start: '2026-10-31T10:00:00Z' }, { held: false }))).toBe(0);
    expect(minutesForCall(call('calendar-create-hold', { start: '2026-10-31T10:00:00Z' }, { held: true }))).toBe(3);
    expect(minutesForCall(call('voice-learn', {}, { proposed: false }))).toBe(0);
    expect(minutesForCall(call('voice-learn', {}, { proposed: true }))).toBe(2);
    for (const name of hiddenToolNames()) {
      expect(minutesForCall(call(name, {}, {})), name).toBe(0);
    }
  });

  it('weights a new document above an edit and ignores scratch notes', () => {
    const project = '/projects/q/brief.md';
    const scratch = '/scratch/conv-1/plan.md';
    const created = call('doc-write', { path: project }, { action: 'created', document: { path: project } });
    const edited = call('doc-write', { path: project }, { action: 'appended', document: { path: project } });
    const note = call('doc-write', { path: scratch }, { action: 'appended', document: { path: scratch } });
    expect(minutesForCall(created)).toBe(15);
    expect(minutesForCall(edited)).toBe(3);
    expect(minutesForCall(note)).toBe(0);
    expect(minutesForCall(note) + minutesForCall(note) + minutesForCall(note)).toBe(0);
    expect(describeToolCall(note, ctx())?.prominence).toBe('hidden');
    expect(describeToolCall(created, ctx())?.text).toContain('wrote');
    expect(describeToolCall(edited, ctx())?.text).toContain('updated');
    const conflict = call('doc-write', { path: project }, { conflict: true, path: project, version: 4 });
    expect(describeToolCall(conflict, ctx())?.prominence).toBe('hidden');
    expect(minutesForCall(conflict)).toBe(0);
  });

  it('keeps every describer line when message and document bodies are removed', () => {
    const heavyInput = {
      to: 'c-1',
      recipient: 'c-1',
      contact_id: 'c-1',
      primary_contact_id: 'c-1',
      path: '/projects/q/brief.md',
      title: 'Board',
      subject: 'Hi',
      start: '2026-10-31T15:00:00Z',
      action: 'approve_voice',
      filename: 'brief.pdf',
      label: 'Work',
      display_name: 'Ada',
      role: 'advisor',
      tier: 'inner',
      permission: 'calendar',
      response: 'accept',
      score: 70,
      body: 'SECRET BODY',
      content: 'SECRET CONTENT',
      message: 'SECRET MESSAGE',
      prompt: 'SECRET PROMPT',
      html: '<p>SECRET</p>',
      text: 'SECRET TEXT',
    };
    const heavyData = {
      subject: 'Hi',
      to: [{ email: 'a@b.co' }],
      action: 'created',
      held: true,
      proposed: true,
      title: 'Board',
      response: 'accept',
      document: { path: '/projects/q/brief.md', frontmatter: { title: 'Board brief' }, body: 'SECRET DOC' },
      body: 'SECRET BODY',
      content: 'SECRET CONTENT',
      message: 'SECRET MESSAGE',
      html: '<p>SECRET</p>',
      text: 'SECRET TEXT',
    };
    const leanInput = stripHeavy(heavyInput, true);
    const leanData = stripHeavy(heavyData, false);
    for (const name of visibleToolNames()) {
      const full = call(name, heavyInput, heavyData);
      const lean = call(name, leanInput, leanData);
      expect(describeToolCall(full, ctx()), name).toEqual(describeToolCall(lean, ctx()));
      expect(minutesForCall(full), name).toBe(minutesForCall(lean));
    }
  });

  it('shares an estimate across the same action on two tools', () => {
    const pairs = [
      ['ceo-inbox-archive', 'email-archive'],
      ['ceo-inbox-label', 'email-label'],
      ['ceo-inbox-mark-read', 'email-mark-read'],
      ['ceo-inbox-draft-compose', 'email-draft-save'],
    ] as const;
    for (const [left, right] of pairs) {
      expect(minutesForCall(call(left, {}, {})), `${left} vs ${right}`).toBe(minutesForCall(call(right, {}, {})));
    }
  });

  it('states the tile definition from the same weights', () => {
    expect(timeSavedHelp()).toBe(
      "Rough estimate of your time. A meeting ≈10 min, a reply ≈5, filing ≈½. A listed read doesn't count. Anything not listed ≈0.052 min.",
    );
    expect(timeSavedDetail()).toBe(
      'A new document ≈15 min, an edit ≈3. Scratch notes don\'t count. Each action counts, including a repeat.',
    );
    expect(timeSavedDetail().includes('Rough estimate')).toBe(false);
  });
});

describe('formatTally', () => {
  it('uses the singular phrase for one and a count otherwise', () => {
    const t = { verb: 'drafted', one: 'a reply', many: 'replies' };
    expect(formatTally(t, 1)).toBe('drafted a reply');
    expect(formatTally(t, 3)).toBe('drafted 3 replies');
  });
});
