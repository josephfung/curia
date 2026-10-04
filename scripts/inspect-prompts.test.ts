// inspect-prompts snapshot (curia-deploy#261). The snapshot must carry exactly the
// coordinator's prompt inputs — curia-deploy renders every agent from it — and must
// refuse to emit one with a coordinator block missing.

import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../src/agents/runtime.js';
import type { AssembledAgent } from '../src/startup/agent-assembly.js';
import { buildPromptInputsSnapshot } from './inspect-prompts.js';

const AGENT_CONTACT_ID = '11111111-1111-4111-8111-111111111111';
const PRINCIPAL_CONTACT_ID = '22222222-2222-4222-8222-222222222222';

function coordinatorConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    agentId: 'coordinator',
    systemPrompt: 'body',
    officeIdentityService: { compileSystemPromptBlock: () => '## Identity\nYou are Curia.' },
    securityContextBlock: '## Security\nPolicy.',
    availableSpecialists: '- @researcher: Looks things up',
    autonomyService: {
      getConfig: async () => ({ score: 82, band: 'spot-check', updatedAt: new Date(0), updatedBy: 'principal' }),
    },
    timezone: 'America/Toronto ',
    channelAccounts: { email: 'curia@example.com', phone: undefined },
    agentContactId: AGENT_CONTACT_ID,
    principalIdentities: [
      { channel: 'email', channelIdentifier: 'p@example.com', label: 'work', verified: true, status: 'active' },
      { channel: 'signal', channelIdentifier: '+15550001111', label: null, verified: true, status: 'active' },
    ],
    principalPrimaryEmail: { current: 'p@example.com' },
    ...overrides,
  } as unknown as AgentConfig;
}

function stackWith(rc: AgentConfig, opts: { noPrincipal?: boolean } = {}) {
  const principalContactId = opts.noPrincipal ? undefined : PRINCIPAL_CONTACT_ID;
  return {
    agent: (name: string) => {
      if (name !== 'coordinator') throw new Error(`Agent '${name}' is not loaded in this stack`);
      return { runtimeConfig: rc } as AssembledAgent;
    },
    principalContactId,
  };
}

describe('buildPromptInputsSnapshot', () => {
  it('emits every coordinator prompt input and the curia version', async () => {
    const snapshot = await buildPromptInputsSnapshot(stackWith(coordinatorConfig()), '0.44.0');
    expect(snapshot).toMatchObject({
      curia: { version: '0.44.0' },
      timezone: 'America/Toronto',
      office_identity_block: '## Identity\nYou are Curia.',
      security_context_block: '## Security\nPolicy.',
      available_specialists: '- @researcher: Looks things up',
      autonomy: { score: 82, band: 'spot-check' },
      agent_contact_id: AGENT_CONTACT_ID,
      principal_contact_id: PRINCIPAL_CONTACT_ID,
      principal_identities: [
        { channel: 'email', channel_identifier: 'p@example.com', label: 'work' },
        { channel: 'signal', channel_identifier: '+15550001111', label: null },
      ],
      principal_primary_email: 'p@example.com',
      channel_accounts: { email: 'curia@example.com', phone: null },
    });
  });

  it('no longer emits executive_voice_block (its injection was removed in #957)', async () => {
    const snapshot = await buildPromptInputsSnapshot(stackWith(coordinatorConfig()), '0.44.0');
    expect(snapshot).not.toHaveProperty('executive_voice_block');
    expect(snapshot).not.toHaveProperty('coordinator');
  });

  it('carries only the identity fields the principal block renders', async () => {
    const snapshot = await buildPromptInputsSnapshot(stackWith(coordinatorConfig()), '0.44.0');
    for (const identity of snapshot.principal_identities) {
      expect(Object.keys(identity).sort()).toEqual(['channel', 'channel_identifier', 'label']);
    }
  });

  it('records a missing autonomy row and a missing principal as null', async () => {
    const rc = coordinatorConfig({
      autonomyService: { getConfig: async () => null } as unknown as AgentConfig['autonomyService'],
    });
    const snapshot = await buildPromptInputsSnapshot(stackWith(rc, { noPrincipal: true }), '0.44.0');
    expect(snapshot.autonomy).toBeNull();
    expect(snapshot.principal_contact_id).toBeNull();
  });

  it.each([
    ['officeIdentityService', { officeIdentityService: undefined }],
    ['securityContextBlock', { securityContextBlock: undefined }],
    ['availableSpecialists', { availableSpecialists: undefined }],
    ['autonomyService', { autonomyService: undefined }],
    ['timezone', { timezone: '  ' }],
  ] as const)('refuses to emit a snapshot when the coordinator has no %s', async (_field, overrides) => {
    await expect(
      buildPromptInputsSnapshot(stackWith(coordinatorConfig(overrides as Partial<AgentConfig>)), '0.44.0'),
    ).rejects.toThrow(/coordinator runtime config has no/);
  });

  it('fails when the coordinator is not loaded', async () => {
    const stack = { agent: () => { throw new Error("Agent 'coordinator' is not loaded in this stack"); }, principalContactId: undefined };
    await expect(buildPromptInputsSnapshot(stack, '0.44.0')).rejects.toThrow(/not loaded/);
  });
});
