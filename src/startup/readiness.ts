// src/startup/readiness.ts
//
// Startup readiness check runner. After bootstrap completes, the system
// runs all registered checks. If any fail, the system enters setup-required
// mode and refuses to accept inbound messages.
//
// See docs/wip/2026-05-10-principal-identity-design.md

export interface ReadinessCheck {
  /** Short name for logging (e.g. 'principal-contact') */
  name: string;
  /** Returns { ready: true } or { ready: false, reason } */
  check: () => Promise<ReadinessResult>;
}

export interface ReadinessResult {
  ready: boolean;
  reason?: string;
}

export interface ReadinessReport {
  ready: boolean;
  failures: Array<{ name: string; reason: string }>;
}

/**
 * Run all readiness checks and return a report.
 * Checks run sequentially (they may share DB connections).
 * A check that throws is treated as a failure.
 */
export async function runReadinessChecks(
  checks: ReadinessCheck[],
): Promise<ReadinessReport> {
  const failures: Array<{ name: string; reason: string }> = [];

  for (const check of checks) {
    try {
      const result = await check.check();
      if (!result.ready) {
        failures.push({ name: check.name, reason: result.reason ?? 'check failed' });
      }
    } catch (err) {
      failures.push({
        name: check.name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ready: failures.length === 0,
    failures,
  };
}
