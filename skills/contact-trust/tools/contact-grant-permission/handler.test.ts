// contact-grant-permission: refuse while a matching recommendation is pending (#2764 / 33j).

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { ContactGrantPermissionHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { GrantRecommendation } from '../../../../src/contacts/types.js';

const CONTACT_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const REC_ID = '33333333-3333-4333-8333-333333333333';

function pendingRec(): GrantRecommendation {
  return {
    id: REC_ID,
    contactId: CONTACT_ID,
    permission: 'schedule_meetings',
    reasoning: 'Regular calendar coordination.',
    status: 'pending',
    suggestedAt: new Date(),
    resolvedAt: null,
    resolvedBy: null,
  };
}

function run(opts: {
  findResult: GrantRecommendation | null;
  granted?: boolean;
}) {
  const contactService = {
    findGrantRecommendation: vi.fn().mockResolvedValue(opts.findResult),
    grantPermission: vi.fn().mockResolvedValue(undefined),
  };
  const ctx = {
    toolName: 'contact-grant-permission',
    toolVersion: '1.1.2',
    input: {
      contact_id: CONTACT_ID,
      permission: 'schedule_meetings',
      granted: opts.granted ?? true,
    },
    secret: () => { throw new Error('no secrets'); },
    log: pino({ level: 'silent' }),
    contactService: contactService as unknown as ToolContext['contactService'],
    caller: { contactId: ACTOR_ID },
  } as unknown as ToolContext;
  return { contactService, result: new ContactGrantPermissionHandler().execute(ctx) };
}

describe('ContactGrantPermissionHandler pending-recommendation guard (#2764)', () => {
  it('refuses a grant when a matching recommendation is still pending', async () => {
    const { contactService, result } = run({ findResult: pendingRec() });
    const out = await result;
    expect(out.success).toBe(false);
    if (out.success) throw new Error('expected refusal');
    expect(out.error).toMatch(/approve-grant-recommendation/);
    expect(out.error).toContain(REC_ID);
    expect(contactService.grantPermission).not.toHaveBeenCalled();
  });

  it('refuses a deny when a matching recommendation is still pending', async () => {
    const { contactService, result } = run({ findResult: pendingRec(), granted: false });
    const out = await result;
    expect(out.success).toBe(false);
    if (out.success) throw new Error('expected refusal');
    expect(out.error).toMatch(/decline-grant-recommendation/);
    expect(contactService.grantPermission).not.toHaveBeenCalled();
  });

  it('grants when the principal asks and no pending recommendation matches', async () => {
    const { contactService, result } = run({ findResult: null });
    await expect(result).resolves.toMatchObject({
      success: true,
      data: { contact_id: CONTACT_ID, permission: 'schedule_meetings', granted: true },
    });
    expect(contactService.grantPermission).toHaveBeenCalledWith(
      CONTACT_ID,
      'schedule_meetings',
      true,
      ACTOR_ID,
    );
  });

  it('grants when a prior recommendation was already resolved', async () => {
    const resolved = { ...pendingRec(), status: 'approved' as const };
    const { contactService, result } = run({ findResult: resolved });
    await expect(result).resolves.toMatchObject({ success: true });
    expect(contactService.grantPermission).toHaveBeenCalled();
  });
});
