import { describe, it, expect } from 'vitest';
import { ALREADY_DELIVERED_REASON, DelegationGuard, delegationKey, findAlreadyDeliveredKey, MAX_RETRYABLE_IDENTICAL_DELEGATIONS, parseDelegateFailureData, seedAlreadyDelivered } from './delegation-guard.js';
import { encodeResumeToken, MAX_RESUME_TASK_LENGTH } from './resume-token.js';
import pino from 'pino';

describe('DelegationGuard', () => {
  const key = delegationKey('social-media', 'Post to Bluesky');

  it('blocks identical re-delegation after a non-retryable failure', () => {
    const guard = new DelegationGuard();
    guard.recordInvocation(key);
    guard.recordFailure(key, {
      agent: 'social-media',
      reason: 'maxTurns',
      retryable: false,
      message: 'exceeded turn budget',
    });
    expect(guard.canAttempt(key)).toBe(false);
    expect(guard.shouldEscalate(key)).toBe(true);
  });

  it('blocks immediately after a timeout failure', () => {
    const guard = new DelegationGuard();
    guard.recordInvocation(key);
    guard.recordFailure(key, {
      agent: 'social-media',
      reason: 'timeout',
      retryable: false,
      message: 'delegate wait timed out',
    });
    expect(guard.canAttempt(key)).toBe(false);
    expect(guard.shouldEscalate(key)).toBe(true);
  });

  it('allows one retry for retryable failures then blocks', () => {
    const guard = new DelegationGuard();
    guard.recordInvocation(key);
    guard.recordFailure(key, {
      agent: 'social-media',
      reason: 'api_error',
      retryable: true,
      message: 'provider timeout',
    });
    expect(guard.canAttempt(key)).toBe(true);
    expect(guard.shouldEscalate(key)).toBe(false);

    guard.recordInvocation(key);
    guard.recordFailure(key, {
      agent: 'social-media',
      reason: 'api_error',
      retryable: true,
      message: 'provider timeout again',
    });
    expect(guard.canAttempt(key)).toBe(false);
    expect(guard.shouldEscalate(key)).toBe(true);
  });

  it('does not escalate twice for the same key', () => {
    const guard = new DelegationGuard();
    guard.recordInvocation(key);
    guard.recordFailure(key, {
      agent: 'social-media',
      reason: 'maxTurns',
      retryable: false,
      message: 'exceeded turn budget',
    });
    expect(guard.shouldEscalate(key)).toBe(true);
    guard.markEscalated(key);
    expect(guard.shouldEscalate(key)).toBe(false);
  });

  it('treats different tasks as distinct keys', () => {
    const guard = new DelegationGuard();
    const otherKey = delegationKey('social-media', 'Different task');
    guard.recordInvocation(key);
    guard.recordFailure(key, {
      agent: 'social-media',
      reason: 'maxTurns',
      retryable: false,
      message: 'exceeded turn budget',
    });
    expect(guard.canAttempt(otherKey)).toBe(true);
  });

  it('does not block successful repeat delegations before any failure is recorded', () => {
    const guard = new DelegationGuard();
    for (let i = 0; i < MAX_RETRYABLE_IDENTICAL_DELEGATIONS + 1; i++) {
      guard.recordInvocation(key);
    }
    expect(guard.canAttempt(key)).toBe(true);
  });

  it(`allows up to ${MAX_RETRYABLE_IDENTICAL_DELEGATIONS} attempts for retryable failures`, () => {
    const guard = new DelegationGuard();
    for (let i = 0; i < MAX_RETRYABLE_IDENTICAL_DELEGATIONS - 1; i++) {
      expect(guard.canAttempt(key)).toBe(true);
      guard.recordInvocation(key);
      guard.recordFailure(key, {
        agent: 'social-media',
        reason: 'api_error',
        retryable: true,
        message: `attempt ${i + 1}`,
      });
    }
    expect(guard.canAttempt(key)).toBe(true);
    guard.recordInvocation(key);
    guard.recordFailure(key, {
      agent: 'social-media',
      reason: 'api_error',
      retryable: true,
      message: 'final attempt',
    });
    expect(guard.canAttempt(key)).toBe(false);
  });
});

describe('parseDelegateFailureData — late-delivery correlation ids (#1799)', () => {
  const logger = pino({ level: 'silent' });

  it('carries the delegate event id, conversation, and elapsed wait from a timeout payload', () => {
    const parsed = parseDelegateFailureData({
      agent: 'calendar',
      failed: true,
      reason: 'timeout',
      retryable: false,
      message: 'did not respond within the delegate wait window',
      possibly_succeeded: true,
      delegate_event_id: 'evt-delegate-1',
      delegate_conversation_id: 'delegate-abc',
      wait_timeout_ms: 750_000,
    }, logger);

    expect(parsed).not.toBeNull();
    expect(parsed?.possiblySucceeded).toBe(true);
    expect(parsed?.delegateEventId).toBe('evt-delegate-1');
    expect(parsed?.delegateConversationId).toBe('delegate-abc');
    expect(parsed?.waitTimeoutMs).toBe(750_000);
  });

  it('drops mistyped correlation ids rather than passing them through', () => {
    const parsed = parseDelegateFailureData({
      agent: 'calendar',
      failed: true,
      reason: 'timeout',
      retryable: false,
      message: 'timed out',
      delegate_event_id: 42,
      delegate_conversation_id: null,
      wait_timeout_ms: -1,
    }, logger);

    expect(parsed).not.toBeNull();
    expect(parsed?.delegateEventId).toBeUndefined();
    expect(parsed?.delegateConversationId).toBeUndefined();
    expect(parsed?.waitTimeoutMs).toBeUndefined();
  });

  it('leaves the ids absent for failures that are not timeouts', () => {
    const parsed = parseDelegateFailureData({
      agent: 'social-media',
      failed: true,
      reason: 'maxTurns',
      retryable: false,
      message: 'exceeded turn budget',
    }, logger);

    expect(parsed?.delegateEventId).toBeUndefined();
    expect(parsed?.waitTimeoutMs).toBeUndefined();
  });
});

describe('DelegationGuard.isAlreadyDelivered (#1799)', () => {
  const key = delegationKey('calendar', 'Detect travel since Aug 17');

  it('is true only for an already-delivered record', () => {
    const guard = new DelegationGuard();
    expect(guard.isAlreadyDelivered(key)).toBe(false);

    guard.recordFailure(key, {
      agent: 'calendar',
      reason: ALREADY_DELIVERED_REASON,
      retryable: false,
      message: 'already completed this work',
    });
    expect(guard.isAlreadyDelivered(key)).toBe(true);
  });

  it('is false for other non-retryable failures, which a resume_token may still continue', () => {
    const guard = new DelegationGuard();
    guard.recordFailure(key, {
      agent: 'calendar',
      reason: 'blocked',
      retryable: false,
      message: 'waiting on a person',
    });
    expect(guard.canAttempt(key)).toBe(false);
    expect(guard.isAlreadyDelivered(key)).toBe(false);
  });

  it('is false for an unknown key', () => {
    expect(new DelegationGuard().isAlreadyDelivered(delegationKey('x', 'y'))).toBe(false);
  });
});

describe('findAlreadyDeliveredKey (#1799)', () => {
  const ORIGINAL = 'Detect travel since Aug 17';
  const DIRECTION = 'Also include the Boston leg';

  function guardWithDelivered(task: string): DelegationGuard {
    const guard = new DelegationGuard();
    guard.recordFailure(delegationKey('calendar', task), {
      agent: 'calendar',
      reason: ALREADY_DELIVERED_REASON,
      retryable: false,
      message: 'already completed',
    });
    return guard;
  }

  it('finds the record when the call repeats the delivered task', () => {
    const guard = guardWithDelivered(ORIGINAL);
    expect(findAlreadyDeliveredKey(guard, 'calendar', ORIGINAL))
      .toBe(delegationKey('calendar', ORIGINAL));
  });

  it("finds it via the token's original_task when the call carries new direction", () => {
    // The bypass this exists to close: a resume's `task` is the direction, so its own key has no
    // record and a check limited to that key would exempt the call and re-run finished work.
    const guard = guardWithDelivered(ORIGINAL);
    const token = encodeResumeToken({ agent: 'calendar', originalTask: ORIGINAL, context: 'so far' });
    expect(findAlreadyDeliveredKey(guard, 'calendar', DIRECTION, token))
      .toBe(delegationKey('calendar', ORIGINAL));
  });

  it('returns undefined when neither key was delivered', () => {
    const guard = guardWithDelivered('some other task');
    const token = encodeResumeToken({ agent: 'calendar', originalTask: ORIGINAL, context: 'so far' });
    expect(findAlreadyDeliveredKey(guard, 'calendar', DIRECTION, token)).toBeUndefined();
  });

  it('returns undefined for an undecodable token rather than throwing', () => {
    const guard = guardWithDelivered(ORIGINAL);
    expect(findAlreadyDeliveredKey(guard, 'calendar', DIRECTION, 'not-a-token')).toBeUndefined();
  });

  it('ignores a token minted for a different agent', () => {
    // calendar HAS a delivered record for this brief, and the token carries that same brief — but it
    // was minted for research, so it is not valid for this call and must not decide the guard key.
    // The handler rejects the mismatch with a specific error a few lines later; blocking here would
    // replace that with a generic "blocked".
    const guard = guardWithDelivered(ORIGINAL);
    const token = encodeResumeToken({ agent: 'research', originalTask: ORIGINAL, context: 'so far' });
    expect(findAlreadyDeliveredKey(guard, 'calendar', DIRECTION, token)).toBeUndefined();
  });

  it('does not treat other failure reasons as delivered', () => {
    const guard = new DelegationGuard();
    guard.recordFailure(delegationKey('calendar', ORIGINAL), {
      agent: 'calendar',
      reason: 'blocked',
      retryable: false,
      message: 'waiting on a person',
    });
    const token = encodeResumeToken({ agent: 'calendar', originalTask: ORIGINAL, context: 'so far' });
    expect(findAlreadyDeliveredKey(guard, 'calendar', DIRECTION, token)).toBeUndefined();
  });
});

describe('seedAlreadyDelivered — long briefs (#1799)', () => {
  const LONG = `Detect travel since Aug 17. ${'x'.repeat(MAX_RESUME_TASK_LENGTH)}`;

  it('blocks a resume of a brief long enough that the token truncates it', () => {
    // `delegate` puts no ceiling on task length, and encodeResumeToken truncates past
    // MAX_RESUME_TASK_LENGTH — so keying only on the full brief would leave every long delegation
    // resumable, which is to say unguarded.
    const guard = new DelegationGuard();
    seedAlreadyDelivered(guard, 'calendar', LONG, 'already completed');

    const token = encodeResumeToken({ agent: 'calendar', originalTask: LONG, context: 'so far' });
    const hit = findAlreadyDeliveredKey(guard, 'calendar', 'Also include Boston', token);
    expect(hit).toBeDefined();
  });

  it('still blocks a direct repeat of the full brief', () => {
    const guard = new DelegationGuard();
    seedAlreadyDelivered(guard, 'calendar', LONG, 'already completed');
    expect(findAlreadyDeliveredKey(guard, 'calendar', LONG)).toBe(delegationKey('calendar', LONG));
  });

  it('records a single key for a brief within the token budget', () => {
    const guard = new DelegationGuard();
    const short = 'Detect travel since Aug 17';
    seedAlreadyDelivered(guard, 'calendar', short, 'already completed');
    expect(guard.isAlreadyDelivered(delegationKey('calendar', short))).toBe(true);
    // No spurious second entry under a truncated form that cannot occur.
    expect(guard.isAlreadyDelivered(delegationKey('calendar', `${short}…`))).toBe(false);
  });
});
