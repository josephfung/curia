import type { VoiceCallerContext } from './caller-context.js';
import { VOICE_CONSOLE_SENDER_ID } from './caller-context.js';
import { buildPrincipalSenderContext } from '../../contacts/build-principal-sender-context.js';
import { createSilentLogger } from '../../logger.js';

const PRINCIPAL_ID = '11111111-1111-1111-1111-111111111111';
const silentLogger = createSilentLogger();

/** Principal console caller fixture for adapter / bridge tests. */
export function principalCaller(overrides: Partial<VoiceCallerContext> = {}): VoiceCallerContext {
  const contactId = overrides.contactId ?? PRINCIPAL_ID;
  const displayName = overrides.displayName ?? 'Joseph';
  const senderContext = buildPrincipalSenderContext(
    {
      id: contactId,
      displayName,
      role: 'ceo',
      systemRole: 'principal',
      kgNodeId: null,
      kind: 'principal',
    },
    silentLogger,
  );
  return {
    contactId,
    displayName: senderContext.displayName,
    systemRole: 'principal',
    tier: 'principal',
    liveTurn: true,
    originator: {
      contactId,
      systemRole: 'principal',
      channel: 'voice',
      initiatedAt: '2026-07-29T12:00:00.000Z',
      tier: 'principal',
    },
    senderId: VOICE_CONSOLE_SENDER_ID,
    senderContext,
    ...overrides,
  };
}

/** Non-principal caller fixture (liveTurn=false). */
export function partnerCaller(overrides: Partial<VoiceCallerContext> = {}): VoiceCallerContext {
  const contactId = overrides.contactId ?? '22222222-2222-2222-2222-222222222222';
  const senderContext = {
    resolved: true as const,
    contactId,
    displayName: overrides.displayName ?? 'Alex Partner',
    role: 'partner',
    systemRole: null,
    verified: true,
    kgNodeId: null,
    knowledgeSummary: '',
    authorization: null,
    contactConfidence: 0.9,
    tier: 'trusted' as const,
    kind: 'person' as const,
  };
  return {
    contactId,
    displayName: senderContext.displayName,
    systemRole: null,
    tier: 'trusted',
    liveTurn: false,
    originator: {
      contactId,
      systemRole: null,
      channel: 'voice',
      initiatedAt: '2026-07-29T12:00:00.000Z',
      tier: 'trusted',
    },
    senderId: contactId,
    senderContext,
    ...overrides,
  };
}
