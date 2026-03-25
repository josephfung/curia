import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRegistry } from '../../../src/agents/agent-registry.js';

describe('AgentRegistry', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry();
  });

  it('registers and retrieves an agent by name', () => {
    registry.register('coordinator', { role: 'coordinator', description: 'Main coordinator' });
    const agent = registry.get('coordinator');
    expect(agent).toBeDefined();
    expect(agent!.role).toBe('coordinator');
  });

  it('returns undefined for unknown agent', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('lists all registered agents', () => {
    registry.register('coordinator', { role: 'coordinator', description: 'Main coordinator' });
    registry.register('research-analyst', { role: 'specialist', description: 'Research and analysis' });
    const all = registry.list();
    expect(all).toHaveLength(2);
    expect(all.map(a => a.name)).toEqual(['coordinator', 'research-analyst']);
  });

  it('lists only specialist agents (excludes coordinator)', () => {
    registry.register('coordinator', { role: 'coordinator', description: 'Main coordinator' });
    registry.register('research-analyst', { role: 'specialist', description: 'Research' });
    registry.register('expense-tracker', { role: 'specialist', description: 'Expenses' });
    const specialists = registry.listSpecialists();
    expect(specialists).toHaveLength(2);
    expect(specialists.map(a => a.name)).toEqual(['research-analyst', 'expense-tracker']);
  });

  it('throws on duplicate registration', () => {
    registry.register('dup', { role: 'specialist', description: 'First' });
    expect(() => registry.register('dup', { role: 'specialist', description: 'Second' }))
      .toThrow(/already registered/);
  });

  it('checks existence without retrieving', () => {
    registry.register('research-analyst', { role: 'specialist', description: 'Research' });
    expect(registry.has('research-analyst')).toBe(true);
    expect(registry.has('nonexistent')).toBe(false);
  });

  it('generates a specialist summary for LLM context', () => {
    registry.register('coordinator', { role: 'coordinator', description: 'Main coordinator' });
    registry.register('research-analyst', { role: 'specialist', description: 'Conducts web research and summarizes findings' });
    registry.register('expense-tracker', { role: 'specialist', description: 'Tracks expenses from receipts and emails' });
    const summary = registry.specialistSummary();
    expect(summary).toContain('research-analyst');
    expect(summary).toContain('Conducts web research');
    expect(summary).toContain('expense-tracker');
    expect(summary).not.toContain('coordinator');
  });
});
