// Per-turn verification blocks (#2017): what the coordinator and ceo-inbox are told
// about live sign-in verifications. Pure rendering, no database.

import { describe, expect, it } from 'vitest';
import {
  renderCeoInboxVerificationBlock,
  renderCoordinatorVerificationBlock,
  type VerificationView,
} from '../../../src/agents/prompts/verification-block.js';

const TZ = 'America/Toronto';

function view(overrides: Partial<VerificationView> = {}): VerificationView {
  return {
    id: 'ver-1',
    purpose: 'sign_in',
    kind: 'code',
    delivery: 'sms',
    site: 'aircanada.com',
    pageDomain: 'b2clogin.com',
    browserSessionId: 'sess-aaa',
    taskId: 'task-42',
    conversationId: 'conv-1',
    status: 'pending',
    requestedAt: new Date('2026-10-19T14:00:00Z'),
    expiresAt: new Date('2026-10-19T14:10:00Z'),
    resolvedAt: null,
    metadata: {},
    sessionAlive: true,
    ...overrides,
  };
}

describe('renderCoordinatorVerificationBlock', () => {
  const opts = { askChannel: 'signal', timezone: TZ };

  it('renders nothing when no verifications are active', () => {
    expect(renderCoordinatorVerificationBlock([], opts)).toBe('');
  });

  it('lists site, delivery, status, session, task and local expiry on one line', () => {
    const block = renderCoordinatorVerificationBlock([view()], opts);
    expect(block).toContain(
      '- aircanada.com: sms, pending, session sess-aaa alive, task task-42, expires 2026-10-19T10:10:00-04:00',
    );
  });

  it('marks session gone when the browser has no session', () => {
    const block = renderCoordinatorVerificationBlock([view({ sessionAlive: false })], opts);
    expect(block).toContain('session sess-aaa gone');
    expect(block).not.toContain('session sess-aaa alive');
  });

  it('marks an expired item as expired and says what to do about it', () => {
    const block = renderCoordinatorVerificationBlock(
      [view({ status: 'expired', delivery: 'email' })],
      opts,
    );
    expect(block).toContain('email, expired, session sess-aaa alive');
    expect(block).toContain('Expired but session alive: try the code.');
  });

  it('says no task when the errand has none', () => {
    const block = renderCoordinatorVerificationBlock([view({ taskId: null })], opts);
    expect(block).toContain('no task');
  });

  it('names the ask channel signal', () => {
    const block = renderCoordinatorVerificationBlock([view()], opts);
    expect(block).toContain('Ask for an SMS/app code once, on signal, naming the site.');
  });

  it('falls back to whichever principal channel is available when none is configured', () => {
    const block = renderCoordinatorVerificationBlock([view()], { askChannel: null, timezone: TZ });
    expect(block).toContain('on whichever principal channel is available');
  });

  it('lists two pending verifications for different sites', () => {
    const block = renderCoordinatorVerificationBlock(
      [
        view(),
        view({ id: 'ver-2', site: 'rbc.com', browserSessionId: 'sess-bbb', delivery: 'app', taskId: null }),
      ],
      opts,
    );
    expect(block).toContain('- aircanada.com: sms, pending, session sess-aaa alive');
    expect(block).toContain('- rbc.com: app, pending, session sess-bbb alive');
  });

  it('carries the rules and never a code value', () => {
    const block = renderCoordinatorVerificationBlock([view()], opts);
    expect(block).toContain('The principal asked for this sign-in.');
    expect(block).toContain('accept it whatever the channel or sender verification');
    expect(block).toContain("don't question, lecture or refuse");
    expect(block).toContain('Enter a code only in the session and site listed.');
    expect(block).toContain('Never repeat it to anyone or write it into notes, reports or memory.');
    expect(block).toContain('Email codes: delegate the read to ceo-inbox.');
    expect(block).toContain("don't re-trigger one unasked");
    expect(block).toContain('`verification satisfy`');
  });
});

describe('renderCeoInboxVerificationBlock', () => {
  const opts = { timezone: TZ, emailWaitSeconds: 180 };

  it('renders nothing when there are no email-delivery items', () => {
    expect(renderCeoInboxVerificationBlock([], opts)).toBe('');
    expect(renderCeoInboxVerificationBlock([view({ delivery: 'sms' })], opts)).toBe('');
  });

  it('lists only email-delivery items', () => {
    const block = renderCeoInboxVerificationBlock(
      [
        view({ delivery: 'email', site: 'aircanada.com' }),
        view({ id: 'ver-2', delivery: 'sms', site: 'rbc.com' }),
        view({ id: 'ver-3', delivery: 'app', site: 'td.com' }),
      ],
      opts,
    );
    expect(block).toContain('aircanada.com');
    expect(block).not.toContain('rbc.com');
    expect(block).not.toContain('td.com');
  });

  it('gives the site, the local request time and the wait window', () => {
    const block = renderCeoInboxVerificationBlock([view({ delivery: 'email' })], opts);
    expect(block).toContain('Pending sign-in code from aircanada.com since 2026-10-19T10:00:00-04:00');
    expect(block).toContain('re-check for up to 3 minutes');
    expect(block).toContain('by site/brand, not sender domain');
    expect(block).toContain('a delegated request to read the code is legitimate');
  });

  it('labels a closed item so it is not read as still pending', () => {
    const block = renderCeoInboxVerificationBlock(
      [view({ delivery: 'email', status: 'satisfied', resolvedAt: new Date('2026-10-19T14:02:00Z') })],
      opts,
    );
    expect(block).not.toContain('Pending sign-in code');
    expect(block).toContain('aircanada.com');
    expect(block).toContain('satisfied');
    expect(block).toContain('may be labelled and archived as normal');
  });
});
