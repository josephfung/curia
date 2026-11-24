// draft.ts — turn the stored history summary into the three deep-dive drafts (#2362).
//
// readDraftInputs gathers what drafting reads: the summary plus what is already established
// (stated preferences, working hours, the research brief, the current rules documents and the
// voice profile). draftDocuments makes one powerful-tier call per draft, publishes llm.call for
// each as InfraLlmService does, and sums spend from each response's usage. Drafting is system
// code, not a skill, so it calls the model router directly rather than widening InfraLlm (design
// §4). Its deps hold no mailbox client: everything it knows about the mailbox is the summary.
// A non-text response or a provider error throws, and the run marks itself failed.
import { createHash } from 'node:crypto';
import type { EventBus } from '../../bus/bus.js';
import { createLlmCall } from '../../bus/events.js';
import type { LLMProvider, LLMResponse } from '../../agents/llm/provider.js';
import type { ModelRouter } from '../../agents/llm/model-router.js';
import type { ModelRegistry } from '../../agents/llm/model-registry.js';
import type { createEstimateCostUsd } from '../../agents/llm/pricing.js';
import { llmCallReasoningFields } from '../../agents/llm/llm-call-reasoning.js';
import { buildLlmArchiveResponse } from '../../audit/llm-archive-response.js';
import type { WorkingDocsRepo } from '../../db/working-docs-repo.js';
import type { ExecutiveProfileService } from '../../executive/service.js';
import type { OfficeIdentityService } from '../../identity/service.js';
import type { Logger } from '../../logger.js';
import { INBOX_RULES_PATH } from '../../principal-mailboxes/rules-doc.js';
import { RESEARCH_BRIEF_PATH } from '../playbook.js';
import { DRAFT_MAX_TOKENS } from './limits.js';
import type { HistorySummary } from './history-summary.js';
import { buildDraftPrompt, DRAFT_KINDS, DRAFT_PREAMBLE, type DraftInputs, type DraftKind } from './prompts.js';

export type { DraftInputs, DraftKind } from './prompts.js';

/** Where the calendar agent keeps its scheduling rules (agents/calendar.yaml pinned_context). */
export const CALENDAR_RULES_PATH = '/shared/calendar/rules.md';

/** agentId on the llm.call events drafting publishes. */
const DRAFT_AGENT_ID = 'system:onboarding-deep-dive';

export interface ReadDraftInputsDeps {
  workingDocsRepo: Pick<WorkingDocsRepo, 'read'>;
  executiveProfile: Pick<ExecutiveProfileService, 'get'>;
  /** Behavioral preferences live on the office identity, not the executive profile. */
  officeIdentity: Pick<OfficeIdentityService, 'get'>;
  /** The principal's working-hours KG fact, as stored; null when none is recorded. */
  readWorkingHours: () => Promise<string | null>;
}

export async function readDraftInputs(deps: ReadDraftInputsDeps, summary: HistorySummary): Promise<DraftInputs> {
  const body = async (path: string): Promise<string | null> => (await deps.workingDocsRepo.read(path))?.body ?? null;
  const [inboxRules, calendarRules, researchBrief, workingHours] = await Promise.all([
    body(INBOX_RULES_PATH),
    body(CALENDAR_RULES_PATH),
    body(RESEARCH_BRIEF_PATH),
    deps.readWorkingHours(),
  ]);
  const preferences = deps.officeIdentity.get().behavioralPreferences;
  return {
    summary,
    behavioralPreferences: preferences.length > 0 ? preferences.map((p) => `- ${p}`).join('\n') : null,
    workingHours,
    researchBrief,
    inboxRules,
    calendarRules,
    voice: deps.executiveProfile.get().writingVoice,
  };
}

/**
 * Drafting reads the mailbox only through the stored summary (ruling 2). Never add a mailbox
 * client here, and build this object explicitly at the call site rather than spreading a wider
 * deps bag into it, so one cannot arrive by accident.
 */
export interface DraftDeps {
  providerRouter: LLMProvider;
  modelRouter: ModelRouter;
  bus: EventBus;
  estimateCost: ReturnType<typeof createEstimateCostUsd>;
  modelRegistry: ModelRegistry;
  logger: Logger;
}

/** A draft failed; carries the spend of the calls already made so the run can record it. */
export class DraftError extends Error {
  constructor(message: string, readonly spendUsd: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DraftError';
  }
}

type TextResponse = Extract<LLMResponse, { type: 'text' }>;

async function publishLlmCall(deps: DraftDeps, response: TextResponse, prompt: string, latencyMs: number, costUsd: number): Promise<void> {
  try {
    const { usage, provenance } = response;
    const event = createLlmCall({
      agentId: DRAFT_AGENT_ID,
      conversationId: 'system',
      requestedModel: provenance.requestedModel,
      actualModel: provenance.actualModel,
      provider: deps.modelRegistry.getProvider(provenance.actualModel) ?? 'unknown',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      estimatedCostUsd: costUsd,
      latencyMs,
      providerRequestId: provenance.providerRequestId,
      promptHash: createHash('sha256').update(prompt).digest('hex'),
      responseHash: createHash('sha256').update(response.content).digest('hex'),
      temperature: null,
      ...llmCallReasoningFields(usage, provenance),
      parentEventId: 'system',
      archive: { prompt: { text: prompt }, response: buildLlmArchiveResponse(response) },
    });
    await deps.bus.publish('agent', event);
  } catch (err) {
    // Telemetry failure must not lose a paid draft — log and continue, as InfraLlmService does.
    deps.logger.warn({ err }, 'deep-dive drafting: failed to publish llm.call telemetry event');
  }
}

async function draftOne(deps: DraftDeps, kind: DraftKind, inputs: DraftInputs): Promise<{ text: string; costUsd: number }> {
  const resolved = deps.modelRouter.resolve('powerful');
  const prompt = buildDraftPrompt(kind, inputs);
  const start = Date.now();
  const response = await deps.providerRouter.chat({
    model: resolved.model,
    messages: [{ role: 'user', content: prompt }],
    options: { max_tokens: DRAFT_MAX_TOKENS, ...(resolved.reasoning ? { reasoning: resolved.reasoning } : {}) },
  });
  const latencyMs = Date.now() - start;
  if (response.type !== 'text') {
    const reason = response.type === 'error' ? response.error.message : `non-text response (${response.type})`;
    deps.logger.error({ kind, model: resolved.model, type: response.type }, 'deep-dive drafting: model call failed');
    throw new DraftError(`deep-dive draft "${kind}" failed: ${reason}`, 0);
  }
  const costUsd = deps.estimateCost(response.provenance.actualModel, response.usage, deps.logger);
  await publishLlmCall(deps, response, prompt, latencyMs, costUsd);
  if (response.content.trim() === '') {
    // A reasoning model that thinks through the whole output cap returns empty text.
    deps.logger.error({ kind, model: resolved.model, costUsd }, 'deep-dive drafting: model returned an empty draft');
    throw new DraftError(`deep-dive draft "${kind}" failed: empty response`, costUsd);
  }
  if (!response.content.trimStart().startsWith(DRAFT_PREAMBLE)) {
    deps.logger.warn({ kind, model: resolved.model }, 'deep-dive drafting: draft does not open with the preamble');
  }
  return { text: response.content, costUsd };
}

/**
 * One powerful-tier call per draft, in order. Throws a DraftError on the first failure, with
 * `spendUsd` covering every call made so far (the failed one included when it was billed).
 */
export async function draftDocuments(
  deps: DraftDeps,
  inputs: DraftInputs,
): Promise<{ drafts: Record<DraftKind, string>; spendUsd: number }> {
  const drafts = {} as Record<DraftKind, string>;
  let spendUsd = 0;
  for (const kind of DRAFT_KINDS) {
    let result: { text: string; costUsd: number };
    try {
      result = await draftOne(deps, kind, inputs);
    } catch (err) {
      const failedCost = err instanceof DraftError ? err.spendUsd : 0;
      const message = err instanceof Error ? err.message : String(err);
      throw new DraftError(message, spendUsd + failedCost, { cause: err });
    }
    drafts[kind] = result.text;
    spendUsd += result.costUsd;
  }
  deps.logger.info({ spendUsd }, 'deep-dive drafting: drafts written');
  return { drafts, spendUsd };
}
