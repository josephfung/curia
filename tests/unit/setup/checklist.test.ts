// The Setup checklist (#2358): every required step, each messaging and voice route, and the
// shipped catalog itself.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateChecklist, parseCatalog, type CatalogTask, type SetupCheckDeps } from '../../../src/setup/checklist.js';
import { EMPTY_SETUP_STATE, type SetupState } from '../../../src/setup/setup-state.js';
import { createSilentLogger } from '../../../src/logger.js';

const CATALOG_PATH = join(import.meta.dirname, '../../../skills/setup/tools/setup-status/catalog.yaml');
const catalog = parseCatalog(readFileSync(CATALOG_PATH, 'utf-8'));
const REQUIRED = ['who', 'curia_name', 'email', 'messaging', 'voice', 'mailbox_signin', 'google_workspace'];

const COMPLETE_STATE: SetupState = {
  ...EMPTY_SETUP_STATE,
  phase: 'in_progress',
  setupFor: 'other',
  operatorName: 'Operator',
  operatorEmail: 'op@example.com',
  messagingRoute: 'app',
  voiceRoute: 'app',
};

/** Deps for an install where every required step passes; override one field per case. */
function deps(overrides: Partial<SetupCheckDeps> = {}, state: Partial<SetupState> = {}): SetupCheckDeps {
  return {
    state: async () => ({ ...COMPLETE_STATE, ...state }),
    principal: async () => ({ displayName: 'Dana Example', primaryEmail: 'dana@example.com', timezone: 'America/Toronto' }),
    identityConfigured: async () => true,
    emailChannelStatus: async () => 'running',
    nylasSignInReadiness: async () => ({ ready: true, applicationId: 'app', region: 'us' }),
    googleWorkspaceSignIn: async () => ({ state: 'signed_in' }),
    principalMailboxReady: async () => 'pending',
    channelStatus: async () => 'running',
    principalHasIdentity: async () => true,
    phoneAppBlocker: () => null,
    signalCalls: () => 'ready',
    secretPresent: async () => false,
    browserReady: () => false,
    logger: createSilentLogger(),
    ...overrides,
  };
}

function task(result: Awaited<ReturnType<typeof evaluateChecklist>>, id: string) {
  const t = result.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`no task ${id}`);
  return t;
}

describe('the shipped catalog', () => {
  it('lists the required steps in the Setup page order', () => {
    expect(catalog.filter((t) => !t.optional).map((t) => t.id)).toEqual(REQUIRED);
  });

  it('has no principal content: persona, debrief, profile, tour and inbox sending are onboarding', () => {
    const ids = catalog.map((t) => t.id);
    for (const gone of ['persona', 'principal_profile', 'debrief', 'capability_tour', 'inbox_sending', 'signal', 'sms', 'slack', 'phone_app']) {
      expect(ids).not.toContain(gone);
    }
  });

  it('gives every task a credential_how_to or value_prop and a docs_url', () => {
    for (const t of catalog) {
      expect(t.docs_url, t.id).toMatch(/^\//);
      expect(t.value_prop.length, t.id).toBeGreaterThan(0);
    }
  });
});

describe('parseCatalog', () => {
  it('refuses an unknown check type', () => {
    expect(() => parseCatalog('tasks:\n  - id: x\n    completion_check:\n      type: behavioral_preferences\n')).toThrow(/unknown completion_check/);
  });

  it('refuses a duplicate id', () => {
    const raw = 'tasks:\n  - id: x\n    completion_check: { type: always_available }\n  - id: x\n    completion_check: { type: always_available }\n';
    expect(() => parseCatalog(raw)).toThrow(/duplicate/);
  });

  it.each([['missing', ''], ['empty', '\n      keys: []']])('refuses a vault_secrets_all task with %s keys', (_n, keys) => {
    expect(() => parseCatalog(`tasks:\n  - id: x\n    completion_check:\n      type: vault_secrets_all${keys}\n`)).toThrow(/vault keys/);
  });

  it('refuses a file without a tasks list', () => {
    expect(() => parseCatalog('nope: 1')).toThrow(/unexpected structure/);
  });
});

describe('evaluateChecklist', () => {
  it('is complete when every required step passes, whatever the optional extras say', async () => {
    const result = await evaluateChecklist(catalog, deps());
    expect(result.setupComplete).toBe(true);
    expect(result.missing).toEqual([]);
    expect(task(result, 'principal_mailboxes').status).toBe('pending');
  });

  const missingCases: Array<[string, Partial<SetupCheckDeps>, Partial<SetupState>]> = [
    ['who', {}, { setupFor: null }],
    ['curia_name', { identityConfigured: async () => false }, {}],
    ['email', { emailChannelStatus: async () => 'not_configured' }, {}],
    ['messaging', {}, { messagingRoute: null }],
    ['voice', {}, { voiceRoute: null }],
    ['mailbox_signin', { nylasSignInReadiness: async () => ({ ready: false, reason: 'no_api_key', detail: 'Add the key.' }) }, {}],
    ['google_workspace', { googleWorkspaceSignIn: async () => ({ state: 'not_signed_in' }) }, {}],
  ];
  it.each(missingCases)('is incomplete when %s is not done, and says why', async (id, override, state) => {
    const result = await evaluateChecklist(catalog, deps(override, state));
    expect(result.setupComplete).toBe(false);
    expect(result.missing).toEqual([id]);
    expect(task(result, id).detail).toBeTruthy();
  });

  describe('who it is for', () => {
    it('needs the operator details when Setup is for someone else', async () => {
      const result = await evaluateChecklist(catalog, deps({}, { operatorEmail: null }));
      expect(task(result, 'who').detail).toMatch(/operator/);
    });

    it('needs no operator details when Setup is for the operator themselves', async () => {
      const result = await evaluateChecklist(catalog, deps({}, { setupFor: 'self', operatorName: null, operatorEmail: null }));
      expect(task(result, 'who').status).toBe('done');
    });

    it.each([
      ['no principal', null, /name/],
      ['no email', { displayName: 'Dana', primaryEmail: null, timezone: 'UTC' }, /email/],
      ['no timezone', { displayName: 'Dana', primaryEmail: 'd@example.com', timezone: null }, /timezone/],
    ])('is pending with %s', async (_name, principal, detail) => {
      const result = await evaluateChecklist(catalog, deps({ principal: async () => principal }));
      expect(task(result, 'who').status).toBe('pending');
      expect(task(result, 'who').detail).toMatch(detail);
    });
  });

  describe('messaging routes', () => {
    it('app: done when the app can be installed, with no restart', async () => {
      const result = await evaluateChecklist(catalog, deps({ channelStatus: async () => 'not_configured' }));
      expect(task(result, 'messaging').status).toBe('done');
    });

    it('app: pending with the reason when the address cannot host the app', async () => {
      const result = await evaluateChecklist(catalog, deps({ phoneAppBlocker: () => 'Needs https.' }));
      expect(task(result, 'messaging')).toMatchObject({ status: 'pending', detail: 'Needs https.' });
    });

    it.each(['signal', 'sms', 'slack'] as const)('%s: done when the channel runs and the principal has an id there', async (route) => {
      const seen: string[] = [];
      const result = await evaluateChecklist(catalog, deps({
        channelStatus: async (c) => { seen.push(c); return 'running'; },
      }, { messagingRoute: route }));
      expect(task(result, 'messaging').status).toBe('done');
      expect(seen).toContain(route);
    });

    it.each(['signal', 'sms', 'slack'] as const)('%s: saved but not started reads restart_required', async (route) => {
      const result = await evaluateChecklist(catalog, deps({ channelStatus: async () => 'restart_required' }, { messagingRoute: route }));
      expect(task(result, 'messaging')).toMatchObject({ status: 'pending', restart_required: true });
    });

    it.each(['signal', 'sms', 'slack'] as const)('%s: pending without the principal id, even when running', async (route) => {
      const result = await evaluateChecklist(catalog, deps({ principalHasIdentity: async () => false }, { messagingRoute: route }));
      expect(task(result, 'messaging').status).toBe('pending');
      expect(task(result, 'messaging').detail).toMatch(/^Add the principal's/);
    });
  });

  describe('voice routes', () => {
    it('app: needs the voice channel running', async () => {
      const result = await evaluateChecklist(catalog, deps({ channelStatus: async () => 'restart_required' }));
      expect(task(result, 'voice')).toMatchObject({ status: 'pending', restart_required: true });
    });

    it('signal: says when Signal calls are turned off on the server', async () => {
      const result = await evaluateChecklist(catalog, deps({ signalCalls: () => 'disabled' }, { voiceRoute: 'signal' }));
      expect(task(result, 'voice').detail).toMatch(/SIGNAL_VOICE_CALLS_ENABLED/);
    });

    it('signal: needs Signal running as well as voice', async () => {
      const result = await evaluateChecklist(catalog, deps({
        channelStatus: async (c) => (c === 'signal' ? 'not_configured' : 'running'),
      }, { voiceRoute: 'signal' }));
      expect(task(result, 'voice').status).toBe('pending');
      expect(task(result, 'voice').detail).toMatch(/Signal/);
    });

    it('signal: pending when calls are on but nothing answers them (no call bridge)', async () => {
      const result = await evaluateChecklist(catalog, deps({ signalCalls: () => 'not_wired' }, { voiceRoute: 'signal' }));
      expect(result.setupComplete).toBe(false);
      expect(task(result, 'voice').detail).toMatch(/SIGNAL_PULSE_SOCKET_PATH/);
    });

    it('signal: done with both channels running and the principal on Signal', async () => {
      const result = await evaluateChecklist(catalog, deps({}, { voiceRoute: 'signal' }));
      expect(task(result, 'voice').status).toBe('done');
    });
  });

  it('reports a check whose dependency throws as pending, and still computes the rest', async () => {
    const result = await evaluateChecklist(catalog, deps({ emailChannelStatus: async () => { throw new Error('db down'); } }));
    expect(task(result, 'email')).toMatchObject({ status: 'pending' });
    expect(task(result, 'email').detail).toMatch(/Could not check/);
    expect(result.missing).toEqual(['email']);
  });

  it('marks email restart_required when the mailbox is saved but not polling', async () => {
    const result = await evaluateChecklist(catalog, deps({ emailChannelStatus: async () => 'restart_required' }));
    expect(task(result, 'email').restart_required).toBe(true);
  });

  it('marks Email & calendar restart_required from the Nylas readiness reason', async () => {
    const result = await evaluateChecklist(catalog, deps({
      nylasSignInReadiness: async () => ({ ready: false, reason: 'restart_required', detail: 'Restart.' }),
    }));
    expect(task(result, 'mailbox_signin')).toMatchObject({ restart_required: true, detail: 'Restart.' });
  });

  it('reports the optional upgrade state', async () => {
    const result = await evaluateChecklist(catalog, deps({ secretPresent: async (k) => k === 'tavily_api_key' }));
    expect(task(result, 'web_research').optional_upgrade?.configured).toBe(true);
  });

  describe('Google Workspace (#2683)', () => {
    it('is required, and done only on the live sign-in check, not on saved keys', async () => {
      const result = await evaluateChecklist(catalog, deps({
        secretPresent: async () => true,
        googleWorkspaceSignIn: async () => ({ state: 'not_signed_in' }),
      }));
      expect(task(result, 'google_workspace')).toMatchObject({ status: 'pending', optional: false, detail: 'Sign in as Curia with Google.' });
      expect(task(result, 'google_workspace')).not.toHaveProperty('done_means');
      expect(result.setupComplete).toBe(false);
    });

    it('reads done for an install whose saved token Google still accepts', async () => {
      const result = await evaluateChecklist(catalog, deps());
      expect(task(result, 'google_workspace').status).toBe('done');
    });

    it('is not done while the google-workspace MCP server is turned off', async () => {
      const result = await evaluateChecklist(catalog, deps({
        googleWorkspaceSignIn: async () => ({ state: 'signed_in', serverEnabled: false }),
      }));
      expect(task(result, 'google_workspace')).toMatchObject({ status: 'pending', detail: expect.stringMatching(/MCP Skills/) });
    });

    it('names the missing settings', async () => {
      const result = await evaluateChecklist(catalog, deps({
        googleWorkspaceSignIn: async () => ({ state: 'not_configured', missing: ['Curia’s Google address', 'the OAuth client secret'] }),
      }));
      expect(task(result, 'google_workspace').detail).toBe('Add Curia’s Google address, the OAuth client secret.');
    });

    it('passes on why Google rejected the token', async () => {
      const result = await evaluateChecklist(catalog, deps({
        googleWorkspaceSignIn: async () => ({ state: 'token_rejected', detail: 'Sign in again.' }),
      }));
      expect(task(result, 'google_workspace')).toMatchObject({ status: 'pending', detail: 'Sign in again.' });
    });

    it('reads pending, not done, when Google cannot be asked', async () => {
      const result = await evaluateChecklist(catalog, deps({
        googleWorkspaceSignIn: async () => { throw new Error('unreachable'); },
      }));
      expect(task(result, 'google_workspace').detail).toMatch(/Could not check/);
      expect(result.missing).toEqual(['google_workspace']);
    });
  });

  it('gives every pending task a detail, including the optional extras on a new install', async () => {
    const result = await evaluateChecklist(catalog, deps({
      identityConfigured: async () => false,
      emailChannelStatus: async () => 'not_configured',
      googleWorkspaceSignIn: async () => ({ state: 'not_configured', missing: ['Curia’s Google address'] }),
    }, { setupFor: null, messagingRoute: null, voiceRoute: null }));
    const pending = result.tasks.filter((t) => t.status === 'pending');
    expect(pending.map((t) => t.id)).toEqual(expect.arrayContaining(['principal_mailboxes', 'web_browser', 'google_workspace', 'who']));
    for (const t of pending) expect(t.detail, t.id).toBeTruthy();
  });

  it('gives a task no detail once it is done', async () => {
    const result = await evaluateChecklist(catalog, deps());
    for (const t of result.tasks.filter((x) => x.status === 'done')) expect(t, t.id).not.toHaveProperty('detail');
  });

  it('never exposes the completion check', async () => {
    const result = await evaluateChecklist(catalog, deps());
    for (const t of result.tasks) expect(t).not.toHaveProperty('completion_check');
  });

  it('evaluates a minimal catalog', async () => {
    const mini: CatalogTask[] = [{
      id: 'only', label: 'Only', value_prop: 'v', tier: 'instant', handoff: 'console',
      completion_check: { type: 'always_available' }, credential_how_to: null, docs_url: null,
    }];
    expect((await evaluateChecklist(mini, deps())).setupComplete).toBe(true);
  });
});
