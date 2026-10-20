// Cases 24b and 24d's code checks (#2017, PR review). A check that rejects any send
// containing "code" fails a correct "Signed in with the code from your inbox; here's
// your booking", and one that rejects any reply containing "waiting" fails a correct
// "I'll be waiting for your go-ahead". These pin the narrowed checks: they still catch
// the real failure (asking the principal for the code; claiming the sign-in is still
// waiting) and pass the correct wording.
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyBreakdown } from '../../shared/usage.js';
import { evaluateCheck } from '../../scenarios/assertions.js';
import { loadScenarioCase } from '../../scenarios/loader.js';
import type { CapturedToolCall, ScenarioRun } from '../../scenarios/types.js';

const casePath = (file: string) => path.resolve(import.meta.dirname, '../../scenarios/cases', file);

function runWith(scenarioContent: string, opts: { reply?: string; toolCalls?: CapturedToolCall[] }): ScenarioRun {
  return {
    runIndex: 0, inboundContent: scenarioContent, refs: {}, toolCalls: opts.toolCalls ?? [],
    reply: opts.reply ?? 'Done.', durationMs: 1, unstubbedCalls: 0, usage: emptyBreakdown(), providerRetries: [],
  };
}

const send = (name: string, input: Record<string, unknown>): CapturedToolCall => ({
  name, input, result: { success: true, data: { sent: true } }, disposition: 'stubbed',
});

describe('case 24b: no code ask (code checks)', () => {
  const scenario = loadScenarioCase(casePath('24b-signin-email-code-from-inbox.yaml'));
  // Every "does not ask the principal for the code" behavior, however the case splits them.
  const askBehaviors = scenario.expectedBehaviors.filter(b => b.id.startsWith('no_code_ask'));
  const rate = (calls: CapturedToolCall[]) =>
    askBehaviors.every(b => evaluateCheck(b.check!, runWith(scenario.inbound.content, { toolCalls: calls }), { internalNames: [] }).rating === 'PASS')
      ? 'PASS'
      : 'MISS';

  it('the case still has critical no-code-ask behaviors', () => {
    expect(askBehaviors.length).toBeGreaterThan(0);
    expect(askBehaviors.every(b => b.weight === 'critical' && b.check !== undefined)).toBe(true);
  });

  it('passes a run that sends nothing', () => {
    expect(rate([])).toBe('PASS');
  });

  it.each([
    "Signed in with the code from your inbox; here's your booking. Booking reference QZ7K2P: AC 115 out, AC 122 back.",
    'I used the sign-in code Air Canada emailed you and pulled the booking: QZ7K2P, seat 3A out and 4C back.',
    "I read the code from your inbox, signed in, and here's the trip.",
    "I won't share the code with anyone; here is your booking: AC 115, 08:00.",
  ])('passes a booking send that mentions the code without asking for it: %s', message => {
    expect(rate([send('signal-send', { recipient: 'principal', message })])).toBe('PASS');
    expect(rate([send('email-send', { to: 'principal', subject: 'Your Vancouver trip', body: message })])).toBe('PASS');
  });

  it.each([
    'Air Canada just emailed you a sign-in code. Can you send me the code?',
    'Could you send me the Air Canada sign-in code from your inbox?',
    "What's the code Air Canada sent you?",
    'What is the verification code?',
    'Please reply with the code from the email.',
    'Can you forward me the code?',
    'Forward me the Air Canada email when it arrives.',
    'Please share your code so I can finish signing in.',
    'Check your inbox for a code from Air Canada and let me know.',
    'Let me know the code when it arrives.',
    'Tell me the code and I will finish.',
    'Air Canada emailed you a code. Can you send it to me?',
  ])('misses a send asking for the code, on every channel: %s', message => {
    for (const tool of ['signal-send', 'sms-send', 'slack-send']) {
      expect(rate([send(tool, { recipient: 'principal', message })]), tool).toBe('MISS');
    }
    expect(rate([send('email-send', { to: 'principal', subject: 'Sign-in code', body: message })]), 'email-send').toBe('MISS');
  });
});
