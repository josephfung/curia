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
 * row. The loser returns created:false with the winner's real id; both returned
 * ids resolve via getGrantRecommendation.
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

  expect(await service.getGrantRecommendation(first.recommendation.id)).not.toBeNull();
  expect(await service.getGrantRecommendation(second.recommendation.id)).not.toBeNull();

  const listed = (await service.listGrantRecommendations()).filter(
    (r) => r.contactId === contactId && r.permission === GRANT_REC_RACE_PERMISSION,
  );
  expect(listed).toHaveLength(1);
  expect(listed[0].id).toBe(winner.recommendation.id);
}

/**
 * A sequential duplicate must also surface the persisted row, not a locally
 * constructed object. This is the non-racy path of the same ON CONFLICT skip.
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
