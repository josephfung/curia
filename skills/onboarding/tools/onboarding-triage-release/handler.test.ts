import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { OnboardingTriageReleaseHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { TaskRow } from '../../../../src/db/queries/tasks.js';
import type { ListTasksFilters } from '../../../../src/db/task-repo.js';

const logger = pino({ level: 'silent' });

function makeWorld(inboxStatus: string, extraTags: string[] = []) {
  const tasks = [
    { id: 'parent', status: 'open', tags: ['onboarding'], parentTaskId: null, createdBy: 'onboarding' },
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
  };
  const onboardingService = { releaseTriageHold: vi.fn(async () => {}) };
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
});
