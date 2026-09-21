// Regression: Nylas calendar tools cannot be skill-activated by the coordinator (#1853).

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const toolsDir = resolve(import.meta.dirname, '../../../skills/calendar/tools');

describe('calendar tool allowed_callers (#1853)', () => {
  const manifests = readdirSync(toolsDir)
    .map((name) => {
      const raw = readFileSync(resolve(toolsDir, name, 'tool.json'), 'utf-8');
      return JSON.parse(raw) as { name: string; allowed_callers?: string[] };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  it('every calendar tool declares allowed_callers', () => {
    expect(manifests.length).toBeGreaterThan(0);
    for (const m of manifests) {
      expect(m.allowed_callers, m.name).toEqual(expect.any(Array));
      expect(m.allowed_callers!.length, m.name).toBeGreaterThan(0);
      expect(m.allowed_callers, m.name).toContain('calendar');
      expect(m.allowed_callers, m.name).not.toContain('coordinator');
    }
  });

  it('meeting-debrief and contacts keep their read/write pins', () => {
    const byName = Object.fromEntries(manifests.map((m) => [m.name, m.allowed_callers!]));
    expect(byName['calendar-list-events']).toEqual(
      expect.arrayContaining(['calendar', 'meeting-debrief', 'contacts']),
    );
    expect(byName['calendar-create-event']).toEqual(
      expect.arrayContaining(['calendar', 'meeting-debrief']),
    );
    expect(byName['calendar-check-conflicts']).toEqual(
      expect.arrayContaining(['calendar', 'meeting-debrief']),
    );
    expect(byName['calendar-delete-event']).toEqual(['calendar']);
  });
});
