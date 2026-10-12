// agent-registry.ts — tracks all running agents in the system.
//
// The registry is populated at startup when agent YAML configs are loaded.
// It provides lookup by name (for the delegate skill to verify targets),
// listing (for the Coordinator to know which specialists are available),
// and a summary method (the specialist roster in the Coordinator's system
// prompt and in ${available_specialists}).

export interface AgentRegistryEntry {
  name: string;
  role: string;
  description: string;
  /** Agent YAML `delegate_when`: the agent's roster line. Absent → `description`. */
  delegateWhen?: string;
  /**
   * Agent YAML `display_name` (#1860). Delegation-failure replies reject a
   * draft that uses it rather than showing it (#1975).
   * Absent when the file does not set one — callers derive a label from `name`.
   */
  displayName?: string;
  /** Expected wall-clock duration for delegate calls targeting this agent, in seconds.
   *  When set, the runtime injects timeout_ms into delegate calls, overriding anything the
   *  model emitted (#1797). Used only when the scheduler supplied no expectedDurationSeconds.
   *  See issue #387. */
  expectedDurationSeconds?: number;
}

export class AgentRegistry {
  private agents = new Map<string, AgentRegistryEntry>();

  register(name: string, info: Omit<AgentRegistryEntry, 'name'>): void {
    if (this.agents.has(name)) {
      throw new Error(`Agent '${name}' is already registered`);
    }
    this.agents.set(name, { name, ...info });
  }

  get(name: string): AgentRegistryEntry | undefined {
    return this.agents.get(name);
  }

  has(name: string): boolean {
    return this.agents.has(name);
  }

  list(): AgentRegistryEntry[] {
    return Array.from(this.agents.values());
  }

  listSpecialists(): AgentRegistryEntry[] {
    return this.list().filter(a => a.role !== 'coordinator');
  }

  /**
   * The roster: one line per specialist saying when to delegate to it. Agents without a
   * `delegate_when` (curia-deploy's custom agents, for now) show their description.
   */
  specialistSummary(): string {
    const specialists = this.listSpecialists();
    if (specialists.length === 0) {
      return 'No specialist agents are currently available.';
    }
    return specialists
      .map(s => `- @${s.name}: ${(s.delegateWhen ?? s.description).trim()}`)
      .join('\n');
  }

  /**
   * Specialists that will inherit `delegate.defaultTimeoutMs` (#1857).
   * The coordinator is not a delegate target, so it is excluded. Names are
   * sorted so the startup warning is stable across process starts.
   */
  specialistsWithoutDurationHint(): string[] {
    return this.listSpecialists()
      .filter((agent) => !isUsableDurationHint(agent.expectedDurationSeconds))
      .map((agent) => agent.name)
      .sort((a, b) => a.localeCompare(b));
  }
}

function isUsableDurationHint(value: number | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Startup warning text. Names are in the message so a text log line is enough. */
export function missingDurationHintWarning(names: readonly string[]): string {
  return `Specialists with no expected_duration_seconds inherit delegate.defaultTimeoutMs: ${names.join(', ')}`;
}
