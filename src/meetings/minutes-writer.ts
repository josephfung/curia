// minutes-writer.ts — standard-tier minutes plus structured topic coverage (#2322).
//
// The model writes markdown, then one trailing json fence. A missing or
// malformed fence leaves coverage null so the pipeline can return the agendas
// instead of inventing what was discussed.

import type { InfraLlm } from '../skills/infra-llm.js';
import { encodeUntrustedJson, extractFirstJsonObject, stripCodeFence } from '../util/json-extract.js';
import type { AgendaCoverage, AgendaSnapshot, TopicCoverage } from './types.js';
import { TOPIC_COVERAGE } from './types.js';

export function buildMinutesPrompt(input: { agendas: AgendaSnapshot[]; transcriptBody: string }): string {
  if (input.agendas.length === 0) {
    // The caller asked for notes on a call with no agenda (#2347).
    return [
      'Write meeting minutes from the transcript below. No agenda was set.',
      'Use one section per topic the caller raised. For each say what was discussed, what was decided, and what was asked for.',
      'Keep open questions as they were said. Attribute who said or committed to what.',
      'End with one fenced json block and nothing after it:',
      '```json',
      '{"coverage":[]}',
      '```',
      'Transcript:',
      encodeUntrustedJson(input.transcriptBody),
    ].join('\n');
  }
  return [
    'Write meeting minutes from the transcript and the agendas below.',
    'Use one section per agenda. For each topic say what was discussed, what was decided, and the coverage: covered, partial, or not_reached.',
    'Add a section for anything discussed outside the agendas.',
    'Keep open questions as they were said. Attribute who said or committed to what.',
    'End with one fenced json block and nothing after it:',
    '```json',
    '{"coverage":[{"agendaId":"…","topics":[{"topic":"…","coverage":"covered"}]}]}',
    '```',
    'Agendas:',
    encodeUntrustedJson(input.agendas),
    'Transcript:',
    encodeUntrustedJson(input.transcriptBody),
  ].join('\n');
}

function isTopicCoverage(value: unknown): value is TopicCoverage {
  return typeof value === 'string' && TOPIC_COVERAGE.includes(value as TopicCoverage);
}

function coverageFromFence(fenceBody: string, agendas: AgendaSnapshot[]): AgendaCoverage[] | null {
  const extracted = extractFirstJsonObject(stripCodeFence(fenceBody));
  if (!extracted) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { coverage?: unknown }).coverage)) {
    return null;
  }
  return normaliseCoverage((parsed as { coverage: unknown[] }).coverage, agendas);
}

// A reply cut off by the token cap stops inside the block (#2428). Keep each
// complete {"topic","coverage"} pair under the agendaId before it; a block with
// none of them is as good as missing.
const SALVAGE = /"agendaId"\s*:\s*"([^"\\]*)"|\{\s*"topic"\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*"coverage"\s*:\s*"([a-z_]+)"\s*\}/g;

function salvageCoverage(fenceBody: string, agendas: AgendaSnapshot[]): AgendaCoverage[] | null {
  const items: Array<{ agendaId: string; topics: Array<{ topic: string; coverage: string }> }> = [];
  let found = 0;
  for (const match of fenceBody.matchAll(SALVAGE)) {
    if (match[1] !== undefined) {
      items.push({ agendaId: match[1], topics: [] });
      continue;
    }
    const current = items[items.length - 1];
    if (!current || match[2] === undefined || match[3] === undefined) continue;
    let topic: unknown;
    try {
      topic = JSON.parse(match[2]);
    } catch {
      continue;
    }
    if (typeof topic !== 'string') continue;
    current.topics.push({ topic, coverage: match[3] });
    found += 1;
  }
  return found === 0 ? null : normaliseCoverage(items, agendas);
}

function normaliseCoverage(items: unknown[], agendas: AgendaSnapshot[]): AgendaCoverage[] {
  const known = new Map(agendas.map((agenda) => [agenda.agendaId, new Set(agenda.topics)]));
  const reported = new Map<string, Map<string, TopicCoverage>>();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const agendaId = (item as { agendaId?: unknown }).agendaId;
    if (typeof agendaId !== 'string' || !known.has(agendaId)) continue;
    const topics = (item as { topics?: unknown }).topics;
    if (!Array.isArray(topics)) continue;
    const map = reported.get(agendaId) ?? new Map<string, TopicCoverage>();
    const allowed = known.get(agendaId)!;
    for (const topic of topics) {
      if (!topic || typeof topic !== 'object') continue;
      const name = (topic as { topic?: unknown }).topic;
      const coverage = (topic as { coverage?: unknown }).coverage;
      if (typeof name !== 'string' || !allowed.has(name) || !isTopicCoverage(coverage)) continue;
      map.set(name, coverage);
    }
    reported.set(agendaId, map);
  }
  return agendas.map((agenda) => ({
    agendaId: agenda.agendaId,
    topics: agenda.topics.map((topic) => ({
      topic,
      coverage: reported.get(agenda.agendaId)?.get(topic) ?? 'not_reached',
    })),
  }));
}

export function parseMinutesOutput(
  raw: string,
  agendas: AgendaSnapshot[],
): { markdown: string; coverage: AgendaCoverage[] | null } {
  const trimmed = raw.trimEnd();
  const match = /```json\s*([\s\S]*?)```\s*$/.exec(trimmed);
  if (match) {
    const markdown = trimmed.slice(0, match.index).trim();
    return { markdown, coverage: coverageFromFence(match[1] ?? '', agendas) };
  }
  // An unclosed trailing fence is a reply cut off mid-block: keep it out of the minutes.
  const open = trimmed.lastIndexOf('```json');
  if (open === -1 || trimmed.indexOf('```', open + 7) !== -1) return { markdown: raw.trim(), coverage: null };
  const fenceBody = trimmed.slice(open + 7);
  return {
    markdown: trimmed.slice(0, open).trim(),
    coverage: coverageFromFence(fenceBody, agendas) ?? salvageCoverage(fenceBody, agendas),
  };
}

// The standard-tier model reasons even when asked not to; at 8,000 it spent the
// budget thinking and the reply stopped inside the coverage block (#2428).
const MINUTES_MAX_TOKENS = 16000;

export async function writeMinutes(
  llm: InfraLlm,
  input: { agendas: AgendaSnapshot[]; transcriptBody: string },
): Promise<{ ok: true; markdown: string; coverage: AgendaCoverage[] | null } | { ok: false; error: string }> {
  const result = await llm.extract(buildMinutesPrompt(input), { tier: 'standard', maxTokens: MINUTES_MAX_TOKENS });
  if (!result.ok) return { ok: false, error: result.error };
  const parsed = parseMinutesOutput(result.text, input.agendas);
  if (parsed.markdown.trim() === '') return { ok: false, error: 'empty minutes' };
  return { ok: true, markdown: parsed.markdown, coverage: parsed.coverage };
}
