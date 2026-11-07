import { describe, it, expect, vi } from 'vitest';
import { addPrincipalNoteToReviewTask, ALREADY_DELIVERED_REASON, DelegationGuard, escalateDelegationFailure, delegationKey, findAlreadyDeliveredKey, MAX_RETRYABLE_IDENTICAL_DELEGATIONS, parseDelegateFailureData, parseDelegateInProgressData, countDeclineNotes, parseDelegateSuccessAgent, recordUnresolvedDecline, seedAlreadyDelivered } from '../../../src/agents/delegation-guard.js';
import { encodeResumeToken, MAX_RESUME_TASK_LENGTH } from '../../../src/agents/resume-token.js';
import pino from 'pino';
import { escalationRequester } from '../../../src/agents/task-escalation.js';
import type { ExecutionLayer } from '../../../src/skills/execution.js';

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

  it('blocks a reworded brief after one structured decline (#1871)', () => {
    const guard = new DelegationGuard();
    const original = delegationKey('calendar', 'Brief me on the CEO calendar for today');
    const reworded = delegationKey('calendar', 'List today\'s events with titles, times, and locations');
    guard.recordSpecialistDecline('calendar', {
      agent: 'calendar',
      reason: 'specialist_decline',
      retryable: false,
      declined: true,
      message: 'Unrecognized sender; refusing the day brief.',
    });
    expect(guard.canAttempt(original)).toBe(false);
    expect(guard.canAttempt(reworded)).toBe(false);
    expect(guard.getAgentDecline('calendar')?.declined).toBe(true);
    expect(guard.canAttempt(delegationKey('research-analyst', 'Look this up'))).toBe(true);
  });

  describe('retry after an unblock (#2496)', () => {
    const decline = {
      agent: 'ceo-inbox',
      reason: 'specialist_decline',
      retryable: false,
      declined: true,
      message: 'That address is not in the mailbox or a contact.',
    };
    const inboxKey = delegationKey('ceo-inbox', 'Draft to contact c-dana');

    it('opens one retry once another specialist succeeds', () => {
      const guard = new DelegationGuard();
      guard.recordSpecialistDecline('ceo-inbox', decline);
      expect(guard.canAttempt(inboxKey)).toBe(false);
      guard.recordDelegationSuccess('contacts');
      expect(guard.getAgentDecline('ceo-inbox')).toBeUndefined();
      expect(guard.canAttempt(inboxKey)).toBe(true);
      guard.consumeDeclineRetry('ceo-inbox');
      expect(guard.canAttempt(inboxKey)).toBe(false);
      expect(guard.hasDeclined('ceo-inbox')).toBe(true);
    });

    it('closes for good after a second decline', () => {
      const guard = new DelegationGuard();
      guard.recordSpecialistDecline('ceo-inbox', decline);
      guard.recordDelegationSuccess('contacts');
      guard.consumeDeclineRetry('ceo-inbox');
      guard.recordSpecialistDecline('ceo-inbox', decline);
      guard.recordDelegationSuccess('contacts');
      expect(guard.canAttempt(inboxKey)).toBe(false);
    });

    it('clears the decline when the retry itself succeeds', () => {
      const guard = new DelegationGuard();
      guard.recordSpecialistDecline('ceo-inbox', decline);
      guard.recordDelegationSuccess('contacts');
      guard.consumeDeclineRetry('ceo-inbox');
      guard.recordDelegationSuccess('ceo-inbox');
      expect(guard.hasDeclined('ceo-inbox')).toBe(false);
      expect(guard.canAttempt(inboxKey)).toBe(true);
    });
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

describe('parseDelegateInProgressData (#2018)', () => {
  const logger = pino({ level: 'silent' });

  it('accepts an interrupted wait and rejects a timeout wearing the same flag', () => {
    const parsed = parseDelegateInProgressData({
      agent: 'researcher',
      in_progress: true,
      reason: 'interrupted',
      delegate_event_id: 'evt-1',
      delegate_conversation_id: 'delegate-1',
      message: 'still working',
    }, logger);
    expect(parsed).toEqual({
      inProgress: true,
      agent: 'researcher',
      reason: 'interrupted',
      delegateEventId: 'evt-1',
      delegateConversationId: 'delegate-1',
      message: 'still working',
    });

    expect(parseDelegateInProgressData({
      agent: 'researcher',
      in_progress: true,
      reason: 'timeout',
      failed: true,
      retryable: false,
      message: 'timed out',
      delegate_event_id: 'evt-1',
      delegate_conversation_id: 'delegate-1',
    }, logger)).toBeNull();
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

describe('escalateDelegationFailure — outside sender waiting (#1978)', () => {
  const logger = pino({ level: 'silent' });
  const failure = {
    agent: 'ceo-inbox',
    reason: 'timeout' as const,
    retryable: false,
    message: "Specialist 'ceo-inbox' did not respond",
    task: 'Find the venue options thread',
  };

  function execution() {
    const invoke = vi.fn(async () => ({ success: true as const, data: { task_id: 'review-1' } }));
    return { layer: { invoke } as unknown as ExecutionLayer, invoke };
  }

  it('records the waiting sender on the review task and tags it', async () => {
    const { layer, invoke } = execution();
    const awaitingReply = escalationRequester({
      displayName: 'Lena Okafor',
      senderId: 'lena.okafor@example.test',
      channel: 'email',
      conversationId: 'email:thread-1978',
    });
    const result = await escalateDelegationFailure(layer, undefined, {}, { ...failure, awaitingReply }, logger);

    const input = (invoke.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    // The progress note it wrote comes back, so a later note can re-state it (#1990).
    expect(result).toEqual({ escalated: true, reviewTaskId: 'review-1', progressNote: input['progress_note'] });
    expect(input['tags']).toContain('external-waiting');
    expect(String(input['progress_note'])).toContain('Lena Okafor (lena.okafor@example.test, email) is waiting on a reply');
    expect(String(input['description'])).toContain('Waiting on a reply: Lena Okafor');
    expect(JSON.parse(String(input['escalation_json'])).awaitingReply).toEqual(awaitingReply);
    // A person waiting is a digest item, not a due date or a direct message (#1978).
    expect(input['due_at']).toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('leaves the review task as before when no one outside is waiting', async () => {
    const { layer, invoke } = execution();
    await escalateDelegationFailure(layer, undefined, {}, failure, logger);
    const input = (invoke.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(input['tags']).not.toContain('external-waiting');
    expect(String(input['progress_note'])).not.toMatch(/waiting on a reply/);
    expect(JSON.parse(String(input['escalation_json'])).awaitingReply).toBeUndefined();
  });
});

describe('addPrincipalNoteToReviewTask (#1990)', () => {
  const logger = pino({ level: 'silent' });
  const reviewTask = {
    id: 'review-1',
    progressNote: 'ceo-inbox could not finish the delegated work (timeout). Placeholder Sender (sender@example.test, email) is waiting on a reply.',
  };

  it('appends the note after the escalation summary, so the digest keeps who is waiting', async () => {
    const invoke = vi.fn(async () => ({ success: true as const, data: { task_id: 'review-1' } }));
    const layer = { invoke } as unknown as ExecutionLayer;
    const added = await addPrincipalNoteToReviewTask(layer, undefined, {}, reviewTask, 'Thread not found.', logger);

    expect(added).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    const [tool, input] = invoke.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(tool).toBe('task-update');
    expect(input['task_id']).toBe('review-1');
    const note = String(input['progress_note']);
    expect(note.startsWith(reviewTask.progressNote)).toBe(true);
    expect(note).toContain('is waiting on a reply');
    expect(note.endsWith('Note for you from the reply to the sender: Thread not found.')).toBe(true);
  });

  it('keeps the update within the task-update limit by shortening the note, never the summary', async () => {
    const invoke = vi.fn(async () => ({ success: true as const, data: {} }));
    const layer = { invoke } as unknown as ExecutionLayer;
    await addPrincipalNoteToReviewTask(layer, undefined, {}, reviewTask, 'n'.repeat(5000), logger);
    const note = String((invoke.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]['progress_note']);
    // task-update checks .length (UTF-16 units), so that is the bound that matters.
    expect(note.length).toBeLessThanOrEqual(2000);
    expect(note.startsWith(reviewTask.progressNote)).toBe(true);
  });

  it('leaves the task alone when the summary leaves no room for the note', async () => {
    // task-create allows a longer progress note than task-update, so a long headline
    // (a specialist's free-text block message) can fill the limit on its own.
    const invoke = vi.fn(async () => ({ success: true as const, data: {} }));
    const layer = { invoke } as unknown as ExecutionLayer;
    const longTask = { id: 'review-1', progressNote: `Blocked on a person: ${'m'.repeat(2100)}` };
    expect(await addPrincipalNoteToReviewTask(layer, undefined, {}, longTask, 'Thread not found.', logger)).toBe(false);
    // Cutting the summary to fit would drop the note and shorten what the digest shows.
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reports failure without throwing when the update fails or throws', async () => {
    const failing = { invoke: vi.fn(async () => ({ success: false as const, error: 'nope' })) } as unknown as ExecutionLayer;
    expect(await addPrincipalNoteToReviewTask(failing, undefined, {}, reviewTask, 'x', logger)).toBe(false);
    const throwing = { invoke: vi.fn(async () => { throw new Error('boom'); }) } as unknown as ExecutionLayer;
    expect(await addPrincipalNoteToReviewTask(throwing, undefined, {}, reviewTask, 'x', logger)).toBe(false);
  });
});


describe('parseDelegateSuccessAgent (#2496)', () => {
  it('names the specialist for a finished answer', () => {
    expect(parseDelegateSuccessAgent({ agent: 'contacts', response: 'Added.' })).toBe('contacts');
    expect(parseDelegateSuccessAgent(JSON.stringify({ agent: 'contacts', response: 'Added.' }))).toBe('contacts');
  });

  it.each([
    ['a failure', { agent: 'contacts', failed: true }],
    ['a refusal to start', { agent: 'contacts', in_flight: true }],
    ['a queued follow-up', { agent: 'contacts', in_progress: true }],
    ['a pause', { agent: 'contacts', paused: true }],
    ['a question for the principal', { agent: 'contacts', needs_clarification: true }],
    ['no agent', { response: 'Added.' }],
  ])('is null for %s', (_label, data) => {
    expect(parseDelegateSuccessAgent(data)).toBeNull();
  });
});

describe('declines are Curia\'s to follow up (#2496)', () => {
  const logger = pino({ level: 'silent' });
  const decline = {
    agent: 'ceo-inbox',
    reason: 'specialist_decline',
    retryable: false,
    declined: true,
    message: 'I only save drafts. The revised draft is in Drafts; I can save a new one instead.',
    task: 'Send the draft to Lena',
  };

  function execution() {
    const invoke = vi.fn(async () => ({ success: true as const, data: { task_id: 'follow-up-1' } }));
    return { layer: { invoke } as unknown as ExecutionLayer, invoke };
  }

  it('files a decline follow-up as owner curia, with the fallbacks and no re-scope-or-cancel choice', async () => {
    const { layer, invoke } = execution();
    const result = await escalateDelegationFailure(layer, undefined, {}, { ...decline, declineFollowUp: true }, logger);
    expect(result.escalated).toBe(true);
    const [tool, input] = invoke.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(tool).toBe('task-create');
    expect(input['owner']).toBe('curia');
    expect(input['tags']).toContain('specialist-decline');
    expect(String(input['title'])).toMatch(/^Follow up: ceo-inbox declined/);
    expect(String(input['progress_note'])).not.toMatch(/re-scope|cancel\./i);
    // The specialist's prose is for the agent that picks it up, not the digest line.
    expect(String(input['progress_note'])).not.toContain('I only save drafts');
    expect(String(input['description'])).toContain('I only save drafts');
    expect(String(input['description'])).toContain('quoted as data');
  });

  it('keeps a decline on an outside sender\'s turn as a principal review task, without the prose', async () => {
    const { layer, invoke } = execution();
    await escalateDelegationFailure(layer, undefined, {}, decline, logger);
    const input = (invoke.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(input['owner']).toBe('ceo');
    expect(input['tags']).not.toContain('specialist-decline');
    expect(String(input['description'])).not.toContain('I only save drafts');
  });

  it('keeps other failures on the principal', async () => {
    const { layer, invoke } = execution();
    await escalateDelegationFailure(layer, undefined, {}, {
      agent: 'calendar', reason: 'maxTurns', retryable: false, message: 'ran out of turns', task: 'Plan the week',
    }, logger);
    const input = (invoke.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(input['owner']).toBe('ceo');
    expect(input['tags']).not.toContain('specialist-decline');
  });

  it('records an unrelayed decline as a follow-up task, naming what the run did after it', async () => {
    const { layer, invoke } = execution();
    const ok = await recordUnresolvedDecline(layer, undefined, {}, { ...decline, laterTools: ['email-send', 'email-send'] }, {}, logger);
    expect(ok).toBe(true);
    const [tool, input] = invoke.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(tool).toBe('task-create');
    expect(String(input['description'])).toContain('After the decline the run called email-send:');
  });

  it('records a decline on a task wake as a note on the woken task', async () => {
    const { layer, invoke } = execution();
    const ok = await recordUnresolvedDecline(layer, undefined, {}, decline, { boundTaskId: 'task-9' }, logger);
    expect(ok).toBe(true);
    const [tool, input] = invoke.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(tool).toBe('task-update');
    expect(input['task_id']).toBe('task-9');
    expect(String(input['progress_note'])).toContain('ceo-inbox declined delegated work in this run.');
    expect(String(input['progress_note'])).toContain('Nothing else was called after the decline.');
    expect(String(input['progress_note']).length).toBeLessThanOrEqual(2000);
  });

  it('flags a woken task that a decline already stopped once, so the heartbeat stops reviving it', async () => {
    const { layer, invoke } = execution();
    const ok = await recordUnresolvedDecline(layer, undefined, {}, decline, {
      boundTaskId: 'task-9',
      boundTaskTags: ['outreach'],
      priorDeclineNotes: 1,
    }, logger);
    expect(ok).toBe(true);
    const input = (invoke.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(input['tags']).toEqual(['outreach', 'specialist-decline', 'needs-disposition']);
    expect(String(input['progress_note'])).toContain('stopped retrying');
  });

  it('tags a woken task with the decline marker on the first decline, keeping its tags', async () => {
    const { layer, invoke } = execution();
    await recordUnresolvedDecline(layer, undefined, {}, decline, {
      boundTaskId: 'task-9',
      boundTaskTags: ['outreach'],
    }, logger);
    const input = (invoke.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(input['tags']).toEqual(['outreach', 'specialist-decline']);
  });

  it('keeps the post-decline tool history when the brief fills the recorded limit', async () => {
    const { layer, invoke } = execution();
    await recordUnresolvedDecline(layer, undefined, {}, { ...decline, task: 'x'.repeat(5000), laterTools: ['email-send'] }, {}, logger);
    const input = (invoke.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(String(input['description'])).toContain('After the decline the run called email-send:');
  });

  it('bounds a long tool history and keeps the brief and the check instruction', async () => {
    const { layer, invoke } = execution();
    const laterTools = Array.from({ length: 200 }, (_, i) => `some-long-tool-name-${i}`);
    await recordUnresolvedDecline(layer, undefined, {}, { ...decline, task: 'BRIEF-START ' + 'x'.repeat(5000), laterTools }, {}, logger);
    const description = String((invoke.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]['description']);
    expect(description).toContain('BRIEF-START');
    expect(description).toMatch(/and \d+ more: check whether that finished the work before acting, and close this if it did\./);
  });

  it('counts only the runtime\'s decline notes', () => {
    expect(countDeclineNotes({ notes: [
      { note: 'ceo-inbox declined delegated work in this run. Nothing else was called after the decline.' },
      { note: 'Checked the thread.' },
    ] })).toBe(1);
    expect(countDeclineNotes(undefined)).toBe(0);
  });

  // The cause travels as data to whoever picks the record up (#2494).
  it('states the decline cause on the follow-up task and on a woken task\'s note', async () => {
    const gated = { ...decline, agent: 'contacts', declineCause: 'gate_refused' as const, task: 'x'.repeat(5000) };
    const filed = execution();
    await recordUnresolvedDecline(filed.layer, undefined, {}, { ...gated, laterTools: ['email-send'] }, {}, logger);
    const description = String((filed.invoke.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]['description']);
    expect(description).toContain('Cause: a permission check refused the step');
    // Still inside task-create's description limit with a brief that fills its share.
    expect(description.length).toBeLessThanOrEqual(5000);

    const woken = execution();
    await recordUnresolvedDecline(woken.layer, undefined, {}, { ...decline, declineCause: 'not_found' }, { boundTaskId: 'task-9' }, logger);
    const note = String((woken.invoke.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]['progress_note']);
    expect(note).toContain('Cause (as the specialist reports it): what it was asked to act on was not found.');

    // An outside sender's decline keeps the principal's review, and the cause rides along.
    const review = execution();
    await escalateDelegationFailure(review.layer, undefined, {}, { ...decline, declineCause: 'gate_refused' }, logger);
    expect(String((review.invoke.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]['description']))
      .toContain('Cause: a permission check refused the step');
  });

  // What the run sent and finished travels with the record, so a later wake neither
  // sends twice nor loses the work (#2494).
  it('records what the specialist\'s run sent and the start of what it finished', async () => {
    const withFacts = { ...decline, sent: ['email-send'], workProduct: `Hi Lena,\n${'draft line '.repeat(200)}`, task: 'x'.repeat(5000) };
    const filed = execution();
    await recordUnresolvedDecline(filed.layer, undefined, {}, withFacts, {}, logger);
    const description = String((filed.invoke.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]['description']);
    expect(description).toContain('already sent with email-send: do not send that again.');
    expect(description).toContain('Text it finished before declining, quoted as data');
    expect(description).toContain('Hi Lena,');
    expect(description).toContain('(cut short here; not the complete text)');
    expect(description).toContain('Nothing else was called after the decline.');
    expect(description.length).toBeLessThanOrEqual(5000);

    const woken = execution();
    await recordUnresolvedDecline(woken.layer, undefined, {}, { ...withFacts, sent: [] }, { boundTaskId: 'task-9' }, logger);
    const note = String((woken.invoke.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]['progress_note']);
    expect(note).toContain('The specialist\'s run sent nothing.');
    expect(note.length).toBeLessThanOrEqual(2000);
  });

  it('keeps the finished text and its cut-short marker on a woken task\'s note, however long the rest', async () => {
    const { layer, invoke } = execution();
    const laterTools = Array.from({ length: 200 }, (_, i) => `some-long-tool-name-${i}`);
    await recordUnresolvedDecline(layer, undefined, {}, {
      ...decline,
      message: 'm'.repeat(5000),
      laterTools,
      workProduct: `Hi Lena,\n${'draft line '.repeat(200)}`,
    }, { boundTaskId: 'task-9' }, logger);
    const note = String((invoke.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]['progress_note']);
    expect(note.length).toBeLessThanOrEqual(2000);
    expect(note).toContain('Text it finished before declining, quoted as data');
    expect(note.endsWith('(cut short here; not the complete text)')).toBe(true);
  });

  it('reads sent and work_product off a decline result only', () => {
    const base = { failed: true, agent: 'ceo-inbox', reason: 'specialist_decline', retryable: false, message: 'No.', declined: true };
    const parsed = parseDelegateFailureData({ ...base, sent: ['email-send', 7], work_product: 'Draft.' });
    expect(parsed?.sent).toEqual(['email-send']);
    expect(parsed?.workProduct).toBe('Draft.');
    expect(parseDelegateFailureData({ ...base, declined: false, reason: 'tool_error', sent: ['x'], work_product: 'y' }))
      .not.toHaveProperty('workProduct');
  });

  it('dedupes sent tools before capping, so a later tool is not crowded out', () => {
    const base = { failed: true, agent: 'ceo-inbox', reason: 'specialist_decline', retryable: false, message: 'No.', declined: true };
    const repeated = Array.from({ length: 25 }, () => 'email-send');
    expect(parseDelegateFailureData({ ...base, sent: [...repeated, 'signal-send'] })?.sent)
      .toEqual(['email-send', 'signal-send']);
    const many = Array.from({ length: 30 }, (_, i) => `tool-${i}`);
    expect(parseDelegateFailureData({ ...base, sent: [...many, ...many] })?.sent).toHaveLength(20);
  });

  it('adds no cause line when none was stated', async () => {
    const { layer, invoke } = execution();
    await recordUnresolvedDecline(layer, undefined, {}, { ...decline, declineCause: 'unspecified' }, {}, logger);
    expect(String((invoke.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]['description'])).not.toContain('Cause:');
  });

  it('reads the cause off a decline result, and only a known one', () => {
    const base = { failed: true, agent: 'contacts', reason: 'specialist_decline', retryable: false, message: 'No.', declined: true };
    expect(parseDelegateFailureData({ ...base, cause: 'gate_refused' })?.declineCause).toBe('gate_refused');
    expect(parseDelegateFailureData({ ...base, cause: 'made_up' })).not.toHaveProperty('declineCause');
    // Not a decline: a cause field is ignored.
    expect(parseDelegateFailureData({ ...base, declined: false, reason: 'tool_error', cause: 'not_found' }))
      .not.toHaveProperty('declineCause');
  });

  it('reports a failed write as not recorded', async () => {
    const invoke = vi.fn(async () => ({ success: false as const, error: 'db down' }));
    const layer = { invoke } as unknown as ExecutionLayer;
    expect(await recordUnresolvedDecline(layer, undefined, {}, decline, { boundTaskId: 'task-9' }, logger)).toBe(false);
  });
});
