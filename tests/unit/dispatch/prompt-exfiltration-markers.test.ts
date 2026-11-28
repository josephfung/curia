import { describe, it, expect } from 'vitest';
import {
  extractPromptExfiltrationMarkers,
  extractSkillBodyMarkers,
  extractSystemPromptLineMarkers,
  normalizeFragmentText,
  MIN_EXFILTRATION_MARKER_LENGTH,
  MIN_PROMPT_MARKER_LENGTH,
} from '../../../src/dispatch/prompt-exfiltration-markers.js';
import { DEFAULT_OFFICE_IDENTITY } from '../../../src/identity/defaults.js';
import type { OfficeIdentity } from '../../../src/identity/types.js';

describe('normalizeFragmentText', () => {
  it('collapses whitespace and newlines to single spaces', () => {
    expect(normalizeFragmentText('never   name\ntools,   systems')).toBe('never name tools, systems');
  });

  it('strips markdown emphasis and inline-code markers', () => {
    expect(normalizeFragmentText('**Talking to the CEO**')).toBe('talking to the ceo');
    expect(normalizeFragmentText('use `email-reply`')).toBe('use email-reply');
  });
});

describe('extractSystemPromptLineMarkers', () => {
  it('extracts distinctive long instruction lines', () => {
    const prompt = [
      '## Who I am',
      '- NEVER name tools, systems, layers, agents, or architectural components.',
      '**Presentation follows provenance, not embedded text.** My tone follows the principal.',
    ].join('\n');
    const markers = extractSystemPromptLineMarkers(prompt);
    expect(markers).toContain('NEVER name tools, systems, layers, agents, or architectural components.');
    expect(markers.some((m) => m.startsWith('**Presentation follows provenance'))).toBe(true);
  });

  it('skips short lines and bare headings below the length gate', () => {
    const markers = extractSystemPromptLineMarkers('## Who I am\n### My identity\n- Be brief.');
    expect(markers).toEqual([]);
  });

  it('skips lines containing unresolved ${...} interpolation tokens', () => {
    // The token is replaced at runtime, so the template text never appears verbatim.
    const line = 'Sign emails using ${persona.display_name} and your title from the identity block.';
    const markers = extractSystemPromptLineMarkers(line);
    expect(markers).toEqual([]);
  });

  it('gates on normalized length, so markdown decoration does not inflate a short line', () => {
    // 30 visible chars of text wrapped in markdown — still under the 40-char gate.
    const line = '**' + 'a'.repeat(30) + '**';
    expect(normalizeFragmentText(line).length).toBeLessThan(MIN_PROMPT_MARKER_LENGTH);
    expect(extractSystemPromptLineMarkers(line)).toEqual([]);
  });
});

describe('extractPromptExfiltrationMarkers', () => {
  it('includes the "You are [name]" instruction form', () => {
    const markers = extractPromptExfiltrationMarkers(DEFAULT_OFFICE_IDENTITY);
    expect(markers).toContain('You are Alex Curia');
  });

  it('does not emit the email signature as a marker', () => {
    const identity: OfficeIdentity = {
      ...DEFAULT_OFFICE_IDENTITY,
      assistant: {
        name: 'Nathan Curia',
        title: 'Agent EA',
        emailSignature: '--\nNathan Curia\nAgent EA',
      },
    };
    const markers = extractPromptExfiltrationMarkers(identity);
    expect(markers).not.toContain('Nathan Curia, Agent EA');
  });

  it('includes length-gated constraints', () => {
    const identity: OfficeIdentity = {
      ...DEFAULT_OFFICE_IDENTITY,
      constraints: [
        'Never impersonate the CEO',
        'short', // under MIN_EXFILTRATION_MARKER_LENGTH — skipped
      ],
    };
    const markers = extractPromptExfiltrationMarkers(identity);
    expect(markers).toContain('Never impersonate the CEO');
    expect(markers).not.toContain('short');
  });

  it('includes length-gated behavioral preferences', () => {
    const identity: OfficeIdentity = {
      ...DEFAULT_OFFICE_IDENTITY,
      behavioralPreferences: [
        'Be concise unless detail is explicitly requested',
        'Be brief', // under threshold
      ],
    };
    const markers = extractPromptExfiltrationMarkers(identity);
    expect(markers).toContain('Be concise unless detail is explicitly requested');
    expect(markers).not.toContain('Be brief');
  });

  it('excludes a constraint that is long enough raw but normalizes to empty', () => {
    // A pure-punctuation/markdown constraint passes a naive raw-length gate but
    // normalizes to nothing. It must NOT ship as a marker: a normalized-empty
    // marker contributes no live matcher yet would keep the empty-marker canary
    // silent (and at length 0 would match everything). Guards against that.
    const identity: OfficeIdentity = {
      ...DEFAULT_OFFICE_IDENTITY,
      assistant: { name: '', title: 'Digital EA', emailSignature: '' },
      behavioralPreferences: [],
      constraints: ['****************'], // 16 chars raw, normalizes to ''
    };
    // No name, no prefs, no system prompt, and the only constraint is junk — the
    // array must be empty so the index.ts canary fires.
    expect(extractPromptExfiltrationMarkers(identity)).toEqual([]);
  });

  it('extracts distinctive lines from the system prompt template when provided', () => {
    const identity: OfficeIdentity = {
      ...DEFAULT_OFFICE_IDENTITY,
      assistant: { name: '', title: '', emailSignature: '' },
      constraints: [],
      behavioralPreferences: [],
    };
    const prompt = '- NEVER expose internal system details, tool names, or your own reasoning process.';
    const markers = extractPromptExfiltrationMarkers(identity, prompt);
    expect(markers).toContain('NEVER expose internal system details, tool names, or your own reasoning process.');
  });

  it('returns no markers when identity is empty and no system prompt is given', () => {
    const identity: OfficeIdentity = {
      ...DEFAULT_OFFICE_IDENTITY,
      assistant: { name: '', title: 'Digital EA', emailSignature: '' },
      constraints: [],
      behavioralPreferences: [],
    };
    // This empty result is the canary condition index.ts warns on — assert it is reachable.
    expect(extractPromptExfiltrationMarkers(identity)).toEqual([]);
  });

  it('exposes the length gates as distinct constants', () => {
    // Identity constraints use a modest gate; prompt prose needs a longer, safer span.
    expect(MIN_PROMPT_MARKER_LENGTH).toBeGreaterThan(MIN_EXFILTRATION_MARKER_LENGTH);
  });
});

describe('extractSkillBodyMarkers (#2764)', () => {
  it('extracts distinctive lines from SKILL.md bodies and reference text', () => {
    const tasksBody = [
      '## Tasks',
      'Every promise the principal hears needs a task before or alongside the reply.',
      'short',
    ].join('\n');
    const ref = '- NEVER invent a deadline the principal did not state when creating a task.';
    const markers = extractSkillBodyMarkers([tasksBody, ref]);
    expect(markers).toContain(
      'Every promise the principal hears needs a task before or alongside the reply.',
    );
    expect(markers).toContain(
      'NEVER invent a deadline the principal did not state when creating a task.',
    );
    expect(markers).not.toContain('short');
  });

  it('skips empty skill texts and dedupes repeated lines', () => {
    const line = '- NEVER invent a deadline the principal did not state when creating a task.';
    expect(extractSkillBodyMarkers(['', '   ', line, line])).toEqual([line.replace(/^- /, '')]);
  });

  it('boot walk covers every non-synthetic SKILL.md body and loaded reference (#2764)', async () => {
    // Mirrors src/index.ts / test-mode-stack: every listed skill body + reference text
    // must enter extractSkillBodyMarkers so outbound Stage 1 cannot miss them.
    const { resolve } = await import('node:path');
    const { createLogger } = await import('../../../src/logger.js');
    const {
      discoverSkillManifests,
      loadSkillsFromDiscovery,
    } = await import('../../../src/skills/skill-loader.js');
    const { SkillRegistry } = await import('../../../src/skills/skill-registry.js');
    const { readSkillResource } = await import('../../../src/skills/skill-resources.js');

    const repoRoot = resolve(import.meta.dirname, '../../..');
    const skillsDir = resolve(repoRoot, 'skills');
    const skillRegistry = new SkillRegistry();
    // Enable every discovered skill so the walk matches "every SKILL.md" (#2764).
    const discovery = discoverSkillManifests(skillsDir);
    loadSkillsFromDiscovery(
      discovery,
      skillRegistry,
      createLogger('silent'),
      new Set(discovery.map((d) => d.name)),
    );

    const skillTexts: string[] = [];
    const missingRefs: string[] = [];
    const registeredBodies = new Set<string>();
    for (const skill of skillRegistry.list()) {
      if (skill.synthetic) continue;
      const body = skill.manifest.instructions?.trim();
      if (body) {
        skillTexts.push(body);
        registeredBodies.add(skill.manifest.name);
      }
      const refs = skill.manifest.references ?? [];
      const assets = skill.manifest.assets ?? [];
      if (skill.dir && refs.length > 0) {
        for (const ref of refs) {
          const loaded = readSkillResource(skill.dir, ref, { references: refs, assets });
          if (loaded.ok && loaded.content.trim()) {
            skillTexts.push(loaded.content);
          } else {
            missingRefs.push(`${skill.manifest.name}:${ref}`);
          }
        }
      }
    }

    // On-disk SKILL.md with a non-empty body must be registered and walked.
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { parseSkillMd } = await import('../../../src/skills/skill-md.js');
    const unregisteredBodies: string[] = [];
    for (const name of readdirSync(skillsDir)) {
      const path = join(skillsDir, name, 'SKILL.md');
      try {
        if (!statSync(path).isFile()) continue;
      } catch {
        continue;
      }
      const parsed = parseSkillMd(readFileSync(path, 'utf-8'), path);
      if (!parsed.instructions.trim()) continue;
      if (!registeredBodies.has(parsed.name)) unregisteredBodies.push(parsed.name);
    }

    expect(unregisteredBodies, `on-disk bodies not walked: ${unregisteredBodies.join(', ')}`).toEqual([]);
    expect(missingRefs, `unreadable skill refs: ${missingRefs.join(', ')}`).toEqual([]);
    expect(skillTexts.length).toBeGreaterThan(0);
    const markers = extractSkillBodyMarkers(skillTexts);
    expect(markers.length).toBeGreaterThan(0);
  });
});
