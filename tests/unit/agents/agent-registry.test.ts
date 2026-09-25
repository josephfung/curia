import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRegistry, missingDurationHintWarning } from '../../../src/agents/agent-registry.js';
import { loadAllAgentConfigs } from '../../../src/agents/loader.js';

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

  it('stores an optional principal-facing display name (#1860)', () => {
    registry.register('social-media', {
      role: 'specialist',
      description: 'Drafts posts',
      displayName: 'social team',
    });
    expect(registry.get('social-media')?.displayName).toBe('social team');
  });

  it('names specialists that declare no duration hint, excluding the coordinator (#1857)', () => {
    registry.register('coordinator', { role: 'coordinator', description: 'Main' });
    registry.register('calendar', { role: 'specialist', description: 'Calendar', expectedDurationSeconds: 300 });
    registry.register('contacts', { role: 'specialist', description: 'Contacts' });
    registry.register('diagnostics', { role: 'specialist', description: 'Diagnostics', expectedDurationSeconds: 0 });
    expect(registry.specialistsWithoutDurationHint()).toEqual(['contacts', 'diagnostics']);
    expect(missingDurationHintWarning(registry.specialistsWithoutDurationHint()))
      .toBe('Specialists with no expected_duration_seconds inherit delegate.defaultTimeoutMs: contacts, diagnostics');
  });

  it('names the shipped specialists that still inherit the floor (#1857)', () => {
    const registry = new AgentRegistry();
    for (const config of loadAllAgentConfigs(join(import.meta.dirname, '../../../agents'))) {
      registry.register(config.name, {
        role: config.role ?? 'specialist',
        description: config.description ?? config.name,
        expectedDurationSeconds: config.expected_duration_seconds,
      });
    }
    // contacts (p99 155s), diagnostics (p99 47s), and setup-wizard (unmeasured)
    // are covered by the 450s floor. A new specialist without a hint fails this list.
    expect(registry.specialistsWithoutDurationHint()).toEqual([
      'contacts',
      'diagnostics',
      'setup-wizard',
    ]);
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
