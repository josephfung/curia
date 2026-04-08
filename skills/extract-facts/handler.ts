// handler.ts — extract-facts skill.
//
// Self-classifying: runs a cheap haiku gate first and exits early when the
// message contains no single-entity attribute facts. Only fires the full
// extraction prompt (sonnet) when the classifier says yes.
//
// Idempotent: storeFact() handles deduplication — reasserting the same fact
// merges into or confirms the existing fact node rather than creating a duplicate.

import Anthropic from '@anthropic-ai/sdk';
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { DECAY_CLASSES, NODE_TYPES } from '../../src/memory/types.js';
import type { DecayClass, NodeType } from '../../src/memory/types.js';

// Model constants — update here when model IDs rotate
const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';
const EXTRACTION_MODEL = 'claude-sonnet-4-6';

// Shape of each fact returned by the LLM extraction prompt.
interface ExtractedFact {
  subject: string;
  subjectType: NodeType;
  attribute: string;
  value: string;
  confidence: number;
  decayClass: DecayClass;
}

const NODE_TYPES_LIST = NODE_TYPES.filter(t => t !== 'fact').join(', ');
const DECAY_CLASSES_LIST = DECAY_CLASSES.join(', ');

export class ExtractFactsHandler implements SkillHandler {
  // Optional Anthropic client injection for testing.
  // In production the skill registry instantiates with no args and the
  // handler creates its own client from ctx.secret('ANTHROPIC_API_KEY').
  constructor(private readonly anthropicClient?: Anthropic) {}

  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { text, source } = ctx.input as { text?: string; source?: string };

    if (!text || typeof text !== 'string') {
      ctx.log.error({ input: ctx.input }, 'extract-facts: missing required input "text"');
      return { success: false, error: 'Missing required input: text (string)' };
    }
    if (!source || typeof source !== 'string') {
      ctx.log.error({ input: ctx.input }, 'extract-facts: missing required input "source"');
      return { success: false, error: 'Missing required input: source (string)' };
    }
    if (!ctx.entityMemory) {
      ctx.log.error('extract-facts: entity memory not available — is the database configured?');
      return { success: false, error: 'Entity memory not available — database not configured' };
    }

    const client = this.anthropicClient ?? new Anthropic({ apiKey: ctx.secret('ANTHROPIC_API_KEY') });

    try {
      // -- Step 1: Classifier gate --
      // Cheap haiku call — exits early on messages that carry no facts about a
      // single entity (e.g. action requests, scheduling, relationship-only text).
      const classifierResponse = await client.messages.create({
        model: CLASSIFIER_MODEL,
        max_tokens: 10,
        messages: [{
          role: 'user',
          content: `Does the following text assert an attribute, fact, or characteristic about a single person or organisation (for example: where they live, their role, their preferences, their location)? Answer only 'yes' or 'no'.\n\n${text}`,
        }],
      });

      const classifierTextBlock = classifierResponse.content.find(
        (c): c is { type: 'text'; text: string } => c.type === 'text',
      );
      if (!classifierTextBlock) {
        ctx.log.warn({ textPreview: text.slice(0, 80) }, 'extract-facts: classifier returned no text block, skipping');
        return { success: true, data: { stored: 0, skipped: true, failed: 0 } };
      }
      const classifierAnswer = classifierTextBlock.text.toLowerCase().trim();

      if (!classifierAnswer.startsWith('yes')) {
        ctx.log.debug({ textPreview: text.slice(0, 80) }, 'extract-facts: classifier gate — no facts, skipping');
        return { success: true, data: { stored: 0, skipped: true, failed: 0 } };
      }

      // -- Step 2: Extraction prompt --
      // Sonnet call with the full vocabulary. Returns JSON array of facts.
      const extractionResponse = await client.messages.create({
        model: EXTRACTION_MODEL,
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `Extract single-entity attribute facts from the text below. Return a JSON array of fact objects.

Available subject types (for the entity the fact is about): ${NODE_TYPES_LIST}
Available decay classes: ${DECAY_CLASSES_LIST}

Decay class guidance:
- permanent: identity facts unlikely to ever change (e.g. date of birth, nationality)
- slow_decay: stable attributes that change rarely (e.g. where someone lives, job title)
- fast_decay: time-sensitive or context-specific facts (e.g. currently travelling, in a meeting)

Rules:
- Only extract facts about a SINGLE entity (person, organization, etc.)
- Do NOT extract relationships between two entities — those are handled elsewhere
- attribute should be a short snake_case key (e.g. "home_city", "job_title", "dietary_preference")
- value should be a concise string (e.g. "Toronto", "CEO", "vegetarian")
- Set confidence between 0.0 and 1.0 based on how explicitly the fact is stated
- Return ONLY valid JSON, no explanation or markdown fences

Format:
[{"subject":"<name>","subjectType":"<nodeType>","attribute":"<attribute>","value":"<value>","confidence":<number>,"decayClass":"<decayClass>"}]

Text:
${text}`,
        }],
      });

      const extractionTextBlock = extractionResponse.content.find(
        (c): c is { type: 'text'; text: string } => c.type === 'text',
      );
      if (!extractionTextBlock) {
        ctx.log.warn('extract-facts: extraction returned no text block, treating as empty');
        return { success: true, data: { stored: 0, skipped: false, failed: 0 } };
      }
      // Strip optional markdown code fences the model may include despite instructions.
      const rawText = extractionTextBlock.text.trim();
      const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

      let facts: ExtractedFact[];
      try {
        const parsed = JSON.parse(jsonText) as unknown;
        if (!Array.isArray(parsed)) {
          ctx.log.warn({ rawText }, 'extract-facts: extraction returned non-array, treating as empty');
          return { success: true, data: { stored: 0, skipped: false, failed: 0 } };
        }
        facts = parsed as ExtractedFact[];
      } catch (err) {
        ctx.log.warn({ err, rawText }, 'extract-facts: failed to parse extraction JSON, treating as empty');
        return { success: true, data: { stored: 0, skipped: false, failed: 0 } };
      }

      // -- Steps 3 & 4: Entity resolution + fact storage --
      let stored = 0;
      let failed = 0;

      // Entity node types (fact nodes themselves are excluded as subjects —
      // we look up or create entity nodes, then attach facts to them).
      const ENTITY_NODE_TYPES: ReadonlySet<string> = new Set(
        NODE_TYPES.filter(t => t !== 'fact'),
      );

      for (const fact of facts) {
        try {
          // Guard: skip malformed entries where required string fields are absent.
          if (
            !fact ||
            typeof fact.subject !== 'string' ||
            typeof fact.attribute !== 'string' ||
            typeof fact.value !== 'string'
          ) {
            ctx.log.warn({ fact }, 'extract-facts: skipping malformed fact');
            failed++;
            continue;
          }

          // Normalise subject type — fall back to 'person' for unknown or non-entity types.
          const subjectType: NodeType = ENTITY_NODE_TYPES.has(fact.subjectType)
            ? fact.subjectType as NodeType
            : 'person';

          // Normalise decay class — fall back to 'slow_decay' for unknown values.
          const decayClass: DecayClass = (DECAY_CLASSES as readonly string[]).includes(fact.decayClass)
            ? fact.decayClass as DecayClass
            : 'slow_decay';

          // Clamp confidence to [0, 1] in case the LLM returns an out-of-range value.
          const confidence = typeof fact.confidence === 'number'
            ? Math.min(1, Math.max(0, fact.confidence))
            : 0.7;

          // Resolve entity node — prefer a node whose type matches the extraction.
          // Create a new entity node if none exists.
          const matches = await ctx.entityMemory.findEntities(fact.subject);
          const match = matches.find(n => n.type === subjectType) ?? matches[0];
          const entityNode = match ?? (await ctx.entityMemory.createEntity({
            type: subjectType,
            label: fact.subject,
            properties: {},
            source,
            confidence: 0.6,
          })).entity;

          // Label format: "<attribute>: <value>" — human-readable and dedup-stable.
          // The validator uses semantic similarity on this label for near-duplicate detection.
          const label = `${fact.attribute}: ${fact.value}`;

          const result = await ctx.entityMemory.storeFact({
            entityNodeId: entityNode.id,
            label,
            properties: { attribute: fact.attribute, value: fact.value },
            confidence,
            decayClass,
            source,
          });

          if (result.stored) {
            stored++;
          } else {
            // storeFact returns stored:false on rate-limit rejection or contradiction.
            // Log at warn (not error) — these are expected semantic outcomes, not infra failures.
            ctx.log.warn({ subject: fact.subject, attribute: fact.attribute, conflict: result.conflict }, 'extract-facts: fact rejected or conflicted');
          }
        } catch (err) {
          // Log at error — persistence failures are infrastructure errors (DB outage,
          // connection loss) that must surface in Sentry, not soft warnings.
          ctx.log.error({ err, subject: fact.subject, attribute: fact.attribute }, 'extract-facts: failed to persist fact, skipping');
          failed++;
        }
      }

      ctx.log.info({ stored, failed }, 'extract-facts: complete');
      return { success: true, data: { stored, skipped: false, failed } };
    } catch (err) {
      // Top-level catch for Anthropic API errors (rate limits, auth, timeouts, 5xx).
      ctx.log.error({ err }, 'extract-facts: unexpected error');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
