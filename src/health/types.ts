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
