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
  it('delegates an address-less recipient to ceo-inbox instead of asking the principal', () => {
    expect(prompt).not.toMatch(/ask the principal for the full address/);
    expect(prompt).toMatch(/If one has no address on file or\s+isn't a contact, delegate with their name and organization/);
  });
});
