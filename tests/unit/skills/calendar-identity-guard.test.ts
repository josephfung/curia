// calendar-identity-guard.test.ts — #1854 fail-closed wrong-identity calendar reads

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import {
  CALENDAR_IDENTITY_MISMATCH_CODE,
  calendarIdentityMismatchResult,
  guardMcpCalendarIdentity,
  guardNylasExplicitCalendarIdentity,
  isGoogleWorkspaceCalendarTool,
  isPrincipalScopedCalendarTask,
} from '../../../src/skills/_shared/calendar-identity-guard.js';
import type { ToolContext } from '../../../src/skills/types.js';
import { makeSystemOriginator, makePrincipalOriginator } from '../../../src/contacts/principal.js';

const logger = pino({ level: 'silent' });

function makeCtx(
  overrides?: Partial<ToolContext> & { originator?: ReturnType<typeof makeSystemOriginator> },
): ToolContext {
  const { originator, taskMetadata, ...rest } = overrides ?? {};
  return {
    toolName: 'get_events',
    toolVersion: '1.0.0',
    input: { calendar_id: 'primary' },
    secret: () => {
      throw new Error('no secrets');
    },
    log: logger,
    taskMetadata: taskMetadata ?? (originator ? { originator } : undefined),
    ...rest,
  };
}

describe('isGoogleWorkspaceCalendarTool', () => {
  it('matches the holdback list and calendarish names', () => {
    expect(isGoogleWorkspaceCalendarTool('get_events')).toBe(true);
    expect(isGoogleWorkspaceCalendarTool('list_calendars')).toBe(true);
    expect(isGoogleWorkspaceCalendarTool('query_freebusy')).toBe(true);
    expect(isGoogleWorkspaceCalendarTool('create_focus_time_event')).toBe(true);
    expect(isGoogleWorkspaceCalendarTool('search_drive_files')).toBe(false);
    expect(isGoogleWorkspaceCalendarTool('create_doc')).toBe(false);
  });
});

describe('isPrincipalScopedCalendarTask', () => {
  it('is true for system and principal originators', () => {
    expect(isPrincipalScopedCalendarTask({ originator: makeSystemOriginator() })).toBe(true);
    expect(
      isPrincipalScopedCalendarTask({
        originator: makePrincipalOriginator('11111111-1111-1111-1111-111111111111', 'console'),
      }),
    ).toBe(true);
  });

  it('is false for agent originators and missing metadata', () => {
    expect(
      isPrincipalScopedCalendarTask({
        originator: {
          contactId: 'agent',
          systemRole: 'agent',
          channel: 'internal',
          initiatedAt: new Date().toISOString(),
          tier: null,
        },
      }),
    ).toBe(false);
    expect(isPrincipalScopedCalendarTask(undefined)).toBe(false);
  });
});

describe('guardMcpCalendarIdentity', () => {
  it('fails closed when principal-scoped get_events resolves to Curia identity', () => {
    const result = guardMcpCalendarIdentity({
      serverId: 'google-workspace',
      toolName: 'get_events',
      ctx: makeCtx({ originator: makeSystemOriginator() }),
      resolvedOwnerEmail: 'nathancuria1@gmail.com',
    });

    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    if (!result!.success) {
      expect(result!.errorType).toBe('IDENTITY_MISMATCH');
      expect(result!.error).toContain(CALENDAR_IDENTITY_MISMATCH_CODE);
      expect(result!.error).toContain('nathancuria1@gmail.com');
      expect(result!.error).toContain('requestedCalendarId=primary');
      expect(result!.error).toMatch(/Do not report the principal/i);
    }
  });

  it('does not return success+empty for a principal-scoped wrong-identity read', () => {
    const result = guardMcpCalendarIdentity({
      serverId: 'google-workspace',
      toolName: 'get_events',
      ctx: makeCtx({
        originator: makePrincipalOriginator('11111111-1111-1111-1111-111111111111', 'signal'),
        input: { calendar_id: 'primary' },
      }),
      resolvedOwnerEmail: 'curia-service@example.com',
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        errorType: 'IDENTITY_MISMATCH',
      }),
    );
    // Explicitly not the silent-lie shape from #1853 / #1854.
    expect(result).not.toEqual(
      expect.objectContaining({ success: true, data: expect.anything() }),
    );
  });

  it('allows agent-originated google-workspace calendar reads (#1330 path)', () => {
    const result = guardMcpCalendarIdentity({
      serverId: 'google-workspace',
      toolName: 'get_events',
      ctx: makeCtx({
        originator: {
          contactId: 'agent',
          systemRole: 'agent',
          channel: 'internal',
          initiatedAt: new Date().toISOString(),
          tier: null,
        },
      }),
      resolvedOwnerEmail: 'nathancuria1@gmail.com',
    });
    expect(result).toBeNull();
  });

  it('ignores non-calendar google-workspace tools and other servers', () => {
    expect(
      guardMcpCalendarIdentity({
        serverId: 'google-workspace',
        toolName: 'search_drive_files',
        ctx: makeCtx({ originator: makeSystemOriginator() }),
        resolvedOwnerEmail: 'x@y.com',
      }),
    ).toBeNull();

    expect(
      guardMcpCalendarIdentity({
        serverId: 'other-mcp',
        toolName: 'get_events',
        ctx: makeCtx({ originator: makeSystemOriginator() }),
      }),
    ).toBeNull();
  });
});

describe('guardNylasExplicitCalendarIdentity', () => {
  const principalId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const agentId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const sarahId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  it('fails when an explicit calendarId is registered to the agent contact', async () => {
    const contactService = {
      findContactBySystemRole: vi.fn().mockResolvedValue({ id: principalId }),
      resolveCalendar: vi.fn().mockResolvedValue({
        contactId: agentId,
        label: 'Agent calendar',
        isPrimary: true,
        readOnly: false,
      }),
    };

    const result = await guardNylasExplicitCalendarIdentity({
      calendarId: 'cal-agent',
      ctx: makeCtx({
        originator: makeSystemOriginator(),
        contactService: contactService as never,
        agentContactId: agentId,
      }),
    });

    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    if (!result!.success) {
      expect(result!.errorType).toBe('IDENTITY_MISMATCH');
      expect(result!.error).toContain('cal-agent');
      expect(result!.error).toContain(principalId);
      expect(result!.error).toContain('agent');
    }
  });

  it('allows principal-owned, third-party, org-wide, and unregistered calendars', async () => {
    const contactService = {
      findContactBySystemRole: vi.fn().mockResolvedValue({ id: principalId }),
      resolveCalendar: vi
        .fn()
        .mockResolvedValueOnce({
          contactId: principalId,
          label: 'Work',
          isPrimary: true,
          readOnly: false,
        })
        .mockResolvedValueOnce({
          contactId: sarahId,
          label: "Sarah's calendar",
          isPrimary: true,
          readOnly: false,
        })
        .mockResolvedValueOnce({
          contactId: null,
          label: 'Holidays',
          isPrimary: false,
          readOnly: true,
        })
        .mockResolvedValueOnce(null),
    };

    for (const calendarId of ['cal-principal', 'cal-sarah', 'cal-holidays', 'cal-unregistered']) {
      const result = await guardNylasExplicitCalendarIdentity({
        calendarId,
        ctx: makeCtx({
          originator: makeSystemOriginator(),
          contactService: contactService as never,
          agentContactId: agentId,
        }),
      });
      expect(result).toBeNull();
    }
  });

  it('warns and fails open when contactService is missing', async () => {
    const warn = vi.fn();
    const result = await guardNylasExplicitCalendarIdentity({
      calendarId: 'cal-1',
      ctx: makeCtx({
        originator: makeSystemOriginator(),
        log: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      }),
    });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: CALENDAR_IDENTITY_MISMATCH_CODE }),
      expect.stringContaining('contactService'),
    );
  });
});

describe('identityMismatchFromToolResult', () => {
  it('detects direct IDENTITY_MISMATCH failures', async () => {
    const { identityMismatchFromToolResult } = await import(
      '../../../src/skills/_shared/calendar-identity-guard.js'
    );
    const err = identityMismatchFromToolResult('get_events', {
      success: false,
      errorType: 'IDENTITY_MISMATCH',
      error: 'mismatch',
    });
    expect(err?.type).toBe('IDENTITY_MISMATCH');
    expect(err?.source).toBe('skill:get_events');
  });

  it('detects delegate soft-failures carrying IDENTITY_MISMATCH', async () => {
    const { identityMismatchFromToolResult } = await import(
      '../../../src/skills/_shared/calendar-identity-guard.js'
    );
    const err = identityMismatchFromToolResult('delegate', {
      success: true,
      data: {
        agent: 'calendar',
        failed: true,
        errorType: 'IDENTITY_MISMATCH',
        message: 'specialist blocked',
      },
    });
    expect(err?.type).toBe('IDENTITY_MISMATCH');
    expect(err?.context).toEqual(
      expect.objectContaining({ via: 'delegate', specialistAgent: 'calendar' }),
    );
  });
});

describe('calendarIdentityMismatchResult', () => {
  it('emits a queryable IDENTITY_MISMATCH ToolResult', () => {
    const result = calendarIdentityMismatchResult({
      toolName: 'get_events',
      resolvedIdentity: 'svc@curia.example',
      expectedSubject: 'principal',
      requestedCalendarId: 'primary',
      source: 'mcp_google_workspace',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorType).toBe('IDENTITY_MISMATCH');
      expect(result.error).toContain(CALENDAR_IDENTITY_MISMATCH_CODE);
    }
  });
});
