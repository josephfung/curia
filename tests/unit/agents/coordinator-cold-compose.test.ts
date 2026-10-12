// tests/unit/agents/coordinator-cold-compose.test.ts
//
// The coordinator's cold-compose routing (#2014). It used to ask the principal for any
// recipient address missing from <resolved_entities>, so the principal's mail history was
// never searched. It now delegates to ceo-inbox, which searches it. Since prompt trim PR 8
// the rule is ceo-inbox's roster line (`delegate_when`), not a coordinator prompt section.

import { describe, it, expect } from 'vitest';
import { loadAgentConfig, loadAllAgentConfigs } from '../../../src/agents/loader.js';
import { AgentRegistry } from '../../../src/agents/agent-registry.js';
import { registerAgentRoster } from '../../../src/startup/agent-assembly.js';
import * as path from 'node:path';

const agentsDir = path.resolve(import.meta.dirname, '../../../agents');
const prompt = loadAgentConfig(path.join(agentsDir, 'coordinator.yaml')).system_prompt;

function roster(): string {
  const registry = new AgentRegistry();
  registerAgentRoster(registry, loadAllAgentConfigs(agentsDir));
  return registry.specialistSummary();
}

describe('coordinator cold-compose recipients (#2014)', () => {
  it('delegates an address-less recipient to ceo-inbox instead of asking the principal', () => {
    expect(prompt).not.toMatch(/ask the principal for the full address/);
    const line = roster().split('\n').find(l => l.startsWith('- @ceo-inbox: '));
    expect(line).toMatch(/If one has no address on file or isn't a contact, delegate with their name and organization/);
  });
});
