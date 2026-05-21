// handler.ts — extract-relationships skill.
//
// Self-classifying: runs a cheap haiku gate first and exits early when the
// message contains no entity-to-entity relationships. Only fires the full
// extraction prompt (sonnet) when the classifier says yes.
//
// Idempotent: calling it twice with the same triple confirms the existing
// edge rather than inserting a duplicate, and may raise its confidence.
//
// LLM calls go through the constrained InfraLlm service (classify + extract only),
// which routes through ModelRouter and publishes llm.call bus events for telemetry.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { EDGE_TYPES, NODE_TYPES } from '../../src/memory/types.js';
import type { EdgeType, NodeType } from '../../src/memory/types.js';

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
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { text, source } = ctx.input as { text?: string; source?: string };

    if (!text || typeof text !== 'string') {
      // Log only safe metadata — never log ctx.input directly (contains full transcript)
      ctx.log.error({ hasText: typeof text === 'string', hasSource: typeof source === 'string' }, 'extract-relationships: missing required input "text"');
      return { success: false, error: 'Missing required input: text (string)' };
    }
    if (!source || typeof source !== 'string') {
      ctx.log.error({ hasText: typeof text === 'string', hasSource: typeof source === 'string' }, 'extract-relationships: missing required input "source"');
      return { success: false, error: 'Missing required input: source (string)' };
    }
    if (!ctx.entityMemory) {
      ctx.log.error('extract-relationships: entity memory not available — is the database configured?');
      return { success: false, error: 'Entity memory not available — database not configured' };
    }

    // Guard: infraLlm is a required capability declared in skill.json.
    if (!ctx.infraLlm) {
      ctx.log.error('extract-relationships: infraLlm capability missing — execution layer misconfigured');
      return { success: false, error: 'extract-relationships requires infraLlm capability' };
    }

    try {
    // -- Step 1: Classifier gate --
    // Cheap fast-tier call — exits early on the majority of messages (scheduling,
    // email drafts, lookups) that contain no entity-to-entity relationships.
    const classifyResult = await ctx.infraLlm.classify(
      `Does the following text assert a relationship or connection between two or more entities (such as people, organisations, projects, events, or other named entities)? Answer only 'yes' or 'no'.\n\n${text}`,
    );

    if (!classifyResult.ok) {
      ctx.log.error({ error: classifyResult.error }, 'extract-relationships: classifier LLM call failed');
      return { success: false, error: `Classifier LLM call failed: ${classifyResult.error}` };
    }

    const classifierAnswer = classifyResult.text.toLowerCase().trim();

    if (!classifierAnswer.startsWith('yes')) {
      ctx.log.debug({ textPreview: text.slice(0, 80) }, 'extract-relationships: classifier gate — no relationships, skipping');
      return { success: true, data: { extracted: 0, confirmed: 0, skipped: true } };
    }

    // -- Step 2: Extraction prompt --
    // Standard-tier call with the full EDGE_TYPES vocabulary. Returns JSON triples.
    const extractionResult = await ctx.infraLlm.extract(
      `Extract entity-to-entity relationships from the text below. Return a JSON array of relationship triples.

Available edge types: ${EDGE_TYPES_LIST}
Available node types: ${NODE_TYPES_LIST}

Rules:
- Only extract relationships between two distinct entities (person, organization, project, etc.)
- Do NOT extract facts about a single entity (e.g. "Bob lives in Toronto" is a fact about one entity, not a relationship)
- Use 'relates_to' as predicate if no specific edge type fits
- Set confidence between 0.0 and 1.0 based on how explicitly the relationship is stated
- Return ONLY valid JSON, no explanation or markdown fences

Format:
[{"subject":"<name>","subjectType":"<nodeType>","predicate":"<edgeType>","object":"<name>","objectType":"<nodeType>","confidence":<number>}]

Text:
${text}`,
      { maxTokens: 1000 },
    );

    if (!extractionResult.ok) {
      ctx.log.error({ error: extractionResult.error }, 'extract-relationships: extraction LLM call failed');
      return { success: false, error: `LLM call failed: ${extractionResult.error}` };
    }

    // Strip optional markdown code fences the model may include despite instructions.
    // Case-insensitive to handle ```JSON as well as ```json.
    const rawText = extractionResult.text.trim();
    const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

    let triples: ExtractedTriple[];
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (!Array.isArray(parsed)) {
        // Log length only — rawText may contain extracted entity names (PII).
        ctx.log.warn({ responseLength: rawText.length }, 'extract-relationships: extraction returned non-array, treating as empty');
        return { success: true, data: { extracted: 0, confirmed: 0, skipped: false } };
      }
      triples = parsed as ExtractedTriple[];
    } catch (err) {
      ctx.log.warn({ err, responseLength: rawText.length }, 'extract-relationships: failed to parse extraction JSON, treating as empty');
      return { success: true, data: { extracted: 0, confirmed: 0, skipped: false } };
    }

    // -- Steps 3 & 4: Node resolution + edge upsert --
    let extracted = 0;
    let confirmed = 0;
    let failed = 0;

    // Entity types that are valid relationship endpoints. 'fact' is excluded —
    // facts describe a single entity and should not appear as nodes in a
    // subject↔object relationship (that's the extract-facts skill's domain).
    const ENTITY_NODE_TYPES: ReadonlySet<string> = new Set(
      NODE_TYPES.filter(t => t !== 'fact'),
    );

    for (const triple of triples) {
      try {
        // Guard: skip malformed triples where required string fields are absent.
        // The LLM may return null/undefined for subject or object on edge cases.
        if (
          !triple ||
          typeof triple.subject !== 'string' ||
          typeof triple.object !== 'string' ||
          typeof triple.predicate !== 'string'
        ) {
          ctx.log.warn({ triple }, 'extract-relationships: skipping malformed triple');
          failed++;
          continue;
        }

        // Normalise predicate — fall back to 'relates_to' for unknown types
        const predicate: EdgeType = (EDGE_TYPES as readonly string[]).includes(triple.predicate)
          ? triple.predicate as EdgeType
          : 'relates_to';

        // Normalise node types — fall back to 'person' for unknown or non-entity types.
        // 'fact' is intentionally excluded: relationship edges must connect entity nodes.
        const subjectType: NodeType = ENTITY_NODE_TYPES.has(triple.subjectType)
          ? triple.subjectType as NodeType
          : 'person';
        const objectType: NodeType = ENTITY_NODE_TYPES.has(triple.objectType)
          ? triple.objectType as NodeType
          : 'person';

        // Resolve subject — prefer a node whose type matches the extraction.
        // Falling back to the first match handles cases where a node was previously
        // created under a different type; creating a new node is the last resort.
        const subjectMatches = await ctx.entityMemory.findEntities(triple.subject);
        const subjectMatch = subjectMatches.find(n => n.type === subjectType) ?? subjectMatches[0];
        const subjectNode = subjectMatch ?? (await ctx.entityMemory.createEntity({
          type: subjectType,
          label: triple.subject,
          properties: {},
          source,
          confidence: 0.6,
        })).entity;

        // Resolve object — same pattern
        const objectMatches = await ctx.entityMemory.findEntities(triple.object);
        const objectMatch = objectMatches.find(n => n.type === objectType) ?? objectMatches[0];
        const objectNode = objectMatch ?? (await ctx.entityMemory.createEntity({
          type: objectType,
          label: triple.object,
          properties: {},
          source,
          confidence: 0.6,
        })).entity;

        // Skip self-loops — subject and object resolved to the same node.
        // The extraction prompt asks for two distinct entities but the LLM can still
        // produce a triple like ("Alice", "knows", "Alice") on malformed input.
        if (subjectNode.id === objectNode.id) {
          ctx.log.warn({ subject: triple.subject, object: triple.object }, 'extract-relationships: skipping self-loop triple');
          continue;
        }

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
        // Log at error (not warn) — persistence failures are infrastructure errors
        // (DB outage, connection loss) that must surface in Sentry, not soft warnings.
        // The skill still returns success so the coordinator can continue, but the
        // failed count lets callers see that triples were dropped.
        ctx.log.error({ err, subject: triple.subject, object: triple.object }, 'extract-relationships: failed to persist triple, skipping');
        failed++;
      }
    }

    ctx.log.info({ extracted, confirmed, failed }, 'extract-relationships: complete');
    return { success: true, data: { extracted, confirmed, failed, skipped: false } };
    } catch (err) {
      // Top-level catch for unexpected errors (e.g. provider implementation bugs that
      // throw instead of returning { type: 'error' }).
      // Skills must never throw — return a failure result so the execution layer
      // can audit and surface the error to the caller.
      ctx.log.error({ err }, 'extract-relationships: unexpected error');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
