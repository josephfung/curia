// Which of the two people each system notification is for (#2710, ADR-068).
//
// The table is the whole routing policy: exactly one audience per notification type, and a
// type with no entry fails typecheck (NOTIFICATION_AUDIENCES is a Record over the union).
// These tests pin the mapping itself, so a change to who hears about what is a deliberate edit
// to this file and the ADR, not a side effect.
import { describe, it, expect } from 'vitest';
import {
  NOTIFICATION_AUDIENCES,
  notificationAudience,
  operatorNotificationTypes,
  principalNotificationTypes,
} from '../../../src/notifications/audience.js';

describe('NOTIFICATION_AUDIENCES', () => {
  it('routes each notification type to the audience the design fixed', () => {
    // The table from ADR-068 / issue #2710, written out in full.
    const expected = {
      // Operator: running the install.
      database_unavailable: 'operator',
      mailbox_signin_admin_blocked: 'operator',
      schedule_suspended: 'operator',
      schedule_recovered: 'operator',
      mailbox_outage: 'operator',
      // Operator: onboarding trouble.
      greeting_unanswered: 'operator',
      invitation_expired: 'operator',
      web_search_failed: 'operator',
      mailbox_signin_blocked: 'operator',
      deep_dive_failed: 'operator',
      // Principal: their own mail, approvals and learning proposals.
      inbox_triage_paused: 'principal',
      contact_rate_limited: 'principal',
      approval_requested: 'principal',
      learning_proposal: 'principal',
      principal_mailbox_outage: 'principal',
      // No longer emitted (#2159); kept so historical and replayed payloads still resolve.
      blocked_content: 'principal',
      approval_expired: 'principal',
      principal_note: 'principal',
    } as const;
    expect(NOTIFICATION_AUDIENCES).toEqual(expected);
  });

  it('has no type in both audiences, and none missing', () => {
    const operator = operatorNotificationTypes();
    const principal = principalNotificationTypes();
    expect(operator.length + principal.length).toBe(Object.keys(NOTIFICATION_AUDIENCES).length);
    expect(operator.filter((type) => principal.includes(type))).toEqual([]);
  });

  it('sends a principal mailbox outage to both people, as two types', () => {
    // The one case with two notices for one event: the link can only reach the principal, and
    // the operator's copy carries none of it.
    expect(notificationAudience('principal_mailbox_outage')).toBe('principal');
    expect(notificationAudience('mailbox_outage')).toBe('operator');
  });

  it('tells the operator about onboarding trouble', () => {
    // It is the operator's job to unblock Setup: trust a Google app, check a key, resend a link.
    for (const type of ['greeting_unanswered', 'invitation_expired', 'web_search_failed', 'mailbox_signin_blocked', 'deep_dive_failed'] as const) {
      expect(notificationAudience(type)).toBe('operator');
    }
  });
});
