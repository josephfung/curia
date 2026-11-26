// schedule-skills.test.ts — agent YAML schedule.skills declarations (#2764 §5/§6).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

function loadAgent(name: string): {
  schedule?: Array<{ cron: string; task: string; skills?: string[] }>;
} {
  const raw = readFileSync(resolve(REPO_ROOT, 'agents', `${name}.yaml`), 'utf-8');
  return load(raw) as { schedule?: Array<{ cron: string; task: string; skills?: string[] }> };
}

describe('agent schedule.skills declarations (#2764)', () => {
  it('contacts weekly jobs declare trust/upkeep + tasks', () => {
    const schedule = loadAgent('contacts').schedule ?? [];
    const dedup = schedule.find((s) => s.task.includes('dedup'));
    const grants = schedule.find((s) => s.task.includes('grant recommendation'));
    expect(dedup?.skills).toEqual(['contact-upkeep', 'tasks']);
    expect(grants?.skills).toEqual(['contact-trust', 'tasks']);
  });

  it('ceo-inbox observation jobs declare learning-jobs', () => {
    const schedule = loadAgent('ceo-inbox').schedule ?? [];
    const sent = schedule.find((s) => s.task.includes('ceo-inbox-sent-observe'));
    const voice = schedule.find((s) => s.task.includes('voice-learn only'));
    expect(sent?.skills).toEqual(['learning-jobs', 'tasks']);
    expect(voice?.skills).toEqual(['learning-jobs']);
  });
});
