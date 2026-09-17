import { describe, it, expect } from 'vitest';
import { DelegationGuard, delegationKey, MAX_RETRYABLE_IDENTICAL_DELEGATIONS, parseDelegateFailureData } from './delegation-guard.js';
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
