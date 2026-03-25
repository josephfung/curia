// agent-registry.ts — tracks all running agents in the system.
//
// The registry is populated at startup when agent YAML configs are loaded.
// It provides lookup by name (for the delegate skill to verify targets),
// listing (for the Coordinator to know which specialists are available),
// and a summary method (for injecting specialist descriptions into the
// Coordinator's system prompt).

export interface AgentRegistryEntry {
  name: string;
  role: string;
  description: string;
}

export class AgentRegistry {
  private agents = new Map<string, AgentRegistryEntry>();

  register(name: string, info: { role: string; description: string }): void {
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

  specialistSummary(): string {
    const specialists = this.listSpecialists();
    if (specialists.length === 0) {
      return 'No specialist agents are currently available.';
    }
    return specialists
      .map(s => `- @${s.name}: ${s.description}`)
      .join('\n');
  }
}
