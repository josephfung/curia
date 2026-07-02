import { describe, it, expect } from 'vitest';
import { DelegationGuard, delegationKey, MAX_RETRYABLE_IDENTICAL_DELEGATIONS } from './delegation-guard.js';

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

  it('allows one retry for timeout failures then blocks', () => {
    const guard = new DelegationGuard();
    guard.recordInvocation(key);
    guard.recordFailure(key, {
      agent: 'social-media',
      reason: 'timeout',
      retryable: true,
      message: 'delegate wait timed out',
    });
    expect(guard.canAttempt(key)).toBe(true);
    expect(guard.shouldEscalate(key)).toBe(false);

    guard.recordInvocation(key);
    guard.recordFailure(key, {
      agent: 'social-media',
      reason: 'timeout',
      retryable: true,
      message: 'delegate wait timed out again',
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
