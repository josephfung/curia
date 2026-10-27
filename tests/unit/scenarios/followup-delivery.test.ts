import { describe, expect, it } from 'vitest';
import {
  FOLLOWUP_NOT_QUEUED_ERROR,
  FOLLOWUP_UNPUBLISHED_ERROR,
  followupCleansAfterSettle,
  followupScoreError,
  observeFollowupDelivery,
  unpublishedFollowupError,
} from '../../scenarios/harness.js';

describe('unpublished follow-up (#2018)', () => {
  it('fails a follow-up case whose second message never started', () => {
    expect(unpublishedFollowupError(true, false, undefined)).toBe(FOLLOWUP_UNPUBLISHED_ERROR);
  });

  it('keeps a timeout that already failed the run', () => {
    expect(unpublishedFollowupError(true, false, 'timed out')).toBe('timed out');
  });

  it('leaves a published follow-up alone', () => {
    expect(unpublishedFollowupError(true, true, undefined)).toBeUndefined();
  });

  it('ignores a case with no follow-up', () => {
    expect(unpublishedFollowupError(false, false, undefined)).toBeUndefined();
  });

  it('waits for the landing before it treats a publish as joined or missed', async () => {
    let published = false;
    let joined: boolean | undefined;
    let release: () => void = () => {};
    const landing = new Promise<void>((resolve) => { release = resolve; });
    const score = followupScoreError({
      hasFollowup: true,
      published: () => published,
      landing,
      joinedHost: () => joined,
      existingError: undefined,
    });
    let done = false;
    void score.then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    published = true;
    joined = true;
    release();
    await expect(score).resolves.toBeUndefined();
  });

  it('fails a published follow-up whose decision never joins the host', async () => {
    await expect(followupScoreError({
      hasFollowup: true,
      published: () => true,
      landing: Promise.resolve(),
      joinedHost: () => undefined,
      existingError: undefined,
    })).resolves.toBe(FOLLOWUP_NOT_QUEUED_ERROR);
  });

  it('keeps an existing error when the follow-up does not join', async () => {
    await expect(followupScoreError({
      hasFollowup: true,
      published: () => true,
      landing: Promise.resolve(),
      joinedHost: () => false,
      existingError: 'timed out',
    })).resolves.toBe('timed out');
  });
});

describe('follow-up delivery cleanup (#2018)', () => {
  function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: unknown) => void } {
    let resolve: () => void = () => {};
    let reject: (err: unknown) => void = () => {};
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it('does not clean up when the follow-up joined the host turn', async () => {
    const delivery = deferred();
    let cleaned = false;
    const settled = observeFollowupDelivery(delivery.promise, () => true, async () => { cleaned = true; });
    let done = false;
    void settled.then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    delivery.resolve();
    await settled;
    expect(cleaned).toBe(false);
    expect(followupCleansAfterSettle(true)).toBe(false);
  });

  it('cleans up after a follow-up that ran as its own turn', async () => {
    const delivery = deferred();
    let cleaned = false;
    const settled = observeFollowupDelivery(delivery.promise, () => false, async () => { cleaned = true; });
    delivery.resolve();
    await settled;
    expect(cleaned).toBe(true);
    expect(followupCleansAfterSettle(false)).toBe(true);
  });

  it('cleans up when tryInject never joined the publish', async () => {
    const delivery = deferred();
    let cleaned = false;
    const settled = observeFollowupDelivery(delivery.promise, () => undefined, async () => { cleaned = true; });
    delivery.reject(new Error('turn failed'));
    await settled;
    expect(cleaned).toBe(true);
    expect(followupCleansAfterSettle(undefined)).toBe(true);
  });

  it('reads the join decision at settlement, not at publish time', async () => {
    const delivery = deferred();
    let joined: boolean | undefined;
    let cleaned = false;
    const settled = observeFollowupDelivery(delivery.promise, () => joined, async () => { cleaned = true; });
    joined = true;
    delivery.resolve();
    await settled;
    expect(cleaned).toBe(false);
  });
});
