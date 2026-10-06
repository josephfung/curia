// tests/unit/agents/coordinator-cold-compose.test.ts
//
// The coordinator's cold-compose routing (#2014). It used to ask the principal for any
// recipient address missing from <resolved_entities>, so the principal's mail history was
// never searched. It now delegates to ceo-inbox, which searches it.

import { describe, it, expect } from 'vitest';
import { loadAgentConfig } from '../../../src/agents/loader.js';
import * as path from 'node:path';

const agentsDir = path.resolve(import.meta.dirname, '../../../agents');
const prompt = loadAgentConfig(path.join(agentsDir, 'coordinator.yaml')).system_prompt;

describe('coordinator prompt — cold-compose recipients (#2014)', () => {
  it('no longer asks the principal for an address before ceo-inbox has searched', () => {
    expect(prompt).not.toMatch(/ask the principal for the full address/);
  });

  it('delegates an address-less recipient to ceo-inbox with name and organization', () => {
    expect(prompt).toMatch(/Delegate the compose to ceo-inbox anyway, naming the recipient plus their\s+organization/);
  });

  it('never invents an address itself', () => {
    expect(prompt).toMatch(/Never invent or guess an address yourself/);
  });

  it('reports a saved draft without pasting it', () => {
    expect(prompt).toMatch(/do\s+not\s+paste\s+the\s+full\s+draft\s+unless\s+they\s+ask\s+for\s+it/);
  });
});
