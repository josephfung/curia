// card-use-service.test.ts — decline, and the row helper (#1358). request/confirm are covered
// beside the tools in skills/web/tools/card-use-*/handler.test.ts.

import { describe, it, expect, vi } from 'vitest';
import { CardUseService, cardUseRequestIdOf } from '../../../src/secrets/card-use-service.js';
import type { CardUseRepo, CardUseRequestRow } from '../../../src/secrets/card-use-repo.js';
import { createSilentLogger } from '../../../src/logger.js';

const ROW: CardUseRequestRow = {
  id: 'req-1',
  secretName: 'user.visa',
  last4: '1111',
  siteDomain: 'aircanada.com',
  conversationId: 'conv-1',
  taskId: 'task-1',
  amount: 'CA$412.30',
  purpose: 'Air Canada YYZ-SFO, Dec 12',
  origin: { conversationId: 'conv-1', channelId: 'signal', agentId: 'coordinator' },
  status: 'pending',
  approvalShortRef: 'abcd1234',
  createdAt: new Date(),
  approvedAt: null,
};

function setup(decideResult = true) {
  const decide = vi.fn().mockResolvedValue(decideResult);
  const get = vi.fn().mockResolvedValue(ROW);
  const publish = vi.fn().mockResolvedValue(undefined);
  const service = new CardUseService({
    repo: { decide, get } as unknown as CardUseRepo,
    secrets: { getCardPublic: vi.fn() },
    approvalTrigger: { request: vi.fn() },
    bus: { publish },
    logger: createSilentLogger(),
  });
  return { service, decide, get, publish };
}

describe('CardUseService.decline', () => {
  it('declines the card-use request and resumes', async () => {
    const { service, decide, publish } = setup();
    await service.decline('req-1');
    expect(decide).toHaveBeenCalledWith('req-1', 'denied');
    expect(publish).toHaveBeenCalledWith('execution', expect.objectContaining({
      type: 'card_use.decided',
      payload: expect.objectContaining({ requestId: 'req-1', decision: 'denied', resume: true, origin: ROW.origin, purpose: ROW.purpose }),
    }));
  });

  it('records an expiry as expired', async () => {
    const { service, decide, publish } = setup();
    await service.decline('req-1', 'expired');
    expect(decide).toHaveBeenCalledWith('req-1', 'expired');
    expect(publish.mock.calls[0]![1].payload.decision).toBe('expired');
  });

  it('publishes nothing when the request was no longer pending', async () => {
    const { service, publish } = setup(false);
    await service.decline('req-1');
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not throw when the resume cannot be published', async () => {
    const { service, publish } = setup();
    publish.mockRejectedValue(new Error('bus down'));
    await expect(service.decline('req-1')).resolves.toBeUndefined();
  });
});

describe('cardUseRequestIdOf', () => {
  it('reads the request id from a card-use-confirm row only', () => {
    expect(cardUseRequestIdOf({ toolName: 'card-use-confirm', payload: { request_id: 'req-1' } })).toBe('req-1');
    expect(cardUseRequestIdOf({ toolName: 'card-use-confirm', payload: null })).toBeNull();
    expect(cardUseRequestIdOf({ toolName: 'card-use-confirm', payload: { request_id: 5 } })).toBeNull();
    expect(cardUseRequestIdOf({ toolName: 'email-send', payload: { request_id: 'req-1' } })).toBeNull();
  });
});
