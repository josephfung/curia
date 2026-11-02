import { describe, it, expect } from 'vitest';
import { handoffsFromPayload, taskHandoffFromCall } from '../../../src/agents/task-handoffs.js';
import { shapeSpecialistAnswer } from '../../../src/agents/specialist-answer.js';
import { DRAFT_EMAIL_NEXT_STEP, HANDOFF_NEXT_STEP } from '../../../src/agents/prompts/delegate-result-guidance.js';

const CREATED = { task_id: 'task-1', title: 'Book dinner Wednesday' };

describe('taskHandoffFromCall (#2431)', () => {
  it('records a specialist task-create that targets the coordinator', () => {
    expect(taskHandoffFromCall('meeting-debrief', 'task-create', { title: 'x', target_agent_id: 'coordinator' }, CREATED))
      .toEqual(CREATED);
  });

  it('ignores a self-owned task, another target, and other tools', () => {
    expect(taskHandoffFromCall('meeting-debrief', 'task-create', { title: 'x' }, CREATED)).toBeNull();
    expect(taskHandoffFromCall('meeting-debrief', 'task-create', { target_agent_id: 'calendar' }, CREATED)).toBeNull();
    expect(taskHandoffFromCall('meeting-debrief', 'task-update', { target_agent_id: 'coordinator' }, CREATED)).toBeNull();
  });

  it('carries the description the specialist wrote', () => {
    expect(taskHandoffFromCall(
      'meeting-debrief', 'task-create',
      { target_agent_id: 'coordinator', description: 'Principal: "draft an email to Sam"' },
      CREATED,
    )).toEqual({ ...CREATED, description: 'Principal: "draft an email to Sam"' });
  });

  it("never counts the coordinator's own tasks", () => {
    expect(taskHandoffFromCall('coordinator', 'task-create', { target_agent_id: 'coordinator' }, CREATED)).toBeNull();
  });

  it('ignores a result with no task_id', () => {
    expect(taskHandoffFromCall('meeting-debrief', 'task-create', { target_agent_id: 'coordinator' }, {})).toBeNull();
  });
});

describe('handoffsFromPayload', () => {
  it('reads well-formed hand-offs and rejects anything else', () => {
    expect(handoffsFromPayload({ handoffs: [CREATED] })).toEqual([CREATED]);
    expect(handoffsFromPayload({})).toBeUndefined();
    expect(handoffsFromPayload({ handoffs: [{ task_id: 1 }] })).toBeUndefined();
  });
});

describe('shapeSpecialistAnswer hand-offs', () => {
  it('lists hand-offs with their next step', () => {
    const answer = shapeSpecialistAnswer('Recorded it.', [], '', [CREATED]);
    expect(answer.handed_off_tasks).toEqual([CREATED]);
    expect(answer.next_step).toBe(HANDOFF_NEXT_STEP);
  });

  it('puts the hand-off step before a draft-email step', () => {
    const answer = shapeSpecialistAnswer('<scheduling_email subject="Hi">Body</scheduling_email>', [], '', [CREATED]);
    expect(answer.next_step).toBe(`${HANDOFF_NEXT_STEP} ${DRAFT_EMAIL_NEXT_STEP}`);
  });

  it('adds nothing for an empty list', () => {
    const answer = shapeSpecialistAnswer('Done.', [], '', []);
    expect(answer).not.toHaveProperty('handed_off_tasks');
    expect(answer.next_step).toBeUndefined();
  });
});
