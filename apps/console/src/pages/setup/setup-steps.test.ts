import { describe, it, expect } from 'vitest';
import {
  atSentenceStart,
  createLatestSaver,
  sharedLatestSaver,
  EXTRAS,
  firstName,
  firstOpenStep,
  groupLabel,
  isExtra,
  isStepId,
  nextStep,
  principalLabel,
  setupRedirect,
  stepMark,
  stepsLeft,
  STEPS,
  type Checklist,
  type ChecklistTask,
} from './setup-steps.js';

function task(id: string, status: 'done' | 'pending', extra: Partial<ChecklistTask> = {}): ChecklistTask {
  return { id, label: id, optional: false, status, credential_how_to: null, docs_url: null, ...extra };
}

function checklist(tasks: ChecklistTask[]): Checklist {
  const missing = tasks.filter((t) => !t.optional && t.status !== 'done').map((t) => t.id);
  return { setupFor: 'other', tasks, setupComplete: missing.length === 0, missing };
}

const ALL_DONE = checklist(['who', 'curia_name', 'email', 'messaging', 'voice', 'mailbox_signin'].map((id) => task(id, 'done')));

describe('the steps', () => {
  it('run in the Setup page order, Finish last', () => {
    expect(STEPS.map((s) => s.id)).toEqual(['who', 'curia_name', 'email', 'messaging', 'voice', 'mailbox_signin', 'apply', 'start']);
  });

  it('accept only known step ids from the URL', () => {
    expect(isStepId('voice')).toBe(true);
    expect(isStepId('nope')).toBe(false);
    expect(isStepId(3)).toBe(false);
  });

  it('walk forward and stop after the last', () => {
    expect(nextStep('who')).toBe('curia_name');
    expect(nextStep('apply')).toBe('start');
    expect(nextStep('start')).toBeNull();
  });
});

describe('the optional extras', () => {
  it('follow the steps, in the catalog’s ids, and come from the URL too', () => {
    expect(EXTRAS.map((s) => s.id)).toEqual(['working_style', 'google_workspace', 'web_research', 'capabilities']);
    expect(isStepId('google_workspace')).toBe(true);
    expect(isExtra('web_research')).toBe(true);
    expect(isExtra('voice')).toBe(false);
    expect(groupLabel('extras', 'Dana')).toBe('Optional extras');
  });

  it('walk forward, and the last returns to Start onboarding', () => {
    expect(nextStep('working_style')).toBe('google_workspace');
    expect(nextStep('google_workspace')).toBe('web_research');
    expect(nextStep('web_research')).toBe('capabilities');
    expect(nextStep('capabilities')).toBe('start');
  });

  it('are never counted as left to do, nor where a returning operator lands', () => {
    const c = checklist([...ALL_DONE.tasks, task('google_workspace', 'pending', { optional: true })]);
    expect(firstOpenStep(c)).toBe('start');
    expect(stepsLeft(c)).toEqual([]);
  });

  it('are ticked only once something is set up', () => {
    const unset = checklist([
      task('working_style', 'done', { optional: true }),
      task('google_workspace', 'pending', { optional: true }),
      task('web_research', 'done', { optional: true, optional_upgrade: { vault_keys: ['tavily_api_key'], configured: false } }),
    ]);
    // Working style's check is always done, so it says nothing: never ticked.
    expect(stepMark('working_style', unset)).toBe('todo');
    expect(stepMark('capabilities', checklist([task('capabilities', 'done', { optional: true })]))).toBe('todo');
    expect(stepMark('google_workspace', unset)).toBe('todo');
    // Keyless search is done too; only the key ticks it.
    expect(stepMark('web_research', unset)).toBe('todo');
    const set = checklist([
      task('google_workspace', 'done', { optional: true }),
      task('web_research', 'done', { optional: true, optional_upgrade: { vault_keys: ['tavily_api_key'], configured: true } }),
    ]);
    expect(stepMark('google_workspace', set)).toBe('done');
    expect(stepMark('web_research', set)).toBe('done');
    expect(stepMark('google_workspace', null)).toBe('todo');
  });
});

describe('stepMark', () => {
  it('reads a step’s own task', () => {
    const c = checklist([task('who', 'done'), task('email', 'pending'), task('voice', 'pending', { restart_required: true })]);
    expect(stepMark('who', c)).toBe('done');
    expect(stepMark('email', c)).toBe('todo');
    expect(stepMark('voice', c)).toBe('attention');
  });

  it('locks Start onboarding until every required step is done', () => {
    expect(stepMark('start', checklist([task('email', 'pending')]))).toBe('locked');
    expect(stepMark('start', ALL_DONE)).toBe('todo');
    expect(stepMark('start', null)).toBe('locked');
  });

  it('flags Apply & restart while a required step waits for a restart, not for an optional one', () => {
    expect(stepMark('apply', checklist([task('email', 'pending', { restart_required: true })]))).toBe('attention');
    expect(stepMark('apply', checklist([...ALL_DONE.tasks, task('web_browser', 'pending', { optional: true, restart_required: true })]))).toBe('done');
  });
});

describe('firstOpenStep', () => {
  it('lands a returning operator on the first required step not done', () => {
    expect(firstOpenStep(checklist([task('who', 'done'), task('curia_name', 'done'), task('email', 'pending')]))).toBe('email');
  });

  it('lands on a step that waits for a restart: it is not done yet', () => {
    const c = checklist(['who', 'curia_name', 'email', 'messaging', 'voice', 'mailbox_signin'].map((id) =>
      task(id, id === 'voice' ? 'pending' : 'done', id === 'voice' ? { restart_required: true } : {})));
    expect(firstOpenStep(c)).toBe('voice');
  });

  it('treats a step the checklist does not report as not done', () => {
    expect(firstOpenStep(checklist(['who', 'curia_name'].map((id) => task(id, 'done'))))).toBe('email');
  });

  it('goes to Start onboarding once everything is done, and starts at the top with no checklist', () => {
    expect(firstOpenStep(ALL_DONE)).toBe('start');
    expect(firstOpenStep(null)).toBe('who');
  });
});

describe('names', () => {
  it('uses the principal’s first name, or a neutral phrase before it is saved', () => {
    expect(firstName('Dana Okafor')).toBe('Dana');
    expect(firstName('  ')).toBeNull();
    expect(principalLabel(null)).toBe('your principal');
    expect(groupLabel('accounts', 'Dana')).toBe('Dana’s accounts');
    expect(groupLabel('accounts', null)).toBe('Your principal’s accounts');
  });

  it('capitalizes the label at the start of a sentence, and leaves a name alone', () => {
    expect(atSentenceStart('your principal')).toBe('Your principal');
    expect(atSentenceStart('Dana')).toBe('Dana');
  });

  it('lists what is left in step order', () => {
    expect(stepsLeft(checklist([task('voice', 'pending'), task('email', 'pending'), task('who', 'done')])).map((s) => s.id)).toEqual(['email', 'voice']);
  });
});

describe('setupRedirect (the first-load gate)', () => {
  const inSetup = { inSetup: true };
  const done = { inSetup: false };

  it.each(['/', '/chat', '/kg', '/tasks'])('sends %s to Setup while Setup runs', (path) => {
    expect(setupRedirect(path, inSetup)).toBe('/setup');
  });

  it.each(['/setup', '/channels', '/settings/email-calendar', '/system/devices', '/contacts'])(
    'keeps %s open while Setup runs: a step links there',
    (path) => {
      expect(setupRedirect(path, inSetup)).toBeNull();
    },
  );

  it('does not treat a lookalike path as open', () => {
    expect(setupRedirect('/settingsx', inSetup)).toBe('/setup');
  });

  it('sends an install that is not in Setup away from the Setup page, and leaves the rest alone', () => {
    expect(setupRedirect('/setup', done)).toBe('/');
    expect(setupRedirect('/chat', done)).toBeNull();
  });

  it.each(['/setup', '/chat', '/'])('stays on %s when Setup is unknown (a failed, throttled or mid-restart check)', (path) => {
    expect(setupRedirect(path, { inSetup: null })).toBeNull();
  });
});

describe('createLatestSaver (route saves)', () => {
  /** A save that waits until released, recording each value as it starts and ends. */
  function gatedSave() {
    const started: string[] = [];
    const finished: string[] = [];
    const releases: Array<() => void> = [];
    const save = async (v: string): Promise<void> => {
      started.push(v);
      await new Promise<void>((resolve) => releases.push(resolve));
      finished.push(v);
    };
    return { save, started, finished, releaseNext: () => releases.shift()?.() };
  }
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  it('never runs two saves at once, and saves the newest pick last', async () => {
    const g = gatedSave();
    const submit = createLatestSaver(g.save);
    const a = submit('signal');
    const b = submit('sms');
    const c = submit('slack');
    await tick();
    expect(g.started).toEqual(['signal']);
    g.releaseNext();
    await tick();
    // 'sms' was superseded while 'signal' was saving: only the newest pick goes next.
    expect(g.started).toEqual(['signal', 'slack']);
    g.releaseNext();
    await Promise.all([a, b, c]);
    expect(g.finished).toEqual(['signal', 'slack']);
  });

  it('starts fresh after a run finishes', async () => {
    const saved: string[] = [];
    const submit = createLatestSaver(async (v: string) => { saved.push(v); });
    await submit('app');
    await submit('signal');
    expect(saved).toEqual(['app', 'signal']);
  });

  it('drops queued picks after a failed save and reports the failure to every waiter', async () => {
    let calls = 0;
    const submit = createLatestSaver(async () => {
      calls++;
      await tick();
      throw new Error('500');
    });
    const a = submit('signal');
    const b = submit('sms');
    await expect(a).rejects.toThrow('500');
    await expect(b).rejects.toThrow('500');
    expect(calls).toBe(1);
  });
});

describe('sharedLatestSaver (a step that remounts)', () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  it('keeps one queue per key across mounts, and runs each value with the newest mount’s save', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    // First mount: its save of "signal" is slow.
    const first = sharedLatestSaver<string>('test-route', async (v) => { await gate; order.push(`first:${v}`); });
    const slow = first('signal');
    await tick();
    // The step remounts (another step opened, then this one again); "sms" is picked.
    const second = sharedLatestSaver<string>('test-route', async (v) => { order.push(`second:${v}`); });
    expect(second).toBe(first);
    const fast = second('sms');
    release();
    await Promise.all([slow, fast]);
    // "sms" waited for "signal" and saved last, through the newest mount's save.
    expect(order).toEqual(['first:signal', 'second:sms']);
  });

  it('keeps separate queues for separate keys', () => {
    expect(sharedLatestSaver<string>('test-a', async () => {})).not.toBe(sharedLatestSaver<string>('test-b', async () => {}));
  });
});
