// Voice's own tool list (#1968). Spoken turns used to carry the coordinator's 73
// tool definitions; these tests keep the list a small, real, curated subset.

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { VOICE_TOOL_NAMES, withVoiceSpokenNotes } from '../../../../src/channels/voice/voice-tools.js';
import { findInternalJargon } from '../../../../src/channels/voice/spoken-jargon.js';
import { buildVoiceSystemPrompt, VOICE_GREETING_INSTRUCTION } from '../../../../src/channels/voice/voice-runtime.js';
import { measureAgentContext } from '../../../../src/agents/prompt-budget.js';
import { discoverToolManifests } from '../../../../src/skills/loader.js';
import { ToolRegistry } from '../../../../src/skills/registry.js';
import { createLogger } from '../../../../src/logger.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const SKILLS_DIR = resolve(REPO_ROOT, 'skills');
const SOURCES = {
  agentsDir: resolve(REPO_ROOT, 'agents'),
  skillsDir: SKILLS_DIR,
  configDir: resolve(REPO_ROOT, 'config'),
};

/**
 * Measured 12,686 bytes over 9 tools when the list was set (#1968), against the
 * coordinator's 81,624 over 73. Small headroom for description edits; a new tool needs
 * the evidence voice-tools.ts asks for, and a raise here.
 */
// #2322 added meeting-agenda-load (voice-only, same standing as async-offramp).
// #2347 added meeting-notes-start (452 bytes; 13,795 total).
const VOICE_TOOL_DEFINITION_BYTES_BUDGET = 15_000;

function catalog(): ToolRegistry {
  const registry = new ToolRegistry('America/Toronto');
  const noop = { execute: async () => ({ success: true as const, data: {} }) };
  for (const disc of discoverToolManifests(SKILLS_DIR, createLogger('silent'))) {
    if (disc.manifest) registry.register(disc.manifest, noop);
  }
  return registry;
}

describe('VOICE_TOOL_NAMES', () => {
  const registry = catalog();

  it('names only tools that exist in the catalog', () => {
    const missing = VOICE_TOOL_NAMES.filter(name => !registry.get(name));
    expect(missing).toEqual([]);
  });

  it('has no duplicates', () => {
    expect(new Set(VOICE_TOOL_NAMES).size).toBe(VOICE_TOOL_NAMES.length);
  });

  it('carries what a live call needs within the round cap', () => {
    expect(VOICE_TOOL_NAMES).toEqual(expect.arrayContaining(['delegate', 'date-resolve', 'async-offramp']));
  });

  it('leaves out the discovery tools, which a fixed per-turn tool list cannot honor', () => {
    expect(VOICE_TOOL_NAMES).not.toContain('tool-registry');
    expect(VOICE_TOOL_NAMES).not.toContain('skill-activate');
  });

  it('includes meeting-agenda-load (#2322) and meeting-notes-start (#2347)', () => {
    expect(VOICE_TOOL_NAMES).toContain('meeting-agenda-load');
    expect(VOICE_TOOL_NAMES).toContain('meeting-notes-start');
  });

  // A spoken turn cannot finish a send inside the round cap; the recap leaves the call (#2347).
  it('leaves out email-send', () => {
    expect(VOICE_TOOL_NAMES).not.toContain('email-send');
  });

  // Both tools are on every turn. If both claimed the recap, one ask could send two emails (#2347).
  it('gives the recap of this call to meeting-notes-start alone', () => {
    const offramp = registry.get('async-offramp')!.manifest.description;
    const notes = registry.get('meeting-notes-start')!.manifest.description;
    expect(offramp).toContain('A recap of this call is meeting-notes-start, not this tool.');
    expect(offramp).not.toMatch(/summary for the principal/i);
    expect(notes).toContain('do not also hand it off with async-offramp or delegate');
  });

  it('is a subset of what the coordinator can do, plus the voice-only tools', () => {
    const coordinatorTools = new Set(measureAgentContext('coordinator', SOURCES).localToolNames);
    // These hand work TO the coordinator or lock call state, so the coordinator must not carry them.
    const voiceOnly = new Set(['async-offramp', 'meeting-agenda-load', 'meeting-notes-start']);
    for (const name of voiceOnly) expect(coordinatorTools.has(name)).toBe(false);
    const beyondCoordinator = VOICE_TOOL_NAMES.filter(name => !voiceOnly.has(name) && !coordinatorTools.has(name));
    expect(beyondCoordinator).toEqual([]);
  });

  it(`keeps the tool definitions under ${VOICE_TOOL_DEFINITION_BYTES_BUDGET} bytes`, () => {
    const bytes = registry
      .toToolDefinitions([...VOICE_TOOL_NAMES])
      .reduce((sum, def) => sum + Buffer.byteLength(JSON.stringify(def), 'utf8'), 0);
    expect(bytes).toBeLessThanOrEqual(VOICE_TOOL_DEFINITION_BYTES_BUDGET);
  });
});

// The voice model narrated its internals on a live call: "I'll ask the calendar
// specialist", "the coordinator with an async offramp" (#2379). It copies quoted
// examples closely, so none of the examples voice is given may carry those words.
describe('voice spoken phrasing (#2379)', () => {
  const registry = catalog();
  const voiceDefs = withVoiceSpokenNotes(registry.toToolDefinitions([...VOICE_TOOL_NAMES]));

  /** Every `description` string in a tool definition, top level and per input. */
  function descriptions(value: unknown): string[] {
    if (typeof value !== 'object' || value === null) return [];
    return Object.entries(value).flatMap(([key, child]) =>
      key === 'description' && typeof child === 'string' ? [child] : descriptions(child),
    );
  }

  function quotedExamples(text: string): string[] {
    return [...text.matchAll(/"([^"]+)"/g)].map(match => match[1]!);
  }

  it('appends the spoken note to delegate on voice only', () => {
    const shared = registry.get('delegate')!.manifest.description;
    const voice = voiceDefs.find(def => def.name === 'delegate')!.description;
    expect(voice.startsWith(shared)).toBe(true);
    expect(voice.length).toBeGreaterThan(shared.length);
    expect(voice).toMatch(/one person doing the work/);
    // Other tools pass through unchanged.
    const dateResolve = voiceDefs.find(def => def.name === 'date-resolve')!;
    expect(dateResolve.description).toBe(registry.get('date-resolve')!.manifest.description);
  });

  it('gives the delegate and async-offramp tools a spoken example to copy', () => {
    for (const name of ['delegate', 'async-offramp']) {
      const def = voiceDefs.find(d => d.name === name)!;
      expect(quotedExamples(def.description).length, name).toBeGreaterThan(0);
    }
  });

  it('keeps every quoted example in voice prompt and tool text free of internal terms', () => {
    const prompt = buildVoiceSystemPrompt({
      identityBlock: null,
      specialistRoster: '- @calendar: Calendar and scheduling.',
      audience: { liveTurn: true },
    });
    const texts = [prompt, VOICE_GREETING_INSTRUCTION, ...voiceDefs.flatMap(def => descriptions(def))];
    const offending = texts
      .flatMap(quotedExamples)
      .filter(example => findInternalJargon(example).length > 0);
    expect(offending).toEqual([]);
  });
});
