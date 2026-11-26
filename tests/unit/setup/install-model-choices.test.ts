// Guards the models the installers offer for OpenRouter and Bedrock (#2749). The list lives
// in scripts/setup-common.sh (INSTALL_MODEL_CHOICES), so it is read by sourcing that file:
// every offered model must boot, and the block the installer writes must be valid YAML that
// routes each tier and judge to the chosen provider.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as yaml from 'js-yaml';
import pino from 'pino';
import { ModelRegistry } from '../../../src/agents/llm/model-registry.js';
import { smallCapModelSlots, smallCapThinkingViolations } from '../../../src/agents/llm/small-cap-models.js';
import type { YamlConfig } from '../../../src/config.js';

const commonSh = resolve(import.meta.dirname, '../../../scripts/setup-common.sh');
const registry = new ModelRegistry(pino({ level: 'silent' }));
const registered = registry.getAllModels();

/** Run `script` in bash after sourcing setup-common.sh; returns stdout. */
function bash(script: string, ...args: string[]): string {
  return execFileSync('bash', ['-c', `source "$0"; ${script}`, commonSh, ...args], { encoding: 'utf8' });
}

interface Choice { provider: string; slot: string; model: string; label: string }

const choices: Choice[] = bash('printf "%s\\n" "${INSTALL_MODEL_CHOICES[@]}"')
  .split('\n')
  .filter((l) => l.length > 0)
  .map((l) => {
    const [provider = '', slot = '', model = '', ...label] = l.split('|');
    return { provider, slot, model, label: label.join('|') };
  });

const PROVIDERS = ['openrouter', 'bedrock'] as const;
const SLOTS = ['fast', 'standard', 'powerful', 'judge'] as const;

/** The model the installer picks for menu answer `answer` (empty = recommended). */
function pick(provider: string, slot: string, answer = ''): string {
  return bash('model_for_choice "$1" "$2" "$3"', provider, slot, answer);
}

describe('INSTALL_MODEL_CHOICES', () => {
  it('only offers OpenRouter and Bedrock, in the four slots', () => {
    expect(choices.length).toBeGreaterThan(0);
    for (const c of choices) {
      expect(PROVIDERS as readonly string[]).toContain(c.provider);
      expect(SLOTS as readonly string[]).toContain(c.slot);
      expect(c.label.length).toBeGreaterThan(0);
    }
  });

  it('offers at least one model for every provider and slot', () => {
    for (const provider of PROVIDERS) {
      for (const slot of SLOTS) {
        expect(choices.some((c) => c.provider === provider && c.slot === slot), `${provider} ${slot}`).toBe(true);
      }
    }
  });

  it.each(choices)('$provider $slot: $model is a registry key of that provider, with tools', (c) => {
    // An exact key, not a prefix match: a prefix match prices and sizes it as another model.
    expect(Object.hasOwn(registered, c.model)).toBe(true);
    expect(registry.getProvider(c.model)).toBe(c.provider);
    expect(registry.getModel(c.model)?.capabilities).toContain('tools');
  });

  it.each(choices.filter((c) => c.slot === 'fast' || c.slot === 'judge'))(
    '$provider $slot: $model can turn thinking off (small-cap call sites)',
    (c) => {
      expect(registry.canTurnThinkingOff(c.model)).toBe(true);
    },
  );

  it.each(choices.filter((c) => c.provider === 'openrouter' && c.slot === 'fast'))(
    'openrouter fast: $model streams, so voice can run on it',
    (c) => {
      expect(registry.getModel(c.model)?.capabilities).toContain('streaming');
    },
  );
});

describe('model_for_choice', () => {
  it('picks the recommended model for an empty, non-numeric or out-of-range answer', () => {
    const first = choices.find((c) => c.provider === 'openrouter' && c.slot === 'standard')!.model;
    for (const answer of ['', 'x', '0', '99']) expect(pick('openrouter', 'standard', answer)).toBe(first);
  });

  it('picks the numbered model', () => {
    const second = choices.filter((c) => c.provider === 'openrouter' && c.slot === 'standard')[1]!.model;
    expect(pick('openrouter', 'standard', '2')).toBe(second);
  });

  it('is empty for anthropic, which keeps default.yaml', () => {
    expect(pick('anthropic', 'fast')).toBe('');
  });
});

describe('model_config_block', () => {
  it.each(PROVIDERS)('%s: the recommended models make a config that boot accepts', (provider) => {
    const [fast, standard, powerful, judge] = SLOTS.map((s) => pick(provider, s));
    const block = bash('model_config_block "$@"', provider, fast!, standard!, powerful!, judge!);
    const parsed = yaml.load(block) as YamlConfig;

    expect(parsed.model_routing?.tiers.fast?.model).toBe(fast);
    expect(parsed.model_routing?.tiers.standard?.model).toBe(standard);
    expect(parsed.model_routing?.tiers.powerful?.model).toBe(powerful);
    expect(parsed.filter?.llmJudge?.model).toBe(judge);
    expect(parsed.escalation?.judge?.model).toBe(judge);
    for (const model of [fast, standard, powerful, judge]) expect(registry.getProvider(model!)).toBe(provider);
    expect(smallCapThinkingViolations(smallCapModelSlots(parsed), registry)).toEqual([]);
  });
});
