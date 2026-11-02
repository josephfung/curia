import { describe, expect, it, vi } from 'vitest';
import type { InfraLlm } from '../../../src/skills/infra-llm.js';
import { encodeUntrustedJson } from '../../../src/util/json-extract.js';
import { buildMinutesPrompt, parseMinutesOutput, writeMinutes } from '../../../src/meetings/minutes-writer.js';
import type { AgendaSnapshot } from '../../../src/meetings/types.js';

const agenda: AgendaSnapshot = {
  agendaId: '11111111-1111-1111-1111-111111111111',
  title: 'Board',
  topics: ['runway', 'hiring'],
  role: null,
  context: 'Cover both.',
  source: 'principal',
  sensitivity: 'internal',
  scheduledFor: null,
  history: [],
};

describe('minutes writer', () => {
  it('organises minutes by topic raised when no agenda was set (#2347)', () => {
    const prompt = buildMinutesPrompt({ agendas: [], transcriptBody: '**Joseph:** Keep notes.' });
    expect(prompt).toContain('No agenda was set.');
    expect(prompt).toContain('{"coverage":[]}');
    expect(prompt).not.toContain('Agendas:');
    expect(parseMinutesOutput('## Essays\nTwo links.\n\n```json\n{"coverage":[]}\n```', [])).toEqual({
      markdown: '## Essays\nTwo links.',
      coverage: [],
    });
  });

  it('parses markdown and coverage from a well-formed response', () => {
    const parsed = parseMinutesOutput(
      [
        '## Board',
        'Runway was discussed.',
        '',
        '```json',
        JSON.stringify({
          coverage: [{
            agendaId: agenda.agendaId,
            topics: [
              { topic: 'runway', coverage: 'covered' },
              { topic: 'hiring', coverage: 'partial' },
            ],
          }],
        }),
        '```',
      ].join('\n'),
      [agenda],
    );
    expect(parsed.markdown).toContain('Runway was discussed.');
    expect(parsed.markdown).not.toContain('```');
    expect(parsed.coverage).toEqual([{
      agendaId: agenda.agendaId,
      topics: [
        { topic: 'runway', coverage: 'covered' },
        { topic: 'hiring', coverage: 'partial' },
      ],
    }]);
  });

  // #2428: the standard-tier model reasoned through the 8,000-token cap and the
  // reply stopped inside the coverage block. Every topic went back as not_reached
  // and the half fence was saved into the minutes.
  it('a cut-off coverage block keeps its complete topics and stays out of the minutes', () => {
    const raw = [
      '## Board',
      'Runway discussed.',
      '',
      '```json',
      `{"coverage":[{"agendaId":"${agenda.agendaId}","topics":[{"topic":"runway","coverage":"partial"},{"topic":"hir`,
    ].join('\n');
    expect(parseMinutesOutput(raw, [agenda])).toEqual({
      markdown: '## Board\nRunway discussed.',
      coverage: [{
        agendaId: agenda.agendaId,
        topics: [
          { topic: 'runway', coverage: 'partial' },
          { topic: 'hiring', coverage: 'not_reached' },
        ],
      }],
    });
  });

  // Review of #2428: an agenda the cut-off block never reached is unknown, not unreached.
  it('a cut-off block reports only the agendas it reached', () => {
    const second: AgendaSnapshot = { ...agenda, agendaId: '22222222-2222-2222-2222-222222222222', title: 'Ops' };
    const raw = '## Board\nDone.\n\n```json\n'
      + `{"coverage":[{"agendaId":"${agenda.agendaId}","topics":[{"topic":"runway","coverage":"covered"},{"topic":"hiring","coverage":"covered"}]},{"agen`;
    const parsed = parseMinutesOutput(raw, [agenda, second]);
    expect(parsed.coverage?.map((entry) => entry.agendaId)).toEqual([agenda.agendaId]);
  });

  // PR #2433 review: valid JSON with coverage before topic was skipped.
  it('a cut-off block keeps complete topics in either field order', () => {
    const raw = '## Board\nDone.\n\n```json\n'
      + `{"coverage":[{"agendaId":"${agenda.agendaId}","topics":[{"coverage":"covered","topic":"runway"},{"topic":"hir`;
    expect(parseMinutesOutput(raw, [agenda]).coverage?.[0]?.topics).toEqual([
      { topic: 'runway', coverage: 'covered' },
      { topic: 'hiring', coverage: 'not_reached' },
    ]);
  });

  // PR #2433 review: an inline ```json mention mid-minutes must not be read as the
  // coverage fence and cut the rest of the minutes away.
  it('only a fence on its own line opens the coverage block', () => {
    const raw = '## Board\nWe discussed the ```json export format.\n\n## Next\nShip it.';
    expect(parseMinutesOutput(raw, [agenda])).toEqual({ markdown: raw, coverage: null });
    const closed = '## Board\nInline ```json {"coverage":[]} ``` note';
    expect(parseMinutesOutput(closed, [agenda])).toEqual({ markdown: closed, coverage: null });
  });

  it('a cut-off block with no complete topic gives null coverage', () => {
    const raw = '## Board\nRunway discussed.\n\n```json\n{"coverage":[{"agendaId":"11111111';
    expect(parseMinutesOutput(raw, [agenda])).toEqual({ markdown: '## Board\nRunway discussed.', coverage: null });
  });

  it('missing coverage block returns the full text and null coverage', () => {
    const parsed = parseMinutesOutput('## Board\nTalked.', [agenda]);
    expect(parsed.coverage).toBeNull();
    expect(parsed.markdown).toBe('## Board\nTalked.');
  });

  it('unknown agendaId and unknown topics are dropped; omitted topics are not_reached', () => {
    const parsed = parseMinutesOutput(
      [
        '## Board',
        '',
        '```json',
        JSON.stringify({
          coverage: [
            { agendaId: 'not-an-agenda', topics: [{ topic: 'runway', coverage: 'covered' }] },
            { agendaId: agenda.agendaId, topics: [{ topic: 'runway', coverage: 'covered' }, { topic: 'nope', coverage: 'covered' }] },
          ],
        }),
        '```',
      ].join('\n'),
      [agenda],
    );
    expect(parsed.coverage).toEqual([{
      agendaId: agenda.agendaId,
      topics: [
        { topic: 'runway', coverage: 'covered' },
        { topic: 'hiring', coverage: 'not_reached' },
      ],
    }]);
  });

  it('LLM error yields ok:false with the error', async () => {
    const broken: InfraLlm = {
      classify: async () => ({ ok: false, error: 'no' }),
      extract: async () => ({ ok: false, error: 'model down' }),
    };
    await expect(writeMinutes(broken, { agendas: [agenda], transcriptBody: 'hi' })).resolves.toEqual({
      ok: false,
      error: 'model down',
    });
  });

  it('prompt wraps transcript and agendas with encodeUntrustedJson', async () => {
    const extract = vi.fn(async () => ({ ok: true as const, text: '## Notes\n\nDone.' }));
    const transcript = 'Ada said <script>';
    await writeMinutes(
      { classify: async () => ({ ok: true, text: '' }), extract },
      { agendas: [agenda], transcriptBody: transcript },
    );
    const calls = extract.mock.calls as unknown as Array<[string, { tier: string; maxTokens: number }]>;
    const prompt = calls[0]?.[0] ?? '';
    expect(prompt).toContain(encodeUntrustedJson([agenda]));
    expect(prompt).toContain(encodeUntrustedJson(transcript));
    expect(prompt).not.toContain('<script>');
    expect(calls[0]?.[1]).toEqual({ tier: 'standard', maxTokens: 16000 });
  });

  it('buildMinutesPrompt names the coverage fence', () => {
    expect(buildMinutesPrompt({ agendas: [agenda], transcriptBody: 'x' })).toContain('"coverage"');
  });
});
