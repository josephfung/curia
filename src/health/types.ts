// types.ts — shared types for the health observability module.

export type CheckResult = 'ok' | 'fail' | 'skipped';

export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface HealthResponse {
  status: HealthStatus;
  uptime_s: number;
  checks: {
    db: CheckResult;
    bus: CheckResult;
    signal: CheckResult;
    email: CheckResult;
    browser: CheckResult;
    /** Per enabled MCP server (hyphens → underscores). Empty when none enabled. */
    mcp: Record<string, CheckResult>;
    /** Principal calendar grant (`ceo_nylas_grant_id`); skipped when calendar client absent. */
    nylas_calendar: CheckResult;
    /** Slack Socket Mode; skipped when Slack adapter not constructed (#1567). */
    slack: CheckResult;
    /** SMS/Telnyx webhook readiness; skipped when SMS adapter not constructed (#1567). */
    sms: CheckResult;
    /** Voice/LiveKit management reachability; skipped when voice adapter absent (#1567). */
    voice: CheckResult;
    /**
     * Signal voice-CALL audio path: the shared PulseAudio socket (#1760). Skipped
     * when the Signal call bridge was not constructed.
     *
     * Deliberately a sibling of `voice` rather than nesting it as
     * `voice: { livekit, signal }`. The nested shape reads better, but `checks` is a
     * public API surface consumed by the console and by external monitoring, and
     * changing `voice` from CheckResult to an object breaks every existing consumer.
     * Additive keys cost nothing: the console derives its chips by iterating
     * `Object.entries(checks)`, so this renders with no console change.
     */
    signal_voice: CheckResult;
    scheduler: CheckResult;
  };
}

export interface CanaryResult {
  name: string;
  status: 'ok' | 'fail' | 'skipped';
  detail?: string;
}

// Keys the LlmOutcomeTracker records against.
// LLM tiers match the model_routing tier names.
// 'embeddings' and 'image_gen' track OpenAI-backed capability calls.
export type TrackerKey = 'fast' | 'standard' | 'powerful' | 'embeddings' | 'image_gen';

export interface TierOutcome {
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  /** Which kind of call was recorded most recently. Authoritative for health derivation —
   *  comparing lastErrorAt > lastSuccessAt is unreliable when both land in the same
   *  millisecond (Date has 1ms granularity), which would silently mask a same-ms error. */
  lastOutcome: 'success' | 'error' | null;
}
