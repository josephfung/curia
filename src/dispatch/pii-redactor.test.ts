import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PiiRedactor } from './pii-redactor.js';
import { createSilentLogger } from '../logger.js';
import type { Logger } from '../logger.js';
import type { EventBus } from '../bus/bus.js';

// Minimal mock bus satisfying the EventBus.publish() interface that PiiRedactor uses.
// PiiRedactor only calls bus.publish(layer, event) — we don't need subscribe or constructor args.
function createMockBus() {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
  } as unknown as EventBus;
}

const defaultConfig = {
  enabled: true,
  trust_override: ['ceo'],
  default: 'block' as const,
  channel_policies: {
    email: { allow: ['email'] },
    signal: { allow: [] },
  },
};

describe('PiiRedactor', () => {
  let bus: EventBus;
  let mockBusPublish: ReturnType<typeof vi.fn>;
  let redactor: PiiRedactor;
  let logger: Logger;

  beforeEach(() => {
    bus = createMockBus();
    // Cast to access the mock publish for assertion purposes
    mockBusPublish = (bus as unknown as { publish: ReturnType<typeof vi.fn> }).publish;
    logger = createSilentLogger();
    redactor = new PiiRedactor({
      config: defaultConfig,
      bus,
      logger,
      extraPatterns: [],
    });
  });

  it('redacts a credit card number on email channel', async () => {
    const result = await redactor.redact('Your card is 4111 1111 1111 1111.', 'email', 'medium');
    expect(result.content).toContain('[REDACTED: CREDIT_CARD]');
    expect(result.content).not.toContain('4111');
    expect(result.redactions).toHaveLength(1);
    expect(result.redactions[0]!.patternLabel).toMatch(/credit_card/i);
  });

  it('allows email addresses in email channel (in allow list)', async () => {
    const result = await redactor.redact('Contact user@example.com for help.', 'email', 'medium');
    expect(result.content).toContain('user@example.com');
    expect(result.redactions).toHaveLength(0);
  });

  it('redacts email addresses in signal channel (not in allow list)', async () => {
    const result = await redactor.redact('Contact user@example.com for help.', 'signal', 'medium');
    expect(result.content).toContain('[REDACTED:');
    expect(result.content).not.toContain('user@example.com');
  });

  it('bypasses redaction for CEO trust level', async () => {
    const result = await redactor.redact('Your card is 4111 1111 1111 1111.', 'email', 'ceo');
    expect(result.content).toContain('4111 1111 1111 1111');
    expect(result.redactions).toHaveLength(0);
  });

  it('bypasses redaction when disabled', async () => {
    const disabled = new PiiRedactor({
      config: { ...defaultConfig, enabled: false },
      bus,
      logger,
      extraPatterns: [],
    });
    const result = await disabled.redact('Card: 4111 1111 1111 1111', 'email', 'medium');
    expect(result.content).toContain('4111');
  });

  it('blocks all PII on unlisted channels (default: block)', async () => {
    // 'sms' is not in channel_policies; default is 'block', so email PII must be redacted
    const result = await redactor.redact('Contact user@example.com', 'sms', 'medium');
    expect(result.content).toContain('[REDACTED:');
  });

  it('returns original content when no PII detected', async () => {
    const text = 'Just a normal message.';
    const result = await redactor.redact(text, 'email', 'medium');
    expect(result.content).toBe(text);
    expect(result.redactions).toHaveLength(0);
  });

  it('does not publish bus event when no redactions', async () => {
    await redactor.redact('Clean message', 'email', 'medium');
    expect(mockBusPublish).not.toHaveBeenCalled();
  });

  it('publishes outbound.pii-redacted event on redaction', async () => {
    await redactor.redact(
      'Card: 4111 1111 1111 1111',
      'email',
      'medium',
      { conversationId: 'conv-1', recipientId: 'r@example.com' },
    );
    expect(mockBusPublish).toHaveBeenCalledWith(
      'dispatch',
      expect.objectContaining({ type: 'outbound.pii-redacted' }),
    );
  });

  it('does not publish bus event for CEO bypass', async () => {
    await redactor.redact('Card: 4111 1111 1111 1111', 'email', 'ceo');
    expect(mockBusPublish).not.toHaveBeenCalled();
  });

  it('null trust level is treated as untrusted (PII redacted)', async () => {
    const result = await redactor.redact('Card: 4111 1111 1111 1111', 'email', null);
    expect(result.content).toContain('[REDACTED:');
  });

  it('redaction entries do not contain the original PII value', async () => {
    const result = await redactor.redact('Card: 4111 1111 1111 1111', 'email', 'medium');
    expect(JSON.stringify(result.redactions)).not.toContain('4111');
  });
});
