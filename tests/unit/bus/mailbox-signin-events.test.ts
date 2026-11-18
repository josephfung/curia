// principal_mailbox.connected and mailbox_signin.finished — system-layer events for the
// Nylas hosted-auth mailbox sign-in (#2361).
import { describe, it, expect } from 'vitest';
import {
  createPrincipalMailboxConnected,
  createMailboxSignInFinished,
} from '../../../src/bus/events.js';
import { canPublish, canSubscribe } from '../../../src/bus/permissions.js';
import { MAILBOX_SIGNIN_OUTCOMES } from '../../../src/nylas/signin-outcome.js';

describe('principal_mailbox.connected', () => {
  const event = createPrincipalMailboxConnected({ mailboxId: 'personal' }, 'parent-1');

  it('is a system-layer event carrying only the mailbox id', () => {
    expect(event.type).toBe('principal_mailbox.connected');
    expect(event.sourceLayer).toBe('system');
    expect(event.parentEventId).toBe('parent-1');
    expect(event.payload).toEqual({ mailboxId: 'personal' });
  });

  it('is published and read only by the system layer', () => {
    expect(canPublish('system', 'principal_mailbox.connected')).toBe(true);
    expect(canSubscribe('system', 'principal_mailbox.connected')).toBe(true);
    for (const layer of ['agent', 'channel'] as const) {
      expect(canPublish(layer, 'principal_mailbox.connected')).toBe(false);
      expect(canSubscribe(layer, 'principal_mailbox.connected')).toBe(false);
    }
  });
});

describe('mailbox_signin.finished', () => {
  const event = createMailboxSignInFinished({
    target: 'principal',
    outcome: 'connected',
    mailboxId: 'personal',
    conversationId: 'conv-1',
    channelId: 'web',
    agentId: 'coordinator',
    taskEventId: 'task-1',
    originator: { contactId: 'c-1' },
    resumeToken: 'tok',
  }, 'task-1');

  it('is a system-layer event with the origin fields round-tripped', () => {
    expect(event.type).toBe('mailbox_signin.finished');
    expect(event.sourceLayer).toBe('system');
    expect(event.parentEventId).toBe('task-1');
    expect(Object.keys(event.payload).sort()).toEqual([
      'agentId', 'channelId', 'conversationId', 'mailboxId', 'originator',
      'outcome', 'resumeToken', 'target', 'taskEventId',
    ]);
  });

  it('accepts a minimal payload (no mailbox, no origin)', () => {
    const e = createMailboxSignInFinished({ target: 'curia', outcome: 'cancelled' });
    expect(e.parentEventId).toBeUndefined();
    expect(e.payload).toEqual({ target: 'curia', outcome: 'cancelled' });
  });

  it('is published and read only by the system layer', () => {
    expect(canPublish('system', 'mailbox_signin.finished')).toBe(true);
    expect(canSubscribe('system', 'mailbox_signin.finished')).toBe(true);
    for (const layer of ['agent', 'channel'] as const) {
      expect(canPublish(layer, 'mailbox_signin.finished')).toBe(false);
      expect(canSubscribe(layer, 'mailbox_signin.finished')).toBe(false);
    }
  });
});

describe('MAILBOX_SIGNIN_OUTCOMES', () => {
  it('lists every outcome', () => {
    expect([...MAILBOX_SIGNIN_OUTCOMES].sort()).toEqual([
      'admin_blocked', 'cancelled', 'connected', 'expired', 'failed', 'missing_scopes',
      'not_google', 'org_internal', 'reconnected', 'refused', 'wrong_account',
    ]);
  });
});
