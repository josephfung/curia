// handler.ts — extract-facts skill.
//
// Self-classifying: runs a cheap haiku gate first and exits early when the
// message contains no single-entity attribute facts. Only fires the full
// extraction prompt (sonnet) when the classifier says yes.
//
// Idempotent: storeFact() handles deduplication — reasserting the same fact
// merges into or confirms the existing fact node rather than creating a duplicate.
//
// LLM calls go through the constrained InfraLlm service (classify + extract only),
// which routes through ModelRouter and publishes llm.call bus events for telemetry.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { DECAY_CLASSES, NODE_TYPES } from '../../src/memory/types.js';
import type { DecayClass, NodeType } from '../../src/memory/types.js';
import { buildCanonicalPatch } from '../../src/contacts/canonical-attribute-guard.js';

// Shape of each fact returned by the LLM extraction prompt.
interface ExtractedFact {
  subject: string;
  subjectType: NodeType;
  attribute: string;
  value: string;
  confidence: number;
  decayClass: DecayClass;
}

// 'fact' is excluded from the prompt's subject-type list so the LLM never emits
// subjectType:"fact" in its output — entity subjects must be non-fact nodes.
// The ENTITY_NODE_TYPES Set below is the runtime safety net for the same constraint.
const NODE_TYPES_LIST = NODE_TYPES.filter(t => t !== 'fact').join(', ');
const DECAY_CLASSES_LIST = DECAY_CLASSES.join(', ');

export class ExtractFactsHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { text, source } = ctx.input as { text?: string; source?: string };

    if (!text || typeof text !== 'string') {
      // Log only safe metadata — never log ctx.input directly (contains full transcript)
      ctx.log.error({ hasText: typeof text === 'string', hasSource: typeof source === 'string' }, 'extract-facts: missing required input "text"');
      return { success: false, error: 'Missing required input: text (string)' };
    }
    if (!source || typeof source !== 'string') {
      ctx.log.error({ hasText: typeof text === 'string', hasSource: typeof source === 'string' }, 'extract-facts: missing required input "source"');
      return { success: false, error: 'Missing required input: source (string)' };
    }
    if (!ctx.entityMemory) {
      ctx.log.error('extract-facts: entity memory not available — is the database configured?');
      return { success: false, error: 'Entity memory not available — database not configured' };
    }

    // Guard: infraLlm is a required capability declared in skill.json.
    if (!ctx.infraLlm) {
      ctx.log.error('extract-facts: infraLlm capability missing — execution layer misconfigured');
      return { success: false, error: 'extract-facts requires infraLlm capability' };
    }

    try {
      // -- Step 1: Classifier gate --
      // Cheap fast-tier call — exits early on messages that carry no facts about a
      // single entity (e.g. action requests, scheduling, relationship-only text).
      const classifyResult = await ctx.infraLlm.classify(
        `Does the following text assert an attribute, fact, or characteristic about a single entity (for example: a person, organisation, project, event, or other entity — such as where they are located, their role, their status, or their preferences)? Answer only 'yes' or 'no'.\n\n${text}`,
      );

      if (!classifyResult.ok) {
        ctx.log.error({ error: classifyResult.error }, 'extract-facts: classifier LLM call failed');
        return { success: false, error: `Classifier LLM call failed: ${classifyResult.error}` };
      }

      const classifierAnswer = classifyResult.text.toLowerCase().trim();

      if (!classifierAnswer.startsWith('yes')) {
        ctx.log.debug({ textPreview: text.slice(0, 80) }, 'extract-facts: classifier gate — no facts, skipping');
        return { success: true, data: { stored: 0, redirected: 0, skipped: true, failed: 0 } };
      }

      // -- Step 2: Extraction prompt --
      // Standard-tier call with the full vocabulary. Returns JSON array of facts.
      const extractionResult = await ctx.infraLlm.extract(
        `Extract single-entity attribute facts from the text below. Return a JSON array of fact objects.

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
        { maxTokens: 1000 },
      );

      if (!extractionResult.ok) {
        ctx.log.error({ error: extractionResult.error }, 'extract-facts: extraction LLM call failed');
        return { success: false, error: `Extraction LLM call failed: ${extractionResult.error}` };
      }

      // Strip optional markdown code fences the model may include despite instructions.
      const rawText = extractionResult.text.trim();
      const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

      let facts: ExtractedFact[];
      try {
        const parsed = JSON.parse(jsonText) as unknown;
        if (!Array.isArray(parsed)) {
          // Log length only — rawText may contain extracted facts (PII).
          // Return failure so the checkpoint processor distinguishes this from a
          // legitimate "no facts" run and logs it for operational visibility.
          ctx.log.warn({ responseLength: rawText.length }, 'extract-facts: extraction returned non-array');
          return { success: false, error: 'Extraction returned non-array response' };
        }
        facts = parsed as ExtractedFact[];
      } catch (err) {
        ctx.log.warn({ err, responseLength: rawText.length }, 'extract-facts: failed to parse extraction JSON');
        return { success: false, error: 'Failed to parse extraction JSON' };
      }

      // -- Steps 3 & 4: Entity resolution + fact storage --
      let stored = 0;
      let redirected = 0;
      // failed counts: malformed LLM output (guard below), rate-limited facts (loop
      // breaks immediately on first hit), and infrastructure errors from storeFact.
      // Contradictions (action:'conflict') are NOT counted as failed — they are expected
      // semantic outcomes logged at warn.
      let failed = 0;

      // Entity node types (fact nodes themselves are excluded as subjects —
      // we look up or create entity nodes, then attach facts to them).
      const ENTITY_NODE_TYPES: ReadonlySet<string> = new Set(
        NODE_TYPES.filter(t => t !== 'fact'),
      );

      for (const fact of facts) {
        // Declared before try so the catch block can always reference them,
        // even if an exception fires before the assignments inside try would run.
        // Empty string is the safe sentinel — falsy, so the malformed-fact guard
        // below fires correctly when subject or attribute could not be determined.
        let subject = typeof fact?.subject === 'string' ? fact.subject.trim() : '';
        let attribute = typeof fact?.attribute === 'string' ? fact.attribute.trim() : '';

        try {
          // Guard: skip malformed entries where required string fields are absent or blank.
          // Blank strings would create empty-label entities or facts labelled ": ".
          // subject and attribute are pre-computed above; only value needs its typeof check here.
          if (
            !fact ||
            !subject ||
            !attribute ||
            typeof fact.value !== 'string' || !fact.value.trim()
          ) {
            ctx.log.warn(
              {
                // Log only field types — never the raw values (subject/attribute/value may contain PII).
                subjectType: typeof fact?.subject,
                attributeType: typeof fact?.attribute,
                valueType: typeof fact?.value,
              },
              'extract-facts: skipping malformed fact',
            );
            failed++;
            continue;
          }

          // value is not referenced in the catch block so it stays here.
          const value = fact.value.trim();

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

          // Resolve entity node — finds or auto-creates via resolveOrCreate().
          // Ambiguous case (2+ nodes, no type match) takes candidates[0] rather than
          // stalling the background batch job with a disambiguation loop.
          const resolved = await ctx.entityMemory.resolveOrCreate({
            label: subject,
            type: subjectType,
            source,
            confidence: 0.6,
          });
          let entityNode;
          if (resolved.kind === 'ambiguous') {
            entityNode = resolved.candidates[0]!;
            ctx.log.warn(
              { subject, candidateCount: resolved.candidates.length, chosenId: entityNode.id },
              'extract-facts: ambiguous subject entity — taking first candidate',
            );
          } else {
            entityNode = resolved.node;
          }

          // --- Canonical contact attribute guard ---
          //
          // If the entity is a person node linked to a contact record, redirect
          // canonical attribute writes (timezone, title, organization, etc.) to
          // ContactService.updateContactFields() rather than the KG.
          if (entityNode.type === 'person' && ctx.contactService) {
            const patch = buildCanonicalPatch(attribute, value);
            if (patch !== null) {
              if (patch.fallbackToKg) {
                ctx.log.warn(
                  { subject, attribute, reason: patch.reason },
                  'extract-facts: canonical attribute normalization failed — falling back to KG write',
                );
              } else {
                const contact = await ctx.contactService.findContactByKgNodeId(entityNode.id);
                if (contact) {
                  try {
                    await ctx.contactService.updateContactFields(contact.id, patch.fields);
                    ctx.log.info(
                      { subject, attribute, contactId: contact.id },
                      'extract-facts: canonical attribute redirected to ContactService',
                    );
                    redirected++;
                    continue;
                  } catch (err) {
                    // Validation error (e.g. primaryEmail not in CCI) — log and fall
                    // through to the KG write so the information is not lost entirely.
                    ctx.log.warn(
                      { subject, attribute, contactId: contact.id, err },
                      'extract-facts: canonical attribute redirect failed — falling back to KG write',
                    );
                  }
                }
                // No contact record for this person node — fall through to KG write.
              }
            }
          }

          // Label format: "<attribute>: <value>" — human-readable and dedup-stable.
          // The validator uses semantic similarity on this label for near-duplicate detection.
          const label = `${attribute}: ${value}`;

          // Use the context-aware source key so the rate limit counter matches
          // what AgentRuntime.resetRateLimit() clears after each task. The
          // LLM-provided `source` is a fallback for test/CLI contexts.
          const effectiveSource = ctx.memoryWriteSource ?? source;
          if (!ctx.memoryWriteSource) {
            ctx.log.debug(
              { fallbackSource: source },
              'extract-facts: memoryWriteSource not set — using input source fallback',
            );
          }

          const result = await ctx.entityMemory.storeFact({
            entityNodeId: entityNode.id,
            label,
            properties: { attribute, value },
            confidence,
            decayClass,
            source: effectiveSource,
          });

          if (result.stored) {
            if (result.action === 'auto_resolved') {
              // Incoming fact superseded a lower-confidence existing fact — audit trail preserved.
              ctx.log.info(
                { subject, attribute, source: effectiveSource, nodeId: result.nodeId },
                'extract-facts: fact auto-resolved — existing superseded by higher-confidence incoming',
              );
            }
            stored++;
          } else if (result.action === 'rate_limited') {
            // The 50-writes-per-task limit is exhausted — all remaining storeFact calls
            // in this batch will also fail, so break immediately rather than burning
            // through the rest of the loop and mis-reporting them as conflicts.
            ctx.log.error(
              { subject, attribute, source: effectiveSource, reason: result.conflict },
              'extract-facts: write rate limit exceeded — aborting remaining facts in batch',
            );
            failed++;
            break;
          } else {
            // conflict, auto_rejected, or entity_not_found — expected semantic outcomes, not infra failures.
            ctx.log.warn({ subject, attribute, conflict: result.conflict, action: result.action, source: effectiveSource }, 'extract-facts: fact not stored');
          }
        } catch (err) {
          // Re-throw programming errors — these indicate bugs in this handler (wrong
          // property access, invalid argument, unexpected resolveOrCreate return shape),
          // not transient infra failures. Absorbing them into `failed` hides regressions
          // behind a misleading metric; the outer catch will return { success: false }.
          if (
            err instanceof TypeError ||
            err instanceof ReferenceError ||
            err instanceof RangeError ||
            err instanceof EvalError ||
            err instanceof URIError
          ) {
            ctx.log.error({ err, subject, attribute }, 'extract-facts: unexpected programming error in fact loop — re-throwing');
            throw err;
          }
          // Infrastructure errors (DB outage, connection loss) — log at error so they
          // surface in Sentry, then continue processing the remaining facts in the batch.
          // subject and attribute are always in scope here (declared before this try).
          ctx.log.error({ err, subject, attribute }, 'extract-facts: failed to persist fact, skipping');
          failed++;
        }
      }

      ctx.log.info({ stored, redirected, failed }, 'extract-facts: complete');
      return { success: true, data: { stored, redirected, skipped: false, failed } };
    } catch (err) {
      // Two categories of errors reach here:
      // 1. LLMProvider errors (rate limits, auth, timeouts, 5xx) — these are returned as
      //    { type: 'error' } values above, not thrown, so this catch only fires for
      //    unexpected cases (e.g. provider implementation bug that throws instead of returning).
      // 2. Programming errors (TypeError, ReferenceError, RangeError, EvalError, URIError)
      //    re-thrown from the per-fact loop — indicate bugs in this handler, not infra issues.
      ctx.log.error({ err }, 'extract-facts: unexpected error');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
