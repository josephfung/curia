// tests/scenarios/judge-models.ts — which judge model rates a case (#2556).
//
// Most cases are judged by JUDGE_MODEL (judge.ts). A case can name its own with
// `judge_model:`, and a tag can set one for every case it carries, here. Recipient-aware
// voice cases (`finesse`) need a stronger judge than the suite's default; the rest of the
// suite keeps the default, so its scores stay comparable across releases.
//
// A model listed here must have a priced entry in src/agents/llm/model-registry.ts:
// createJudge refuses one that has none, before any paid call.

/**
 * Judge model by tag. The `finesse` judge is chosen by agreement with human grades on the
 * pilot run (#2556 §4); until then those cases use the default.
 */
export const TAG_JUDGE_MODELS: Readonly<Record<string, string>> = {};

/**
 * The judge model a case asks for: its own `judge_model`, else its tag's, else undefined (the
 * suite default). Throws when two of its tags name different models: the choice would depend
 * on tag order.
 */
export function caseJudgeModel(
  scenario: { name: string; tags: readonly string[]; judgeModel?: string },
  tagModels: Readonly<Record<string, string>> = TAG_JUDGE_MODELS,
): string | undefined {
  if (scenario.judgeModel !== undefined) return scenario.judgeModel;
  const models = new Set(scenario.tags.flatMap(t => (Object.hasOwn(tagModels, t) ? [tagModels[t]!] : [])));
  if (models.size > 1) {
    throw new Error(`${scenario.name}: its tags set different judge models (${[...models].join(', ')}); set judge_model on the case`);
  }
  return models.values().next().value;
}
