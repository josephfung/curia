import { describe, it, expect } from 'vitest';
import {
  convertSignalEnvelope,
  convertSignalReaction,
} from '../../../../src/channels/signal/message-converter.js';
import type { SignalEnvelope } from '../../../../src/channels/signal/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEnvelope(overrides: Partial<SignalEnvelope> = {}): SignalEnvelope {
  return {
    source: '+14155551234',
    sourceNumber: '+14155551234',
    sourceUuid: 'uuid-123',
    sourceName: 'Alice',
    sourceDevice: 1,
    timestamp: 1700000000000,
    dataMessage: {
      timestamp: 1700000000000,
      message: 'Hello there',
      expiresInSeconds: 0,
      viewOnce: false,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('convertSignalEnvelope', () => {
  it('converts a 1:1 text message', () => {
    const result = convertSignalEnvelope(makeEnvelope());
    expect(result).not.toBeNull();
    expect(result!.conversationId).toBe('signal:+14155551234');
    expect(result!.channelId).toBe('signal');
    expect(result!.senderId).toBe('+14155551234');
    expect(result!.content).toBe('Hello there');
    expect(result!.metadata.isGroup).toBe(false);
    expect(result!.metadata.groupId).toBeUndefined();
    expect(result!.metadata.signalTimestamp).toBe(1700000000000);
    expect(result!.metadata.sourceName).toBe('Alice');
    expect(result!.metadata.sourceUuid).toBe('uuid-123');
  });

  it('converts a group text message', () => {
    const result = convertSignalEnvelope(makeEnvelope({
      dataMessage: {
        timestamp: 1700000000000,
        message: 'Team meeting at 3pm',
        expiresInSeconds: 0,
        viewOnce: false,
        groupInfo: { groupId: 'abc123==', type: 'DELIVER' },
      },
    }));
    expect(result).not.toBeNull();
    expect(result!.conversationId).toBe('signal:group=abc123==');
    expect(result!.metadata.isGroup).toBe(true);
    expect(result!.metadata.groupId).toBe('abc123==');
  });

  it('trims leading and trailing whitespace from message content', () => {
    const result = convertSignalEnvelope(makeEnvelope({
      dataMessage: {
        timestamp: 1700000000000,
        message: '  hello world  ',
        expiresInSeconds: 0,
        viewOnce: false,
      },
    }));
    expect(result!.content).toBe('hello world');
  });

  it('includes attachments in metadata when present', () => {
    const result = convertSignalEnvelope(makeEnvelope({
      dataMessage: {
        timestamp: 1700000000000,
        message: 'See attached',
        expiresInSeconds: 0,
        viewOnce: false,
        attachments: [{ id: 'att1', contentType: 'image/png', filename: 'photo.png', size: 12345 }],
      },
    }));
    expect(result!.metadata.attachments).toHaveLength(1);
    expect(result!.metadata.attachments![0].id).toBe('att1');
  });

  it('omits attachments from metadata when array is empty', () => {
    const result = convertSignalEnvelope(makeEnvelope({
      dataMessage: {
        timestamp: 1700000000000,
        message: 'No attachments',
        expiresInSeconds: 0,
        viewOnce: false,
        attachments: [],
      },
    }));
    expect(result!.metadata.attachments).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Ignored envelope types
  // ---------------------------------------------------------------------------

  it('returns null for a sync message (self-sent from another device)', () => {
    const result = convertSignalEnvelope(makeEnvelope({
      dataMessage: undefined,
      syncMessage: { sentMessage: { message: 'sent from my phone' } },
    }));
    expect(result).toBeNull();
  });

  it('returns null for a reaction (handled by convertSignalReaction)', () => {
    const result = convertSignalEnvelope(makeEnvelope({
      dataMessage: {
        timestamp: 1700000000000,
        message: null,
        expiresInSeconds: 0,
        viewOnce: false,
        reaction: {
          emoji: '👍',
          targetAuthor: '+14155559999',
          targetTimestamp: 1699999999999,
          isRemove: false,
        },
      },
    }));
    expect(result).toBeNull();
  });

  it('returns null for a view-once message', () => {
    const result = convertSignalEnvelope(makeEnvelope({
      dataMessage: {
        timestamp: 1700000000000,
        message: 'secret',
        expiresInSeconds: 0,
        viewOnce: true,
      },
    }));
    expect(result).toBeNull();
  });

  it('returns null when dataMessage is missing', () => {
    const result = convertSignalEnvelope(makeEnvelope({ dataMessage: undefined }));
    expect(result).toBeNull();
  });

  it('returns null when message text is null', () => {
    const result = convertSignalEnvelope(makeEnvelope({
      dataMessage: {
        timestamp: 1700000000000,
        message: null,
        expiresInSeconds: 0,
        viewOnce: false,
      },
    }));
    expect(result).toBeNull();
  });

  it('returns null when message text is empty after trimming', () => {
    const result = convertSignalEnvelope(makeEnvelope({
      dataMessage: {
        timestamp: 1700000000000,
        message: '   ',
        expiresInSeconds: 0,
        viewOnce: false,
      },
    }));
    expect(result).toBeNull();
  });

  it('converts an audio-only voice note with empty text', () => {
    const result = convertSignalEnvelope(makeEnvelope({
      dataMessage: {
        timestamp: 1700000000000,
        message: null,
        expiresInSeconds: 0,
        viewOnce: false,
        attachments: [{
          id: 'att-voice',
          contentType: 'audio/ogg',
          size: 12,
          isVoiceNote: true,
        }],
      },
    }));
    expect(result).not.toBeNull();
    expect(result!.content).toBe('');
    expect(result!.metadata.attachments).toHaveLength(1);
  });

  it('returns null for a group UPDATE event (management, not a message)', () => {
    const result = convertSignalEnvelope(makeEnvelope({
      dataMessage: {
        timestamp: 1700000000000,
        message: null,
        expiresInSeconds: 0,
        viewOnce: false,
        groupInfo: { groupId: 'abc123==', type: 'UPDATE' },
      },
    }));
    expect(result).toBeNull();
  });

  it('returns null for a group QUIT event', () => {
    const result = convertSignalEnvelope(makeEnvelope({
      dataMessage: {
        timestamp: 1700000000000,
        message: null,
        expiresInSeconds: 0,
        viewOnce: false,
        groupInfo: { groupId: 'abc123==', type: 'QUIT' },
      },
    }));
    expect(result).toBeNull();
  });

  it('returns null for a group UNKNOWN event', () => {
    const result = convertSignalEnvelope(makeEnvelope({
      dataMessage: {
        timestamp: 1700000000000,
        message: null,
        expiresInSeconds: 0,
        viewOnce: false,
        groupInfo: { groupId: 'abc123==', type: 'UNKNOWN' },
      },
    }));
    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Conversation ID format
  // ---------------------------------------------------------------------------

  it('uses group= prefix for group conversation IDs to prevent collisions with phone numbers', () => {
    const result = convertSignalEnvelope(makeEnvelope({
      dataMessage: {
        timestamp: 1700000000000,
        message: 'hi group',
        expiresInSeconds: 0,
        viewOnce: false,
        groupInfo: { groupId: 'groupIdBase64==', type: 'DELIVER' },
      },
    }));
    expect(result!.conversationId).toMatch(/^signal:group=/);
  });

  it('uses the E.164 number directly for 1:1 conversation IDs', () => {
    const result = convertSignalEnvelope(makeEnvelope({ sourceNumber: '+14155559999' }));
    expect(result!.conversationId).toBe('signal:+14155559999');
  });

  it('falls back to sourceUuid for ACI-only 1:1 senders', () => {
    const result = convertSignalEnvelope(makeEnvelope({
      source: '',
      sourceNumber: '',
      sourceUuid: 'aci-uuid-1',
    }));
    expect(result).not.toBeNull();
    expect(result!.senderId).toBe('aci-uuid-1');
    expect(result!.conversationId).toBe('signal:aci-uuid-1');
  });

  it('uses sourceUuid as senderId for ACI-only group messages', () => {
    const result = convertSignalEnvelope(makeEnvelope({
      source: '',
      sourceNumber: '',
      sourceUuid: 'aci-uuid-1',
      dataMessage: {
        timestamp: 1700000000000,
        message: 'Team meeting at 3pm',
        expiresInSeconds: 0,
        viewOnce: false,
        groupInfo: { groupId: 'abc123==', type: 'DELIVER' },
      },
    }));
    expect(result).not.toBeNull();
    expect(result!.senderId).toBe('aci-uuid-1');
    expect(result!.conversationId).toBe('signal:group=abc123==');
  });

  it('returns null when both sourceNumber and sourceUuid are empty', () => {
    expect(convertSignalEnvelope(makeEnvelope({
      source: '',
      sourceNumber: '',
      sourceUuid: '',
    }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reactions → inbound.reaction shape (#1479)
// ---------------------------------------------------------------------------

describe('convertSignalReaction', () => {
  it('normalizes a reaction without mapping intent', () => {
    const result = convertSignalReaction(makeEnvelope({
      dataMessage: {
        timestamp: 1700000000000,
        message: null,
        expiresInSeconds: 0,
        viewOnce: false,
        reaction: {
          emoji: '👍',
          targetAuthor: '+14155559999',
          targetTimestamp: 1699999999999,
          isRemove: false,
        },
      },
    }));

    expect(result).toEqual({
      conversationId: 'signal:+14155551234',
      channelId: 'signal',
      senderId: '+14155551234',
      emoji: '👍',
      targetMessageId: '1699999999999',
      metadata: {
        sourceName: 'Alice',
        targetAuthor: '+14155559999',
        isRemove: false,
        signalTimestamp: 1700000000000,
      },
    });
  });

  it('carries isRemove: true for un-reacts', () => {
    const result = convertSignalReaction(makeEnvelope({
      dataMessage: {
        timestamp: 1700000000000,
        message: null,
        expiresInSeconds: 0,
        viewOnce: false,
        reaction: {
          emoji: '👍',
          targetAuthor: '+14155559999',
          targetTimestamp: 1699999999999,
          isRemove: true,
        },
      },
    }));
    expect(result?.metadata.isRemove).toBe(true);
  });

  it('returns null for non-reaction envelopes', () => {
    expect(convertSignalReaction(makeEnvelope())).toBeNull();
  });

  it('falls back to sourceUuid for ACI-only reactors', () => {
    const result = convertSignalReaction(makeEnvelope({
      source: '',
      sourceNumber: '',
      sourceUuid: 'aci-uuid-1',
      dataMessage: {
        timestamp: 1700000000000,
        message: null,
        expiresInSeconds: 0,
        viewOnce: false,
        reaction: {
          emoji: '👍',
          targetAuthor: '+14155559999',
          targetTimestamp: 1699999999999,
          isRemove: false,
        },
      },
    }));
    expect(result?.senderId).toBe('aci-uuid-1');
    expect(result?.conversationId).toBe('signal:aci-uuid-1');
  });
});
