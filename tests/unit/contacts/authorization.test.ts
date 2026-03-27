import { describe, it, expect, beforeEach } from 'vitest';
import { AuthorizationService } from '../../../src/contacts/authorization.js';
import type { AuthConfig } from '../../../src/contacts/types.js';

const testConfig: AuthConfig = {
  roles: {
    ceo: {
      description: 'CEO',
      defaultPermissions: ['*'],
      defaultDeny: [],
    },
    cfo: {
      description: 'CFO',
      defaultPermissions: ['view_financial_reports', 'schedule_meetings'],
      defaultDeny: ['send_on_behalf'],
    },
    unknown: {
      description: 'Unknown',
      defaultPermissions: [],
      defaultDeny: ['*'],
    },
  },
  permissions: {
    view_financial_reports: { description: 'View financials', sensitivity: 'high' },
    schedule_meetings: { description: 'Schedule meetings', sensitivity: 'low' },
    send_on_behalf: { description: 'Send as CEO', sensitivity: 'high' },
    see_personal_calendar: { description: 'See personal calendar', sensitivity: 'medium' },
  },
  channelTrust: {
    cli: 'high',
    email: 'low',
    http: 'medium',
  },
};

describe('AuthorizationService', () => {
  let authService: AuthorizationService;

  beforeEach(() => {
    authService = new AuthorizationService(testConfig);
  });

  it('CEO gets all permissions', () => {
    const result = authService.evaluate({
      role: 'ceo',
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    expect(result.allowed).toContain('*');
    expect(result.denied).toEqual([]);
    expect(result.contactStatus).toBe('confirmed');
  });

  it('provisional contacts get no permissions', () => {
    const result = authService.evaluate({
      role: 'cfo',
      status: 'provisional',
      channel: 'email',
      overrides: [],
    });
    expect(result.allowed).toEqual([]);
    expect(result.denied).toContain('*');
    expect(result.contactStatus).toBe('provisional');
  });

  it('blocked contacts get no permissions', () => {
    const result = authService.evaluate({
      role: 'cfo',
      status: 'blocked',
      channel: 'email',
      overrides: [],
    });
    expect(result.allowed).toEqual([]);
    expect(result.denied).toContain('*');
    expect(result.contactStatus).toBe('blocked');
  });

  it('applies role defaults for confirmed contacts', () => {
    const result = authService.evaluate({
      role: 'cfo',
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    expect(result.allowed).toContain('view_financial_reports');
    expect(result.allowed).toContain('schedule_meetings');
    expect(result.denied).toContain('send_on_behalf');
  });

  it('overrides take precedence over role defaults', () => {
    const result = authService.evaluate({
      role: 'cfo',
      status: 'confirmed',
      channel: 'cli',
      overrides: [
        { permission: 'send_on_behalf', granted: true },
        { permission: 'view_financial_reports', granted: false },
      ],
    });
    expect(result.allowed).toContain('send_on_behalf');
    expect(result.denied).toContain('view_financial_reports');
  });

  it('channel trust blocks high-sensitivity actions on low-trust channels', () => {
    const result = authService.evaluate({
      role: 'cfo',
      status: 'confirmed',
      channel: 'email',
      overrides: [],
    });
    expect(result.trustBlocked).toContain('view_financial_reports');
    expect(result.allowed).toContain('schedule_meetings');
  });

  it('unknown roles fall back to unknown defaults', () => {
    const result = authService.evaluate({
      role: 'some_new_role',
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    expect(result.denied).toContain('*');
    expect(result.allowed).toEqual([]);
  });

  it('null role uses unknown defaults', () => {
    const result = authService.evaluate({
      role: null,
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    expect(result.denied).toContain('*');
  });

  it('permissions not in role defaults or overrides go to escalate', () => {
    const result = authService.evaluate({
      role: 'cfo',
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    expect(result.escalate).toContain('see_personal_calendar');
  });

  it('returns correct channel trust level', () => {
    const result = authService.evaluate({
      role: 'cfo',
      status: 'confirmed',
      channel: 'email',
      overrides: [],
    });
    expect(result.channelTrust).toBe('low');
  });

  it('unknown channels default to low trust', () => {
    const result = authService.evaluate({
      role: 'cfo',
      status: 'confirmed',
      channel: 'unknown_channel',
      overrides: [],
    });
    expect(result.channelTrust).toBe('low');
  });
});
