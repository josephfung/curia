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
  it('counts one visible action in a turn full of reads and plumbing', () => {
    const turn = [
      'contact-lookup',
      'entity-context',
      'ceo-inbox-search',
      'extract-facts',
      'web-search',
      'memory-store',
      'ceo-inbox-draft-reply',
    ];
    const minutes = turn.reduce((sum, name) => sum + minutesForCall(call(name, {}, {})), 0);
    expect(minutes).toBe(5);
    expect(minutes).toBe(minutesForCall(call('ceo-inbox-draft-reply', {}, {})));
  });

  it('weights an archive, a draft, a send, and a meeting apart', () => {
    expect(minutesForCall(call('email-archive', {}, {}))).toBe(0.5);
    expect(minutesForCall(call('ceo-inbox-archive', {}, {}))).toBe(0.5);
    expect(minutesForCall(call('ceo-inbox-draft-reply', {}, {}))).toBe(5);
    expect(minutesForCall(call('email-send', { to: 'c-1' }, {}))).toBe(5);
    expect(minutesForCall(call('email-reply', {}, {}))).toBe(5);
    expect(minutesForCall(call('calendar-create-event', {}, {}))).toBe(10);
    expect(minutesForCall(call('file-parse', {}, {}))).toBe(0);
    expect(minutesForCall(call('constructor', {}, {}))).toBe(0);
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
      "Rough estimate of your time behind the actions in Recent Activity. A meeting ≈10 min, a reply ≈5, filing ≈½. Reads don't count.",
    );
    expect(timeSavedDetail()).toContain('A new document ≈15 min, an edit ≈3');
    expect(timeSavedDetail()).toContain('including a repeat');
  });
});

describe('formatTally', () => {
  it('uses the singular phrase for one and a count otherwise', () => {
    const t = { verb: 'drafted', one: 'a reply', many: 'replies' };
    expect(formatTally(t, 1)).toBe('drafted a reply');
    expect(formatTally(t, 3)).toBe('drafted 3 replies');
  });
});
