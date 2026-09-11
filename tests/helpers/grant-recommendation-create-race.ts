/**
 * Shared assertions for issue #1067: createGrantRecommendation must never return
 * `{ created: true }` with a UUID that was not persisted. Both the in-memory and
 * Postgres backends run these checks so a regression in either cannot slip through.
 */

import { expect } from 'vitest';
import type { ContactService } from '../../src/contacts/contact-service.js';

export const GRANT_REC_RACE_PERMISSION = 'schedule_meetings';

/**
 * Two concurrent creates for the same (contact, permission) persist exactly one
 * row. The loser returns created:false with the winner's real id, and that id
 * resolves via getGrantRecommendation.
 */
export async function assertConcurrentCreateGrantRecommendationRace(
  service: ContactService,
  contactId: string,
): Promise<void> {
  const [first, second] = await Promise.all([
    service.createGrantRecommendation(contactId, GRANT_REC_RACE_PERMISSION, 'reason-a'),
    service.createGrantRecommendation(contactId, GRANT_REC_RACE_PERMISSION, 'reason-b'),
  ]);

  expect(first.created !== second.created).toBe(true);

  const winner = first.created ? first : second;
  const loser = first.created ? second : first;

  expect(winner.created).toBe(true);
  expect(loser.created).toBe(false);
  expect(loser.recommendation.id).toBe(winner.recommendation.id);
  expect(await service.getGrantRecommendation(winner.recommendation.id)).not.toBeNull();

  const listed = (await service.listGrantRecommendations()).filter(
    (r) => r.contactId === contactId && r.permission === GRANT_REC_RACE_PERMISSION,
  );
  expect(listed).toHaveLength(1);
  expect(listed[0].id).toBe(winner.recommendation.id);
}

/**
 * Sequential duplicate against a still-pending row. This is a characterization of
 * the ON CONFLICT skip path; the old pre-insert find already handled it, so it is
 * not regression coverage for #1067.
 */
export async function assertSequentialCreateGrantRecommendationDedup(
  service: ContactService,
  contactId: string,
): Promise<void> {
  const first = await service.createGrantRecommendation(
    contactId, GRANT_REC_RACE_PERMISSION, 'first-reason',
  );
  expect(first.created).toBe(true);

  const second = await service.createGrantRecommendation(
    contactId, GRANT_REC_RACE_PERMISSION, 'second-reason',
  );
  expect(second.created).toBe(false);
  expect(second.recommendation.id).toBe(first.recommendation.id);
  expect(second.recommendation.reasoning).toBe('first-reason');
  expect(await service.getGrantRecommendation(second.recommendation.id)).not.toBeNull();
}

/**
 * UNIQUE (contact_id, permission) spans every status, so the common production
 * dedup is against an approved or declined ledger row. Create → decline → create
 * must return the declined row, not resurrect a pending recommendation.
 */
export async function assertCreateAgainstDeclinedGrantRecommendation(
  service: ContactService,
  contactId: string,
): Promise<void> {
  const first = await service.createGrantRecommendation(
    contactId, GRANT_REC_RACE_PERMISSION, 'original-reason',
  );
  expect(first.created).toBe(true);

  const declined = await service.declineGrantRecommendation(
    first.recommendation.id, 'actor-decline',
  );
  expect(declined).toBe(true);

  const second = await service.createGrantRecommendation(
    contactId, GRANT_REC_RACE_PERMISSION, 'should-not-write',
  );
  expect(second.created).toBe(false);
  expect(second.recommendation.id).toBe(first.recommendation.id);
  expect(second.recommendation.status).toBe('declined');
  expect(second.recommendation.reasoning).toBe('original-reason');
  expect(second.recommendation.resolvedBy).toBe('actor-decline');
  expect(second.recommendation.resolvedAt).not.toBeNull();
}
