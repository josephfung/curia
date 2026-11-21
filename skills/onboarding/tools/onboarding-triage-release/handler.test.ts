import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { OnboardingTriageReleaseHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { TaskRow } from '../../../../src/db/queries/tasks.js';
import type { ListTasksFilters } from '../../../../src/db/task-repo.js';

const logger = pino({ level: 'silent' });

function makeWorld(inboxStatus: string, extraTags: string[] = [], parentStatus = 'open') {
  const tasks = [
    { id: 'parent', status: parentStatus, tags: ['onboarding'], parentTaskId: null, createdBy: 'onboarding' },
    {
      id: 'inbox',
      status: inboxStatus,
      tags: ['onboarding', 'onboarding:topic:inbox-expectations', 'onboarding:session:first-conversation', ...extraTags],
      parentTaskId: 'parent',
      createdBy: 'onboarding',
    },
  ] as TaskRow[];
  const taskRepo = {
    listTasks: vi.fn(async (f: ListTasksFilters) =>
      tasks.filter((t) =>
        (!f.tag || t.tags.includes(f.tag)) &&
        (!f.statuses || f.statuses.includes(t.status)) &&
        (!f.parentTaskId || t.parentTaskId === f.parentTaskId)),
    ),
    getTask: vi.fn(async (id: string) => tasks.find((t) => t.id === id) ?? null),
  };
  const onboardingService = {
    releaseTriageHold: vi.fn(async () => {}),
    readState: vi.fn(async () => ({ taskId: 'parent' })),
  };
  const run = () =>
    new OnboardingTriageReleaseHandler().execute({
      input: {},
      log: logger,
      onboardingService,
      taskRepo,
    } as unknown as ToolContext);
  return { run, onboardingService };
}

describe('onboarding-triage-release', () => {
  it('refuses while the inbox-expectations topic is not done', async () => {
    const w = makeWorld('open');
    const result = await w.run();
    expect(result.success).toBe(false);
    expect(w.onboardingService.releaseTriageHold).not.toHaveBeenCalled();
  });

  it('refuses when the inbox-expectations topic was declined', async () => {
    const w = makeWorld('done', ['onboarding:declined']);
    const result = await w.run();
    expect(result.success).toBe(false);
    expect(w.onboardingService.releaseTriageHold).not.toHaveBeenCalled();
  });

  it('releases the hold once the inbox-expectations topic is done', async () => {
    const w = makeWorld('done');
    const result = await w.run();
    expect(result.success).toBe(true);
    expect(w.onboardingService.releaseTriageHold).toHaveBeenCalledTimes(1);
  });

  // Marking inbox-expectations done can complete the onboarding task when it was the last topic.
  it('releases the hold when completing inbox-expectations also completed the onboarding task', async () => {
    const w = makeWorld('done', [], 'done');
    const result = await w.run();
    expect(result.success).toBe(true);
    expect(w.onboardingService.releaseTriageHold).toHaveBeenCalledTimes(1);
  });

  it('still refuses a declined inbox-expectations on a completed onboarding task', async () => {
    const w = makeWorld('done', ['onboarding:declined'], 'done');
    const result = await w.run();
    expect(result.success).toBe(false);
    expect(w.onboardingService.releaseTriageHold).not.toHaveBeenCalled();
  });

  it('refuses when the run was cancelled', async () => {
    const w = makeWorld('done', [], 'cancelled');
    const result = await w.run();
    expect(result.success).toBe(false);
    expect(w.onboardingService.releaseTriageHold).not.toHaveBeenCalled();
  });
});
