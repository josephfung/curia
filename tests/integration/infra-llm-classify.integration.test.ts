// Integration test for InfraLlm.classify on the default fast-tier model (#2077).
//
// Gated on ANTHROPIC_API_KEY — the suite is skipped entirely in keyless CI.
// classify() sends max_tokens: 10. Haiku 5.5 thinks by default and thinking
// counts toward max_tokens, so without `thinking: {type: "disabled"}` the
// response can stop on max_tokens before any text. These cases call the real
// model with the extract-facts gate prompt and assert a yes/no answer comes back.

import { describe, it, expect } from 'vitest';
import { InfraLlmService } from '../../src/skills/infra-llm.js';
import { AnthropicProvider } from '../../src/agents/llm/anthropic.js';
import { ModelRegistry } from '../../src/agents/llm/model-registry.js';
import { ModelRouter } from '../../src/agents/llm/model-router.js';
import type { EventBus } from '../../src/bus/bus.js';
import { createSilentLogger } from '../../src/logger.js';

const RUN = !!process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-5-5';

const logger = createSilentLogger();

// Same wording as the extract-facts classifier gate (skills/extract-facts/handler.ts).
function factGatePrompt(text: string): string {
  return `Does the following text assert an attribute, fact, or characteristic about a single entity (for example: a person, organisation, project, event, or other entity — such as where they are located, their role, their status, or their preferences)? Answer only 'yes' or 'no'.\n\n${text}`;
}

function makeClassifier() {
  const registry = new ModelRegistry(logger);
  const provider = new AnthropicProvider(process.env.ANTHROPIC_API_KEY!, logger, registry);
  const router = new ModelRouter(
    {
      tiers: {
        fast: { model: MODEL },
        standard: { model: MODEL },
        powerful: { model: MODEL },
      },
      default_tier: 'fast',
    },
    registry,
    logger,
  );
  const bus = { publish: async () => undefined } as unknown as EventBus;
  return new InfraLlmService(provider, router, bus, logger, registry).scoped({ toolName: 'extract-facts' });
}

describe.skipIf(!RUN)(`InfraLlm.classify integration (${MODEL})`, () => {
  it('answers yes for a single-entity fact within the 10-token cap', async () => {
    const result = await makeClassifier().classify(factGatePrompt('Priya Shah is the CFO of Northwind and is based in Toronto.'));
    expect(result.ok).toBe(true);
    expect(result.ok && result.text.toLowerCase().trim()).toMatch(/^yes/);
  }, 20000);

  it('answers no for a scheduling request within the 10-token cap', async () => {
    const result = await makeClassifier().classify(factGatePrompt('Can you move tomorrow\'s 3pm call to Thursday?'));
    expect(result.ok).toBe(true);
    expect(result.ok && result.text.toLowerCase().trim()).toMatch(/^no/);
  }, 20000);
});
