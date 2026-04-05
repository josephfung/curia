// handler.ts — extract-relationships skill.
//
// Self-classifying: runs a cheap haiku gate first and exits early when the
// message contains no entity-to-entity relationships. Only fires the full
// extraction prompt (sonnet) when the classifier says yes.
//
// Idempotent: calling it twice with the same triple confirms the existing
// edge rather than inserting a duplicate, and may raise its confidence.

import Anthropic from '@anthropic-ai/sdk';
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { EDGE_TYPES, NODE_TYPES } from '../../src/memory/types.js';
import type { EdgeType, NodeType } from '../../src/memory/types.js';

// Model constants — update here when model IDs rotate
const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';
const EXTRACTION_MODEL = 'claude-sonnet-4-6';

// Shape of each triple returned by the LLM extraction prompt.
interface ExtractedTriple {
  subject: string;
  subjectType: NodeType;
  predicate: EdgeType;
  object: string;
  objectType: NodeType;
  confidence: number;
}

const EDGE_TYPES_LIST = EDGE_TYPES.join(', ');
const NODE_TYPES_LIST = NODE_TYPES.join(', ');

export class ExtractRelationshipsHandler implements SkillHandler {
  // Optional Anthropic client injection for testing.
  // In production the skill registry instantiates with no args and the
  // handler creates its own client from ctx.secret('ANTHROPIC_API_KEY').
  constructor(private readonly anthropicClient?: Anthropic) {}

  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { text, source } = ctx.input as { text?: string; source?: string };

    if (!text || typeof text !== 'string') {
      return { success: false, error: 'Missing required input: text (string)' };
    }
    if (!source || typeof source !== 'string') {
      return { success: false, error: 'Missing required input: source (string)' };
    }
    if (!ctx.entityMemory) {
      return { success: false, error: 'Entity memory not available — database not configured' };
    }

    const client = this.anthropicClient ?? new Anthropic({ apiKey: ctx.secret('ANTHROPIC_API_KEY') });

    try {
    // -- Step 1: Classifier gate --
    // Cheap haiku call — exits early on the majority of messages (scheduling,
    // email drafts, lookups) that contain no entity-to-entity relationships.
    const classifierResponse = await client.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 10,
      messages: [{
        role: 'user',
        content: `Does the following text assert a relationship or connection between two or more people or organisations? Answer only 'yes' or 'no'.\n\n${text}`,
      }],
    });

    const classifierTextBlock = classifierResponse.content.find(
      (c): c is { type: 'text'; text: string } => c.type === 'text',
    );
    if (!classifierTextBlock) {
      ctx.log.warn({ textPreview: text.slice(0, 80) }, 'extract-relationships: classifier returned no text block, skipping');
      return { success: true, data: { extracted: 0, confirmed: 0, skipped: true } };
    }
    const classifierAnswer = classifierTextBlock.text.toLowerCase().trim();

    if (!classifierAnswer.startsWith('yes')) {
      ctx.log.debug({ textPreview: text.slice(0, 80) }, 'extract-relationships: classifier gate — no relationships, skipping');
      return { success: true, data: { extracted: 0, confirmed: 0, skipped: true } };
    }

    // -- Step 2: Extraction prompt --
    // Sonnet call with the full EDGE_TYPES vocabulary. Returns JSON triples.
    const extractionResponse = await client.messages.create({
      model: EXTRACTION_MODEL,
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Extract entity-to-entity relationships from the text below. Return a JSON array of relationship triples.

Available edge types: ${EDGE_TYPES_LIST}
Available node types: ${NODE_TYPES_LIST}

Rules:
- Only extract relationships between two distinct entities (person, organization, project, etc.)
- Do NOT extract facts about a single entity (e.g. "Joseph lives in Toronto" is a fact about one entity, not a relationship)
- Use 'relates_to' as predicate if no specific edge type fits
- Set confidence between 0.0 and 1.0 based on how explicitly the relationship is stated
- Return ONLY valid JSON, no explanation or markdown fences

Format:
[{"subject":"<name>","subjectType":"<nodeType>","predicate":"<edgeType>","object":"<name>","objectType":"<nodeType>","confidence":<number>}]

Text:
${text}`,
      }],
    });

    const extractionTextBlock = extractionResponse.content.find(
      (c): c is { type: 'text'; text: string } => c.type === 'text',
    );
    if (!extractionTextBlock) {
      ctx.log.warn('extract-relationships: extraction returned no text block, treating as empty');
      return { success: true, data: { extracted: 0, confirmed: 0, skipped: false } };
    }
    // Strip optional markdown code fences the model may include despite instructions
    const rawText = extractionTextBlock.text.trim();
    const jsonText = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

    let triples: ExtractedTriple[];
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (!Array.isArray(parsed)) {
        ctx.log.warn({ rawText }, 'extract-relationships: extraction returned non-array, treating as empty');
        return { success: true, data: { extracted: 0, confirmed: 0, skipped: false } };
      }
      triples = parsed as ExtractedTriple[];
    } catch (err) {
      ctx.log.warn({ err, rawText }, 'extract-relationships: failed to parse extraction JSON, treating as empty');
      return { success: true, data: { extracted: 0, confirmed: 0, skipped: false } };
    }

    // -- Steps 3 & 4: Node resolution + edge upsert --
    let extracted = 0;
    let confirmed = 0;

    for (const triple of triples) {
      try {
        // Normalise predicate — fall back to 'relates_to' for unknown types
        const predicate: EdgeType = (EDGE_TYPES as readonly string[]).includes(triple.predicate)
          ? triple.predicate as EdgeType
          : 'relates_to';

        // Normalise node types — fall back to 'person' for unknown types
        const subjectType: NodeType = (NODE_TYPES as readonly string[]).includes(triple.subjectType)
          ? triple.subjectType as NodeType
          : 'person';
        const objectType: NodeType = (NODE_TYPES as readonly string[]).includes(triple.objectType)
          ? triple.objectType as NodeType
          : 'person';

        // Resolve subject — find existing node by label or create a new one.
        // New nodes from extraction get confidence 0.6 (lower than manually confirmed entities).
        const subjectMatches = await ctx.entityMemory.findEntities(triple.subject);
        const subjectNode = subjectMatches[0] ?? await ctx.entityMemory.createEntity({
          type: subjectType,
          label: triple.subject,
          properties: {},
          source,
          confidence: 0.6,
        });

        // Resolve object — same pattern
        const objectMatches = await ctx.entityMemory.findEntities(triple.object);
        const objectNode = objectMatches[0] ?? await ctx.entityMemory.createEntity({
          type: objectType,
          label: triple.object,
          properties: {},
          source,
          confidence: 0.6,
        });

        // Clamp confidence to [0, 1] in case the LLM returns an out-of-range value
        const confidence = typeof triple.confidence === 'number'
          ? Math.min(1, Math.max(0, triple.confidence))
          : 0.7;

        const { created } = await ctx.entityMemory.upsertEdge(
          subjectNode.id,
          objectNode.id,
          predicate,
          {},
          source,
          confidence,
        );

        if (created) {
          extracted++;
        } else {
          confirmed++;
        }
      } catch (err) {
        ctx.log.warn({ err, subject: triple.subject, object: triple.object }, 'extract-relationships: failed to persist triple, skipping');
      }
    }

    ctx.log.info({ extracted, confirmed }, 'extract-relationships: complete');
    return { success: true, data: { extracted, confirmed, skipped: false } };
    } catch (err) {
      // Top-level catch for Anthropic API errors (rate limits, auth, timeouts, 5xx).
      // Skills must never throw — return a failure result so the execution layer
      // can audit and surface the error to the caller.
      ctx.log.error({ err }, 'extract-relationships: unexpected error');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
