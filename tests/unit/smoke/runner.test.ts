// tests/unit/smoke/runner.test.ts — the judge reads its expectations on the same clock as
// the message it judges (CodeRabbit on #2630).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { runTestCases } from '../../smoke/runner.js';
import type { CuriaHarness } from '../../smoke/harness.js';
import type { TestCase } from '../../smoke/types.js';

/** Just enough of the harness for runTestCases: no stack, no model, one canned reply. */
function fakeHarness(timezone: string): CuriaHarness {
  const harness = {
    stack: { config: { timezone } },
    runInCase: async <T>(_state: unknown, fn: () => Promise<T>) => fn(),
    settle: async () => true,
    stubs: { set: () => undefined, clear: () => [] },
    sendMessage: async () => ({ content: 'ok', durationMs: 1, toolCalls: [] }),
    openTargetThread: async () => ({ threadId: 'thread-1', topic: 'Plan', participants: [] }),
    closeTargetThread: async () => undefined,
  };
  // A partial harness: runTestCases with warm-up off touches only these members.
  return harness as unknown as CuriaHarness;
}

const caseWith = (delayMs: number): TestCase => ({
  name: 'Midnight',
  description: '',
  tags: [],
  sender: 'principal',
  judgeToolCalls: false,
  toolStubs: {},
  turns: [{ role: 'user', content: 'Due {{day:today}}', delayMs }],
  expectedBehaviors: [{ id: 'due', description: 'Names {{day:today}}', weight: 'critical' }],
  failureModes: ['Names a day other than {{day:today}}'],
});

afterEach(() => { vi.useRealTimers(); });

describe('judge text clock', () => {
  it('resolves expectations on the first turn\'s clock when its delay crosses local midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
    // 23:59:59 on Sunday Nov 15 in Toronto; the turn sends two seconds later, on Monday.
    vi.setSystemTime(new Date('2026-11-16T04:59:59Z'));

    const run = runTestCases(fakeHarness('America/Toronto'), [caseWith(2_000)], { warmUp: false });
    await vi.advanceTimersByTimeAsync(2_000);
    const [exec] = (await run).executions;

    expect(exec!.responses[0]!.prompt).toBe('Due Monday, November 16');
    expect(exec!.testCase.expectedBehaviors[0]!.description).toBe('Names Monday, November 16');
    expect(exec!.testCase.failureModes[0]).toBe('Names a day other than Monday, November 16');
    // The judge's "## Today" line comes from the same clock.
    expect(exec!.today).toBe('Monday, November 16, 2026 (America/Toronto)');
  });

  it('keeps a later turn on the case\'s day across midnight, while {{at:now}} moves with it', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
    // Turn 1 at 23:59:50 Sunday in Toronto; turn 2 waits 20s and sends at 00:00:10 Monday.
    vi.setSystemTime(new Date('2026-11-16T04:59:50Z'));
    const twoTurns: TestCase = {
      ...caseWith(0),
      turns: [
        { role: 'user', content: 'Drafts from {{day:today-1}}' },
        { role: 'user', content: 'Send them. Day {{day:today}}, at {{at:now}}', delayMs: 20_000 },
      ],
    };

    const run = runTestCases(fakeHarness('America/Toronto'), [twoTurns], { warmUp: false });
    await vi.advanceTimersByTimeAsync(20_000);
    const [exec] = (await run).executions;

    expect(exec!.responses[0]!.prompt).toBe('Drafts from Saturday, November 14');
    // Same day as turn 1 and the judge, but the moment is the turn's own.
    expect(exec!.responses[1]!.prompt).toBe('Send them. Day Sunday, November 15, at 2026-11-16T00:00:00.000-05:00');
    expect(exec!.today).toBe('Sunday, November 15, 2026 (America/Toronto)');
  });

  it('puts a targeted case\'s opening on that same clock', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
    vi.setSystemTime(new Date('2026-11-16T04:59:59Z'));
    const targeted: TestCase = {
      ...caseWith(2_000),
      target: { agent: 'calendar', via: 'bullpen', from: 'coordinator', topic: 'Plan', opening: 'Opened {{day:today}}' },
    };

    const run = runTestCases(fakeHarness('America/Toronto'), [targeted], { warmUp: false });
    await vi.advanceTimersByTimeAsync(2_000);
    const [exec] = (await run).executions;

    expect(exec!.target?.opening).toBe('Opened Monday, November 16');
    expect(exec!.responses[0]!.prompt).toBe('Due Monday, November 16');
    expect(exec!.testCase.expectedBehaviors[0]!.description).toBe('Names Monday, November 16');
  });
});
