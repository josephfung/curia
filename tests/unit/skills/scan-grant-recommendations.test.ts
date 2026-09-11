// Regression for issue #1067: createGrantRecommendation can throw when ON CONFLICT
// skips the insert and the winner vanishes before re-fetch. The scan loop must
// treat that like the other per-contact failures so earlier creates still report.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { ScanGrantRecommendationsHandler } from '../../../skills/contacts/tools/scan-grant-recommendations/handler.js';
import type { ToolContext } from '../../../src/skills/types.js';
import type { Contact } from '../../../src/contacts/types.js';
import type { GrantRecommendation } from '../../../src/contacts/types.js';

const logger = pino({ level: 'silent' });

function makeContact(id: string, displayName: string): Contact {
  return {
    id,
    kgNodeId: null,
    displayName,
    role: 'Advisor',
    systemRole: null,
    tier: 'known',
    kind: 'person',
    contactConfidence: 0.9,
    lastSeenAt: null,
    inboundMessageCount: 12,
    outboundMessageCount: 8,
    notes: null,
    preferredName: null,
    title: null,
    organization: null,
    primaryEmail: null,
    primaryPhone: null,
    timezone: null,
    locale: null,
    location: null,
    pronouns: null,
    linkedinUrl: null,
    bio: null,
    birthday: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeCtx(contactService: unknown): ToolContext {
  return {
    toolName: 'scan-grant-recommendations',
    toolVersion: '0.1.1',
    input: { cadence_ceiling: 3, max_candidates: 20 },
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    contactService: contactService as ToolContext['contactService'],
    infraLlm: {
      classify: vi.fn(),
      extract: vi.fn().mockResolvedValue({
        ok: true,
        text: JSON.stringify({ recommend: true, reasoning: 'Regular calendar coordination.' }),
      }),
    },
  };
}

describe('ScanGrantRecommendationsHandler create failures (issue #1067)', () => {
  it('skips a throwing create and still reports recommendations created earlier in the run', async () => {
    const first = makeContact('11111111-1111-4111-8111-111111111111', 'First Contact');
    const second = makeContact('22222222-2222-4222-8222-222222222222', 'Second Contact');
    const persisted: GrantRecommendation = {
      id: '33333333-3333-4333-8333-333333333333',
      contactId: first.id,
      permission: 'schedule_meetings',
      reasoning: 'Regular calendar coordination.',
      status: 'pending',
      suggestedAt: new Date(),
      resolvedAt: null,
      resolvedBy: null,
    };

    const contactService = {
      listContacts: vi.fn().mockResolvedValue([first, second]),
      listGrantRecommendations: vi.fn().mockResolvedValue([]),
      getAuthOverrides: vi.fn().mockResolvedValue([]),
      createGrantRecommendation: vi.fn()
        .mockResolvedValueOnce({ created: true, recommendation: persisted })
        .mockRejectedValueOnce(new Error(
          `Grant recommendation conflict for ${second.id}/schedule_meetings but no existing row found`,
        )),
    };

    const result = await new ScanGrantRecommendationsHandler().execute(makeCtx(contactService));

    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as {
      evaluated: number;
      created: number;
      skipped_errors: number;
      skipped_existing: number;
      skipped_judge: number;
      recommendations_created: Array<{
        id: string;
        contact_id: string;
        contact_name: string;
        permission: string;
        reasoning: string;
      }>;
    };
    expect(data).toMatchObject({
      evaluated: 2,
      created: 1,
      skipped_errors: 1,
      skipped_existing: 0,
      skipped_judge: 0,
    });
    expect(data.recommendations_created).toEqual([
      {
        id: persisted.id,
        contact_id: first.id,
        contact_name: first.displayName,
        permission: 'schedule_meetings',
        reasoning: 'Regular calendar coordination.',
      },
    ]);
    expect(contactService.createGrantRecommendation).toHaveBeenCalledTimes(2);
  });
});
