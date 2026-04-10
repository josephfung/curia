// drift-detector.ts — LLM-as-judge check for persistent task intent drift.
//
// After each burst of a persistent scheduled task, the Scheduler calls check()
// with the task's intent_anchor, current task_payload, and optional last_run_summary.
// The LLM returns a structured verdict. shouldPause() applies the configured
// confidence threshold to decide whether the task should be paused.
//
// Failure modes are all fail-open: any LLM error, timeout, or malformed response
// is treated as "no drift" so the task continues. The failure is logged at warn.
//
// TODO: When multi-model support is added, make the LLM provider here independently
// configurable from the coordinator's provider (cheaper/faster model for this check).

import type { LLMProvider } from '../agents/llm/provider.js';
import type { Logger } from '../logger.js';

export type DriftConfidence = 'high' | 'medium' | 'low';

export interface DriftVerdict {
  drifted: boolean;
  reason: string;
  confidence: DriftConfidence;
}

export interface DriftConfig {
  enabled: boolean;
  /** Run the check every N bursts. 1 = every burst (default). */
  checkEveryNBursts: number;
  /** Minimum LLM confidence required to trigger a pause. */
  minConfidenceToPause: DriftConfidence;
}

export interface DriftCheckParams {
  intentAnchor: string;
  taskPayload: Record<string, unknown>;
  lastRunSummary?: string | null;
}

// Confidence levels ordered from lowest to highest for threshold comparison.
const CONFIDENCE_ORDER: Record<DriftConfidence, number> = { low: 0, medium: 1, high: 2 };

export class DriftDetector {
  constructor(
    private readonly provider: LLMProvider,
    private readonly config: DriftConfig,
    private readonly logger: Logger,
  ) {}

  /** Expose for Scheduler burst-counting logic. */
  get checkEveryNBursts(): number {
    return this.config.checkEveryNBursts;
  }

  /**
   * Ask the LLM whether the current task has drifted from the original intent.
   * Returns null if the check is skipped (disabled config) or if the LLM call fails.
   * Returns the verdict otherwise.
   */
  async check(params: DriftCheckParams): Promise<DriftVerdict | null> {
    if (!this.config.enabled) return null;

    const { intentAnchor, taskPayload, lastRunSummary } = params;

    const userLines = [
      '## Original intent',
      intentAnchor,
      '',
      '## Current task description',
      JSON.stringify(taskPayload, null, 2),
    ];

    if (lastRunSummary) {
      userLines.push('', '## What the agent did on its last run', lastRunSummary);
    }

    userLines.push('', 'Has this task drifted significantly from its original intent?');

    const systemPrompt =
      'You are a task integrity auditor. Your job is to determine whether a scheduled ' +
      'task has drifted significantly from its original mandate.\n\n' +
      'Respond ONLY with a JSON object in this exact format, no other text:\n' +
      '{"drifted": boolean, "reason": "one sentence", "confidence": "high"|"medium"|"low"}';

    let raw: string;
    try {
      const response = await this.provider.chat({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userLines.join('\n') },
        ],
        options: { max_tokens: 200, temperature: 0 },
      });

      if (response.type === 'error') {
        this.logger.warn(
          { err: response.error, provider: this.provider.id },
          'drift-detector: drift check failed — LLM returned error response; treating as no-drift',
        );
        return null;
      }

      if (response.type !== 'text') {
        this.logger.warn(
          { responseType: response.type },
          'drift-detector: drift check failed — unexpected non-text LLM response; treating as no-drift',
        );
        return null;
      }

      raw = response.content.trim();
    } catch (err) {
      this.logger.warn(
        { err, provider: this.provider.id },
        'drift-detector: drift check failed — LLM call threw; treating as no-drift',
      );
      return null;
    }

    // Parse and validate the JSON verdict.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn(
        { raw },
        'drift-detector: LLM returned malformed JSON verdict; treating as no-drift',
      );
      return null;
    }

    if (!isValidVerdict(parsed)) {
      this.logger.warn(
        { raw },
        'drift-detector: LLM returned invalid verdict shape; treating as no-drift',
      );
      return null;
    }

    return parsed;
  }

  /**
   * Returns true if the verdict indicates drift AND the confidence meets
   * the configured minimum threshold for triggering a pause.
   */
  shouldPause(verdict: DriftVerdict): boolean {
    if (!verdict.drifted) return false;
    return CONFIDENCE_ORDER[verdict.confidence] >= CONFIDENCE_ORDER[this.config.minConfidenceToPause];
  }
}

function isValidVerdict(value: unknown): value is DriftVerdict {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['drifted'] === 'boolean' &&
    typeof v['reason'] === 'string' &&
    (v['confidence'] === 'high' || v['confidence'] === 'medium' || v['confidence'] === 'low')
  );
}
