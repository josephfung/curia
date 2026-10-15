// A retry after a failed task-complete must not dead-end on "already approved" (#2129).

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { ApproveGrantRecommendationHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { GrantRecommendation } from '../../../../src/contacts/types.js';

const REC_ID = '33333333-3333-4333-8333-333333333333';
const ACTOR_ID = '11111111-1111-4111-8111-111111111111';

function rec(status: GrantRecommendation['status']): GrantRecommendation {
  return {
    id: REC_ID,
    contactId: '22222222-2222-4222-8222-222222222222',
    permission: 'schedule_meetings',
    reasoning: 'Regular calendar coordination.',
    status,
    suggestedAt: new Date(),
    resolvedAt: null,
    resolvedBy: null,
  };
}

function run(status: GrantRecommendation['status']) {
  const contactService = {
    getGrantRecommendation: vi.fn().mockResolvedValue(rec(status)),
    approveGrantRecommendation: vi.fn().mockResolvedValue(true),
  };
  const ctx = {
    toolName: 'approve-grant-recommendation',
    toolVersion: '0.1.4',
    input: { recommendation_id: REC_ID },
    secret: () => { throw new Error('no secrets'); },
    log: pino({ level: 'silent' }),
    contactService: contactService as unknown as ToolContext['contactService'],
    caller: { contactId: ACTOR_ID },
  } as unknown as ToolContext;
  return { contactService, result: new ApproveGrantRecommendationHandler().execute(ctx) };
}

describe('ApproveGrantRecommendationHandler', () => {
  it('approves a pending recommendation', async () => {
    const { contactService, result } = run('pending');
    expect(await result).toMatchObject({ success: true, data: { status: 'approved' } });
    expect(contactService.approveGrantRecommendation).toHaveBeenCalledWith(REC_ID, ACTOR_ID);
  });

  it('reports success without changing anything when it is already approved', async () => {
    const { contactService, result } = run('approved');
    expect(await result).toMatchObject({ success: true, data: { status: 'approved', already_resolved: true } });
    expect(contactService.approveGrantRecommendation).not.toHaveBeenCalled();
  });

  it('refuses a recommendation already declined', async () => {
    const { contactService, result } = run('declined');
    expect(await result).toMatchObject({ success: false });
    expect(contactService.approveGrantRecommendation).not.toHaveBeenCalled();
  });
});
