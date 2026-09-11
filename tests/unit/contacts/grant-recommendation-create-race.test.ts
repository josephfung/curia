// Regression tests for issue #1067: createGrantRecommendation must not return
// `{ created: true }` with a locally constructed UUID that was never persisted.
//
// JS is single-threaded, so Promise.all interleaves at every `await`. The previous
// check-then-insert path let both callers observe "no existing row" before either
// write landed; the loser then returned created:true with a phantom id. The insert
// result is now authoritative, so the same interleaving is the regression.

import { describe, it, beforeEach } from 'vitest';
import { ContactService } from '../../../src/contacts/contact-service.js';
import {
  assertConcurrentCreateGrantRecommendationRace,
  assertSequentialCreateGrantRecommendationDedup,
} from '../../helpers/grant-recommendation-create-race.js';

describe('createGrantRecommendation race (issue #1067, in-memory)', () => {
  let service: ContactService;

  beforeEach(() => {
    service = ContactService.createInMemory();
  });

  it('concurrent creates persist one row; loser returns the winner\'s real id', async () => {
    const contact = await service.createContact({
      displayName: 'Grant Rec Create Race',
      source: 'test',
    });
    await assertConcurrentCreateGrantRecommendationRace(service, contact.id);
  });

  it('sequential duplicate returns created:false with the persisted winner', async () => {
    const contact = await service.createContact({
      displayName: 'Grant Rec Sequential Dedup',
      source: 'test',
    });
    await assertSequentialCreateGrantRecommendationDedup(service, contact.id);
  });
});
