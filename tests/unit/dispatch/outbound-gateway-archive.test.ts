import { describe, it, expect, vi } from 'vitest';
import { OutboundGateway } from '../../../src/skills/outbound-gateway.js';
import type { NylasClient } from '../../../src/channels/email/nylas-client.js';
import type { ContactService } from '../../../src/contacts/contact-service.js';
import { EventBus } from '../../../src/bus/bus.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeGateway(nylasClients: Map<string, NylasClient>): OutboundGateway {
  const bus = new EventBus(logger);
  return new OutboundGateway({
    nylasClients,
    contactService: {} as ContactService,
    contentFilter: { check: vi.fn().mockResolvedValue({ passed: true, findings: [] }) } as never,
    bus,
    logger,
  });
}

function makeMockNylasClient(): NylasClient {
  return {
    archiveMessage: vi.fn().mockResolvedValue(undefined),
    getMessage: vi.fn(),
    listMessages: vi.fn(),
    sendMessage: vi.fn(),
    createDraft: vi.fn(),
  } as unknown as NylasClient;
}

describe('OutboundGateway.archiveEmailMessage', () => {
  it('calls archiveMessage on the correct account client', async () => {
    const mockClient = makeMockNylasClient();
    const gateway = makeGateway(new Map([['joseph', mockClient]]));

    const result = await gateway.archiveEmailMessage('msg-1', 'joseph');

    expect(result.success).toBe(true);
    expect(mockClient.archiveMessage).toHaveBeenCalledWith('msg-1');
  });

  it('uses the primary client when accountId is omitted', async () => {
    const mockClient = makeMockNylasClient();
    const gateway = makeGateway(new Map([['curia', mockClient]]));

    const result = await gateway.archiveEmailMessage('msg-1');

    expect(result.success).toBe(true);
    expect(mockClient.archiveMessage).toHaveBeenCalledWith('msg-1');
  });

  it('returns failure when the accountId is not found in the map', async () => {
    const gateway = makeGateway(new Map([['curia', makeMockNylasClient()]]));

    const result = await gateway.archiveEmailMessage('msg-1', 'unknown-account');

    expect(result.success).toBe(false);
    expect(result.error).toContain('No email client configured');
  });

  it('returns failure when no clients are configured at all', async () => {
    const gateway = makeGateway(new Map());

    const result = await gateway.archiveEmailMessage('msg-1');

    expect(result.success).toBe(false);
  });

  it('returns failure when archiveMessage throws', async () => {
    const mockClient = makeMockNylasClient();
    (mockClient.archiveMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Nylas 503'));
    const gateway = makeGateway(new Map([['joseph', mockClient]]));

    const result = await gateway.archiveEmailMessage('msg-1', 'joseph');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Archive failed');
  });
});
