// handler.test.ts — unit tests for extract-facts skill.
//
// Uses an in-memory KG backend (no Postgres) and mock infraLlm
// injected via ctx, so no real API calls are made.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { createSilentLogger } from '../../src/logger.js';
import { ExtractFactsHandler } from './handler.js';
import { ContactValidationError } from '../../src/contacts/contact-service.js';
import type { ToolContext } from '../../src/skills/types.js';
import type { InfraLlm, InfraLlmResult } from '../../src/skills/infra-llm.js';

// -- Test helpers --

function makeEntityMemory(): EntityMemory {
  const embeddingService = EmbeddingService.createForTesting();
  const store = KnowledgeGraphStore.createInMemory(embeddingService);
  const validator = new MemoryValidator(store, embeddingService);
  return new EntityMemory(store, validator, embeddingService, createSilentLogger());
}

// Creates a mock infraLlm for injection into ctx.
// responses: scripted sequence of text responses — first call goes to classify()
// (classifier gate), second call (if triggered) goes to extract().
function makeMockInfraLlm(responses: string[]): InfraLlm {
  let callIndex = 0;

  return {
    classify: vi.fn().mockImplementation((): Promise<InfraLlmResult> => {
      const text = responses[callIndex++] ?? 'no';
      return Promise.resolve({ ok: true, text });
    }),
    extract: vi.fn().mockImplementation((): Promise<InfraLlmResult> => {
      const text = responses[callIndex++] ?? '[]';
      return Promise.resolve({ ok: true, text });
    }),
  };
}

function makeCtx(
  entityMemory: EntityMemory,
  input: Record<string, unknown>,
  infraLlm: InfraLlm,
  contactService?: unknown,
): ToolContext {
  return {
    input,
    secret: () => 'test-api-key',
    log: pino({ level: 'silent' }),
    entityMemory,
    infraLlm,
    contactService,
  } as unknown as ToolContext;
}

// -- Tests --

describe('ExtractFactsHandler', () => {
  it('returns skipped:true when classifier gate fires on unrelated text', async () => {
    const entityMemory = makeEntityMemory();
    const infraLlm = makeMockInfraLlm(['no']);
    const handler = new ExtractFactsHandler();
    const ctx = makeCtx(entityMemory, {
      text: 'Ada manages Project Orion and works closely with Bob.',
      source: 'test',
    }, infraLlm);

    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: true, data: { stored: 0, redirected: 0, skipped: true, failed: 0, ambiguous: 0 } });
    // Classifier was called; extraction was not
    expect(infraLlm.classify).toHaveBeenCalledTimes(1);
    expect(infraLlm.extract).not.toHaveBeenCalled();
  });

  it('acceptance criterion: "Bob lives in Toronto" stores a location fact', async () => {
    const entityMemory = makeEntityMemory();
    const facts = JSON.stringify([
      { subject: 'Jane Doe', subjectType: 'person', attribute: 'home_city', value: 'Toronto', confidence: 0.9, decayClass: 'slow_decay' },
    ]);
    const infraLlm = makeMockInfraLlm(['yes', facts]);
    const handler = new ExtractFactsHandler();
    const ctx = makeCtx(entityMemory, {
      text: 'Bob lives in Toronto.',
      source: 'test',
    }, infraLlm);

    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: true, data: { stored: 1, redirected: 0, skipped: false, failed: 0, ambiguous: 0 } });

    // Fact node exists in the KG
    const josephNodes = await entityMemory.findEntities('Jane Doe');
    expect(josephNodes).toHaveLength(1);
    const storedFacts = await entityMemory.getFacts(josephNodes[0]!.id);
    expect(storedFacts).toHaveLength(1);
    expect(storedFacts[0]!.label).toBe('home_city: Toronto');
    expect(storedFacts[0]!.temporal.decayClass).toBe('slow_decay');
  });

  it('stores a fast_decay fact correctly', async () => {
    const entityMemory = makeEntityMemory();
    const facts = JSON.stringify([
      { subject: 'Ada Lovelace', subjectType: 'person', attribute: 'current_location', value: 'London', confidence: 0.8, decayClass: 'fast_decay' },
    ]);
    const infraLlm = makeMockInfraLlm(['yes', facts]);
    const handler = new ExtractFactsHandler();
    const ctx = makeCtx(entityMemory, {
      text: 'Ada is currently in London this week.',
      source: 'test',
    }, infraLlm);

    await handler.execute(ctx);

    const adaNodes = await entityMemory.findEntities('Ada Lovelace');
    expect(adaNodes).toHaveLength(1);
    const storedFacts = await entityMemory.getFacts(adaNodes[0]!.id);
    expect(storedFacts).toHaveLength(1);
    expect(storedFacts[0]!.temporal.decayClass).toBe('fast_decay');
  });

  it('creates the entity node if it does not already exist', async () => {
    const entityMemory = makeEntityMemory();
    const facts = JSON.stringify([
      { subject: 'Brand New Person', subjectType: 'person', attribute: 'role', value: 'engineer', confidence: 0.85, decayClass: 'slow_decay' },
    ]);
    const infraLlm = makeMockInfraLlm(['yes', facts]);
    const handler = new ExtractFactsHandler();
    const ctx = makeCtx(entityMemory, {
      text: 'Brand New Person is an engineer.',
      source: 'test',
    }, infraLlm);

    await handler.execute(ctx);

    const nodes = await entityMemory.findEntities('Brand New Person');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.type).toBe('person');
    // Nodes created by extraction get a lower confidence (0.6)
    expect(nodes[0]!.temporal.confidence).toBe(0.6);
  });

  it('falls back to slow_decay for an unknown decayClass in the extraction output', async () => {
    const entityMemory = makeEntityMemory();
    const facts = JSON.stringify([
      { subject: 'Jane Doe', subjectType: 'person', attribute: 'role', value: 'CEO', confidence: 0.9, decayClass: 'ultra_slow' },
    ]);
    const infraLlm = makeMockInfraLlm(['yes', facts]);
    const handler = new ExtractFactsHandler();
    const ctx = makeCtx(entityMemory, {
      text: 'Bob is the CEO.',
      source: 'test',
    }, infraLlm);

    await handler.execute(ctx);

    const josephNodes = await entityMemory.findEntities('Jane Doe');
    expect(josephNodes).toHaveLength(1);
    const storedFacts = await entityMemory.getFacts(josephNodes[0]!.id);
    expect(storedFacts[0]!.temporal.decayClass).toBe('slow_decay');
  });

  it('is idempotent — second call with same fact does not create a duplicate node', async () => {
    const entityMemory = makeEntityMemory();
    const facts = JSON.stringify([
      { subject: 'Jane Doe', subjectType: 'person', attribute: 'home_city', value: 'Toronto', confidence: 0.9, decayClass: 'slow_decay' },
    ]);

    // First invocation — stores the fact
    const infraLlm1 = makeMockInfraLlm(['yes', facts]);
    const handler1 = new ExtractFactsHandler();
    const ctx1 = makeCtx(entityMemory, { text: 'Bob lives in Toronto.', source: 'test' }, infraLlm1);
    const result1 = await handler1.execute(ctx1);
    expect(result1).toEqual({ success: true, data: { stored: 1, redirected: 0, skipped: false, failed: 0, ambiguous: 0 } });

    // Second invocation with semantically identical fact — storeFact deduplicates internally
    const infraLlm2 = makeMockInfraLlm(['yes', facts]);
    const handler2 = new ExtractFactsHandler();
    const ctx2 = makeCtx(entityMemory, { text: 'Bob lives in Toronto.', source: 'test' }, infraLlm2);
    const result2 = await handler2.execute(ctx2);
    expect(result2).toEqual({ success: true, data: { stored: 1, redirected: 0, skipped: false, failed: 0, ambiguous: 0 } });

    // Only one fact node should exist — storeFact merged the second call into the first
    const josephNodes = await entityMemory.findEntities('Jane Doe');
    expect(josephNodes).toHaveLength(1);
    const storedFacts = await entityMemory.getFacts(josephNodes[0]!.id);
    expect(storedFacts).toHaveLength(1);
  });

  it('returns error when text input is missing', async () => {
    const entityMemory = makeEntityMemory();
    const infraLlm = makeMockInfraLlm([]);
    const handler = new ExtractFactsHandler();
    const ctx = makeCtx(entityMemory, { source: 'test' }, infraLlm);

    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: false, error: 'Missing required input: text (string)' });
    expect(infraLlm.classify).not.toHaveBeenCalled();
  });

  it('returns failure when extraction returns non-array — distinguishable from legitimate no-facts run', async () => {
    const entityMemory = makeEntityMemory();
    const infraLlm = makeMockInfraLlm(['yes', 'null']);
    const handler = new ExtractFactsHandler();
    const ctx = makeCtx(entityMemory, {
      text: 'Bob lives in Toronto.',
      source: 'test',
    }, infraLlm);

    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: false, error: 'Extraction returned non-array response' });
  });

  it('handles storeFact conflict — fact not stored, not counted as failed', async () => {
    const entityMemory = makeEntityMemory();
    const facts = JSON.stringify([
      { subject: 'Jane Doe', subjectType: 'person', attribute: 'home_city', value: 'Toronto', confidence: 0.9, decayClass: 'slow_decay' },
    ]);
    const infraLlm = makeMockInfraLlm(['yes', facts]);
    const handler = new ExtractFactsHandler();

    // Mock storeFact to return a conflict (contradicts an existing fact)
    const storeFact = vi.spyOn(entityMemory, 'storeFact').mockResolvedValueOnce({
      stored: false,
      action: 'conflict',
      conflict: 'contradicts existing value: London',
    });

    const ctx = makeCtx(entityMemory, { text: 'Bob lives in Toronto.', source: 'test' }, infraLlm);
    const result = await handler.execute(ctx);

    // conflict is a semantic outcome — not counted as failed
    expect(result).toEqual({ success: true, data: { stored: 0, redirected: 0, skipped: false, failed: 0, ambiguous: 0 } });
    expect(storeFact).toHaveBeenCalledOnce();
  });

  it('uses memoryWriteSource as storeFact source, overriding the LLM-provided source', async () => {
    const entityMemory = makeEntityMemory();
    const facts = JSON.stringify([
      { subject: 'Jane Doe', subjectType: 'person', attribute: 'home_city', value: 'Toronto', confidence: 0.9, decayClass: 'slow_decay' },
    ]);
    const infraLlm = makeMockInfraLlm(['yes', facts]);
    const handler = new ExtractFactsHandler();

    const storeFact = vi.spyOn(entityMemory, 'storeFact').mockResolvedValueOnce({ stored: true, action: 'created' });

    const memoryWriteSource = 'agent:ceo-inbox/task:task-abc/channel:http';
    const ctx = {
      input: { text: 'Jane Doe lives in Toronto.', source: 'agent:ceo-inbox' },
      secret: () => 'test-api-key',
      log: pino({ level: 'silent' }),
      entityMemory,
      infraLlm,
      memoryWriteSource,
    } as unknown as ToolContext;

    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: true, data: { stored: 1, redirected: 0, skipped: false, failed: 0, ambiguous: 0 } });
    // storeFact should use memoryWriteSource (task-scoped), not the LLM-provided 'agent:ceo-inbox'
    expect(storeFact.mock.calls[0]![0].source).toBe(memoryWriteSource);
  });

  it('breaks immediately on rate_limited mid-batch — increments failed, skips remaining facts', async () => {
    const entityMemory = makeEntityMemory();
    // Three facts — first stored successfully, second hits rate limit, third should never be attempted.
    const facts = JSON.stringify([
      { subject: 'Jane Doe', subjectType: 'person', attribute: 'home_city', value: 'Toronto', confidence: 0.9, decayClass: 'slow_decay' },
      { subject: 'Jane Doe', subjectType: 'person', attribute: 'job_title', value: 'CEO', confidence: 0.9, decayClass: 'slow_decay' },
      { subject: 'Jane Doe', subjectType: 'person', attribute: 'nationality', value: 'Canadian', confidence: 0.9, decayClass: 'permanent' },
    ]);
    const infraLlm = makeMockInfraLlm(['yes', facts]);
    const handler = new ExtractFactsHandler();

    const storeFact = vi.spyOn(entityMemory, 'storeFact')
      .mockResolvedValueOnce({ stored: true, action: 'created' })
      .mockResolvedValueOnce({ stored: false, action: 'rate_limited', conflict: '50-write limit reached' });

    const ctx = makeCtx(entityMemory, { text: 'Jane Doe is the Canadian CEO based in Toronto.', source: 'test' }, infraLlm);
    const result = await handler.execute(ctx);

    // first fact stored, rate-limit counted as failed, loop stopped before fact 3
    expect(result).toEqual({ success: true, data: { stored: 1, redirected: 0, skipped: false, failed: 1, ambiguous: 0 } });
    expect(storeFact).toHaveBeenCalledTimes(2);
  });

  it('programming error (TypeError) in per-fact loop is re-thrown — returns { success: false }', async () => {
    const entityMemory = makeEntityMemory();
    const facts = JSON.stringify([
      { subject: 'Jane Doe', subjectType: 'person', attribute: 'home_city', value: 'Toronto', confidence: 0.9, decayClass: 'slow_decay' },
    ]);
    const infraLlm = makeMockInfraLlm(['yes', facts]);
    const handler = new ExtractFactsHandler();

    vi.spyOn(entityMemory, 'storeFact').mockRejectedValueOnce(new TypeError("Cannot read properties of undefined (reading 'id')"));

    const ctx = makeCtx(entityMemory, { text: 'Jane Doe lives in Toronto.', source: 'test' }, infraLlm);
    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: false, error: "Cannot read properties of undefined (reading 'id')" });
  });

  it('malformed-fact warn logs only structural metadata — not the raw fact object (PII guard)', async () => {
    const entityMemory = makeEntityMemory();
    // fact.value is null — triggers the malformed guard
    const facts = JSON.stringify([
      { subject: 'Jane Doe', subjectType: 'person', attribute: 'home_city', value: null, confidence: 0.9, decayClass: 'slow_decay' },
    ]);
    const infraLlm = makeMockInfraLlm(['yes', facts]);
    const handler = new ExtractFactsHandler();

    const log = pino({ level: 'silent' });
    const warnSpy = vi.spyOn(log, 'warn');
    const ctx = makeCtx(entityMemory, { text: 'Jane Doe lives in Toronto.', source: 'test' }, infraLlm);
    (ctx as unknown as Record<string, unknown>).log = log;

    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: true, data: { stored: 0, redirected: 0, skipped: false, failed: 1, ambiguous: 0 } });

    const malformedCall = warnSpy.mock.calls.find(
      (args) => typeof args[args.length - 1] === 'string' && (args[args.length - 1] as string).includes('skipping malformed fact'),
    );
    expect(malformedCall).toBeDefined();

    const loggedData = malformedCall![0] as Record<string, unknown>;
    expect(loggedData).not.toHaveProperty('fact');
    expect(loggedData).toHaveProperty('subjectType', 'string');
    expect(loggedData).toHaveProperty('attributeType', 'string');
    expect(loggedData).toHaveProperty('valueType', 'object');
  });

  it('catch block is safe when storeFact throws — failed incremented, no ReferenceError', async () => {
    const entityMemory = makeEntityMemory();
    const facts = JSON.stringify([
      { subject: 'Jane Doe', subjectType: 'person', attribute: 'home_city', value: 'Toronto', confidence: 0.9, decayClass: 'slow_decay' },
    ]);
    const infraLlm = makeMockInfraLlm(['yes', facts]);
    const handler = new ExtractFactsHandler();

    const storeFact = vi.spyOn(entityMemory, 'storeFact').mockRejectedValueOnce(new Error('DB connection lost'));

    const ctx = makeCtx(entityMemory, { text: 'Jane Doe lives in Toronto.', source: 'test' }, infraLlm);
    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: true, data: { stored: 0, redirected: 0, skipped: false, failed: 1, ambiguous: 0 } });
    expect(storeFact).toHaveBeenCalledTimes(1);
  });

  it('returns error when infraLlm capability is missing', async () => {
    const entityMemory = makeEntityMemory();
    const handler = new ExtractFactsHandler();
    const ctx = {
      input: { text: 'Bob lives in Toronto.', source: 'test' },
      secret: () => 'test-api-key',
      log: pino({ level: 'silent' }),
      entityMemory,
      // infraLlm intentionally omitted
    } as unknown as ToolContext;

    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: false, error: 'extract-facts requires infraLlm capability' });
  });

  it('returns error when classifier LLM call fails', async () => {
    const entityMemory = makeEntityMemory();
    const infraLlm: InfraLlm = {
      classify: vi.fn().mockResolvedValue({ ok: false, error: 'Rate limit exceeded' }),
      extract: vi.fn(),
    };
    const handler = new ExtractFactsHandler();
    const ctx = makeCtx(entityMemory, { text: 'Bob lives in Toronto.', source: 'test' }, infraLlm);

    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: false, error: 'Classifier LLM call failed: Rate limit exceeded' });
  });

  it('returns error when extraction LLM call fails', async () => {
    const entityMemory = makeEntityMemory();
    const infraLlm: InfraLlm = {
      classify: vi.fn().mockResolvedValue({ ok: true, text: 'yes' }),
      extract: vi.fn().mockResolvedValue({ ok: false, error: 'Context window exceeded' }),
    };
    const handler = new ExtractFactsHandler();
    const ctx = makeCtx(entityMemory, { text: 'Bob lives in Toronto.', source: 'test' }, infraLlm);

    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: false, error: 'Extraction LLM call failed: Context window exceeded' });
  });

  // -- Ambiguous subject resolution (#1694 / ADR-040) --
  //
  // This path used to take candidates[0] "to avoid stalling a batch job". Once two
  // contacts named "Seth Berman" each hold their own person node, that is a coin flip
  // that writes the fact onto whichever node sorted first. A dropped fact can be
  // re-extracted later; one silently attached to the wrong person cannot be found
  // again to correct. The only admissible tiebreaker is subject_contact_id, and only
  // when one candidate IS that contact's node — the hint identifies the conversation's
  // counterpart, not the subject of every sentence in it.
  describe('ambiguous subject', () => {
    // Needs the store as well as the memory wrapper, to seed colliding nodes directly
    // (upsertNode would merge them).
    function makeMemoryWithStore() {
      const embeddingService = EmbeddingService.createForTesting();
      const store = KnowledgeGraphStore.createInMemory(embeddingService);
      const validator = new MemoryValidator(store, embeddingService);
      return {
        mem: new EntityMemory(store, validator, embeddingService, createSilentLogger()),
        store,
      };
    }

    const SETH_FACT = JSON.stringify([
      { subject: 'Seth Berman', subjectType: 'person', attribute: 'home_city', value: 'Toronto', confidence: 0.9, decayClass: 'slow_decay' },
    ]);

    function makeContactService(contactsById: Record<string, { id: string; kgNodeId: string | null }>) {
      return {
        getContact: vi.fn(async (id: string) => contactsById[id]),
        findContactByKgNodeId: vi.fn(async () => undefined),
        updateContactFields: vi.fn(),
      };
    }

    async function seedTwoSeths(store: KnowledgeGraphStore) {
      const a = await store.createNode({ type: 'person', label: 'Seth Berman', properties: {}, source: 'test' });
      const b = await store.createNode({ type: 'person', label: 'Seth Berman', properties: {}, source: 'test' });
      return { a, b };
    }

    it('skips and counts the fact when ambiguous and no contact hint is given', async () => {
      const { mem, store } = makeMemoryWithStore();
      await seedTwoSeths(store);

      const result = await new ExtractFactsHandler().execute(
        makeCtx(mem, { text: 'Seth lives in Toronto.', source: 'test' }, makeMockInfraLlm(['yes', SETH_FACT])),
      );

      expect(result).toEqual({
        success: true,
        data: { stored: 0, redirected: 0, skipped: false, failed: 0, ambiguous: 1 },
      });
    });

    it('resolves to the hinted contact node when it is one of the candidates', async () => {
      const { mem, store } = makeMemoryWithStore();
      const { a, b } = await seedTwoSeths(store);
      const contactService = makeContactService({ 'contact-b': { id: 'contact-b', kgNodeId: b.id } });

      const result = await new ExtractFactsHandler().execute(
        makeCtx(
          mem,
          { text: 'Seth lives in Toronto.', source: 'test', subject_contact_id: 'contact-b' },
          makeMockInfraLlm(['yes', SETH_FACT]),
          contactService,
        ),
      );

      expect(result).toEqual({
        success: true,
        data: { stored: 1, redirected: 0, skipped: false, failed: 0, ambiguous: 0 },
      });
      // The fact hangs off contact B's node specifically, and does not leak onto the namesake.
      expect(await mem.getFacts(b.id)).toHaveLength(1);
      expect(await mem.getFacts(a.id)).toHaveLength(0);
    });

    it('skips rather than guessing when the hinted contact is not among the candidates', async () => {
      const { mem, store } = makeMemoryWithStore();
      await seedTwoSeths(store);
      const other = await store.createNode({ type: 'person', label: 'Dana Wu', properties: {}, source: 'test' });
      const contactService = makeContactService({ 'contact-c': { id: 'contact-c', kgNodeId: other.id } });

      const result = await new ExtractFactsHandler().execute(
        makeCtx(
          mem,
          { text: 'Seth lives in Toronto.', source: 'test', subject_contact_id: 'contact-c' },
          makeMockInfraLlm(['yes', SETH_FACT]),
          contactService,
        ),
      );

      expect(result).toEqual({
        success: true,
        data: { stored: 0, redirected: 0, skipped: false, failed: 0, ambiguous: 1 },
      });
    });

    it('skips when the hinted contact holds no KG node', async () => {
      // Exactly the #1694 population: a hint exists but cannot identify a node.
      const { mem, store } = makeMemoryWithStore();
      await seedTwoSeths(store);
      const contactService = makeContactService({ 'contact-d': { id: 'contact-d', kgNodeId: null } });

      const result = await new ExtractFactsHandler().execute(
        makeCtx(
          mem,
          { text: 'Seth lives in Toronto.', source: 'test', subject_contact_id: 'contact-d' },
          makeMockInfraLlm(['yes', SETH_FACT]),
          contactService,
        ),
      );

      expect(result).toEqual({
        success: true,
        data: { stored: 0, redirected: 0, skipped: false, failed: 0, ambiguous: 1 },
      });
    });

    it('degrades to no-tiebreaker when the contact lookup throws', async () => {
      // A contacts-table hiccup must not fail the whole extraction batch.
      const { mem, store } = makeMemoryWithStore();
      await seedTwoSeths(store);
      const contactService = {
        getContact: vi.fn().mockRejectedValue(new Error('pool timeout')),
        findContactByKgNodeId: vi.fn(async () => undefined),
        updateContactFields: vi.fn(),
      };

      const result = await new ExtractFactsHandler().execute(
        makeCtx(
          mem,
          { text: 'Seth lives in Toronto.', source: 'test', subject_contact_id: 'contact-b' },
          makeMockInfraLlm(['yes', SETH_FACT]),
          contactService,
        ),
      );

      expect(result).toEqual({
        success: true,
        data: { stored: 0, redirected: 0, skipped: false, failed: 0, ambiguous: 1 },
      });
    });

    it('never logs the raw subject name on the ambiguous path (PII guard)', async () => {
      // `subject` is an LLM-extracted entity name from a transcript — usually a person's
      // name — and the pino redact list covers senderId/email/phoneNumber, not this.
      // The handler already states the rule for malformed facts ("never the raw values");
      // the ambiguity path has to hold to it too.
      const { mem, store } = makeMemoryWithStore();
      await seedTwoSeths(store);

      const warn = vi.fn();
      const ctx = makeCtx(mem, { text: 'Seth lives in Toronto.', source: 'test' }, makeMockInfraLlm(['yes', SETH_FACT]));
      (ctx as unknown as { log: Record<string, unknown> }).log = {
        warn, info: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn(),
      };

      await new ExtractFactsHandler().execute(ctx);

      const ambiguityWarn = warn.mock.calls.find(c => /ambiguous subject entity/.test(String(c[1])));
      expect(ambiguityWarn).toBeDefined();
      expect(JSON.stringify(ambiguityWarn![0])).not.toContain('Seth Berman');
      // The node ids are the non-PII substitute, and identify the same entities.
      expect(ambiguityWarn![0]).toHaveProperty('candidateIds');
    });

    it('leaves the unambiguous path untouched', async () => {
      const { mem, store } = makeMemoryWithStore();
      const only = await store.createNode({ type: 'person', label: 'Seth Berman', properties: {}, source: 'test' });

      const result = await new ExtractFactsHandler().execute(
        makeCtx(mem, { text: 'Seth lives in Toronto.', source: 'test' }, makeMockInfraLlm(['yes', SETH_FACT])),
      );

      expect(result).toEqual({
        success: true,
        data: { stored: 1, redirected: 0, skipped: false, failed: 0, ambiguous: 0 },
      });
      expect(await mem.getFacts(only.id)).toHaveLength(1);
    });
  });

  // -- PII guard: remaining fact-loop logs (#1706) --
  //
  // The malformed-fact and ambiguity paths already omit the raw subject name.
  // These ten pre-existing call sites still logged it. `subject` is an LLM-extracted
  // entity name (usually a person's name) and the pino redact list does not cover it.
  // Substitute: entityNodeId where a node is resolved; presence flags otherwise.
  // `attribute` is a snake_case key and is kept — it is not identifying on its own.
  describe('fact-loop logs never carry the raw subject name (PII guard)', () => {
    const PII_SUBJECT = 'Priya Ramanathan';

    function spyLog() {
      return {
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        child: vi.fn(),
      };
    }

    function attachSpyLog(ctx: ToolContext) {
      const log = spyLog();
      (ctx as unknown as { log: typeof log }).log = log;
      return log;
    }

    function findCall(fn: ReturnType<typeof vi.fn>, messageRe: RegExp) {
      return fn.mock.calls.find(c => messageRe.test(String(c[c.length - 1])));
    }

    function expectNoRawSubject(call: unknown[] | undefined) {
      expect(call).toBeDefined();
      expect(JSON.stringify(call![0])).not.toContain(PII_SUBJECT);
      expect(call![0]).not.toHaveProperty('subject');
    }

    function factJson(attribute: string, value: string) {
      return JSON.stringify([
        { subject: PII_SUBJECT, subjectType: 'person', attribute, value, confidence: 0.9, decayClass: 'slow_decay' },
      ]);
    }

    function makeContactService(overrides: {
      findContactByKgNodeId?: ReturnType<typeof vi.fn>;
      updateContactFields?: ReturnType<typeof vi.fn>;
    } = {}) {
      return {
        getContact: vi.fn(async () => undefined),
        findContactByKgNodeId: overrides.findContactByKgNodeId ?? vi.fn(async () => ({ id: 'contact-1' })),
        updateContactFields: overrides.updateContactFields ?? vi.fn(async () => ({ id: 'contact-1' })),
      };
    }

    it('canonical-normalization-failed warn', async () => {
      const entityMemory = makeEntityMemory();
      const ctx = makeCtx(
        entityMemory,
        { text: `${PII_SUBJECT} phone is not-a-phone-number.`, source: 'test' },
        makeMockInfraLlm(['yes', factJson('phone', 'not-a-phone-number')]),
        makeContactService(),
      );
      const log = attachSpyLog(ctx);

      await new ExtractFactsHandler().execute(ctx);

      const call = findCall(log.warn, /canonical attribute normalization failed/);
      expectNoRawSubject(call);
      const nodes = await entityMemory.findEntities(PII_SUBJECT);
      expect(call![0]).toHaveProperty('entityNodeId', nodes[0]!.id);
      expect(call![0]).toHaveProperty('attribute', 'phone');
    });

    it('findContactByKgNodeId-failed warn', async () => {
      const entityMemory = makeEntityMemory();
      const ctx = makeCtx(
        entityMemory,
        { text: `${PII_SUBJECT} timezone is America/Toronto.`, source: 'test' },
        makeMockInfraLlm(['yes', factJson('timezone', 'America/Toronto')]),
        makeContactService({
          findContactByKgNodeId: vi.fn().mockRejectedValue(new Error('connection timeout')),
        }),
      );
      const log = attachSpyLog(ctx);

      await new ExtractFactsHandler().execute(ctx);

      const call = findCall(log.warn, /findContactByKgNodeId failed/);
      expectNoRawSubject(call);
      const nodes = await entityMemory.findEntities(PII_SUBJECT);
      expect(call![0]).toHaveProperty('entityNodeId', nodes[0]!.id);
      expect(call![0]).toHaveProperty('attribute', 'timezone');
    });

    it('canonical-redirected info', async () => {
      const entityMemory = makeEntityMemory();
      const ctx = makeCtx(
        entityMemory,
        { text: `${PII_SUBJECT} timezone is America/Toronto.`, source: 'test' },
        makeMockInfraLlm(['yes', factJson('timezone', 'America/Toronto')]),
        makeContactService(),
      );
      const log = attachSpyLog(ctx);

      const result = await new ExtractFactsHandler().execute(ctx);

      expect(result).toEqual({
        success: true,
        data: { stored: 0, redirected: 1, skipped: false, failed: 0, ambiguous: 0 },
      });
      const call = findCall(log.info, /canonical attribute redirected/);
      expectNoRawSubject(call);
      const nodes = await entityMemory.findEntities(PII_SUBJECT);
      expect(call![0]).toHaveProperty('entityNodeId', nodes[0]!.id);
      expect(call![0]).toHaveProperty('attribute', 'timezone');
      expect(call![0]).toHaveProperty('contactId', 'contact-1');
    });

    it('canonical-validation-failed warn', async () => {
      const entityMemory = makeEntityMemory();
      const ctx = makeCtx(
        entityMemory,
        { text: `${PII_SUBJECT} email is priya@example.com.`, source: 'test' },
        makeMockInfraLlm(['yes', factJson('primary_email', 'priya@example.com')]),
        makeContactService({
          updateContactFields: vi.fn().mockRejectedValue(
            new ContactValidationError('primaryEmail not found in contact_channel_identities'),
          ),
        }),
      );
      const log = attachSpyLog(ctx);

      await new ExtractFactsHandler().execute(ctx);

      const call = findCall(log.warn, /canonical attribute validation failed/);
      expectNoRawSubject(call);
      const nodes = await entityMemory.findEntities(PII_SUBJECT);
      expect(call![0]).toHaveProperty('entityNodeId', nodes[0]!.id);
      expect(call![0]).toHaveProperty('attribute', 'primary_email');
      expect(call![0]).toHaveProperty('contactId', 'contact-1');
    });

    it('canonical-redirect unexpected-error', async () => {
      const entityMemory = makeEntityMemory();
      const ctx = makeCtx(
        entityMemory,
        { text: `${PII_SUBJECT} timezone is America/Toronto.`, source: 'test' },
        makeMockInfraLlm(['yes', factJson('timezone', 'America/Toronto')]),
        makeContactService({
          updateContactFields: vi.fn().mockRejectedValue(new Error('pool timeout')),
        }),
      );
      const log = attachSpyLog(ctx);

      const result = await new ExtractFactsHandler().execute(ctx);

      expect(result).toEqual({
        success: true,
        data: { stored: 0, redirected: 0, skipped: false, failed: 1, ambiguous: 0 },
      });
      const call = findCall(log.error, /canonical attribute redirect failed with unexpected error/);
      expectNoRawSubject(call);
      const nodes = await entityMemory.findEntities(PII_SUBJECT);
      expect(call![0]).toHaveProperty('entityNodeId', nodes[0]!.id);
      expect(call![0]).toHaveProperty('attribute', 'timezone');
    });

    it('auto-resolved info', async () => {
      const entityMemory = makeEntityMemory();
      vi.spyOn(entityMemory, 'storeFact').mockResolvedValueOnce({
        stored: true,
        action: 'auto_resolved',
        nodeId: 'fact-1',
      });
      const ctx = makeCtx(
        entityMemory,
        { text: `${PII_SUBJECT} prefers aisle seats.`, source: 'test' },
        makeMockInfraLlm(['yes', factJson('dietary_preference', 'vegetarian')]),
      );
      const log = attachSpyLog(ctx);

      await new ExtractFactsHandler().execute(ctx);

      const call = findCall(log.info, /fact auto-resolved/);
      expectNoRawSubject(call);
      const nodes = await entityMemory.findEntities(PII_SUBJECT);
      expect(call![0]).toHaveProperty('entityNodeId', nodes[0]!.id);
      expect(call![0]).toHaveProperty('attribute', 'dietary_preference');
    });

    it('rate-limited error', async () => {
      const entityMemory = makeEntityMemory();
      vi.spyOn(entityMemory, 'storeFact').mockResolvedValueOnce({
        stored: false,
        action: 'rate_limited',
        conflict: '50-write limit reached',
      });
      const ctx = makeCtx(
        entityMemory,
        { text: `${PII_SUBJECT} prefers aisle seats.`, source: 'test' },
        makeMockInfraLlm(['yes', factJson('dietary_preference', 'vegetarian')]),
      );
      const log = attachSpyLog(ctx);

      await new ExtractFactsHandler().execute(ctx);

      const call = findCall(log.error, /write rate limit exceeded/);
      expectNoRawSubject(call);
      const nodes = await entityMemory.findEntities(PII_SUBJECT);
      expect(call![0]).toHaveProperty('entityNodeId', nodes[0]!.id);
      expect(call![0]).toHaveProperty('attribute', 'dietary_preference');
    });

    it('fact-not-stored warn', async () => {
      const entityMemory = makeEntityMemory();
      vi.spyOn(entityMemory, 'storeFact').mockResolvedValueOnce({
        stored: false,
        action: 'conflict',
        conflict: 'contradicts existing value: London',
      });
      const ctx = makeCtx(
        entityMemory,
        { text: `${PII_SUBJECT} prefers aisle seats.`, source: 'test' },
        makeMockInfraLlm(['yes', factJson('dietary_preference', 'vegetarian')]),
      );
      const log = attachSpyLog(ctx);

      await new ExtractFactsHandler().execute(ctx);

      const call = findCall(log.warn, /fact not stored/);
      expectNoRawSubject(call);
      const nodes = await entityMemory.findEntities(PII_SUBJECT);
      expect(call![0]).toHaveProperty('entityNodeId', nodes[0]!.id);
      expect(call![0]).toHaveProperty('attribute', 'dietary_preference');
    });

    it('programming-error in fact loop', async () => {
      const entityMemory = makeEntityMemory();
      vi.spyOn(entityMemory, 'storeFact').mockRejectedValueOnce(
        new TypeError("Cannot read properties of undefined (reading 'id')"),
      );
      const ctx = makeCtx(
        entityMemory,
        { text: `${PII_SUBJECT} prefers aisle seats.`, source: 'test' },
        makeMockInfraLlm(['yes', factJson('dietary_preference', 'vegetarian')]),
      );
      const log = attachSpyLog(ctx);

      await new ExtractFactsHandler().execute(ctx);

      const call = findCall(log.error, /unexpected programming error in fact loop/);
      expectNoRawSubject(call);
      const nodes = await entityMemory.findEntities(PII_SUBJECT);
      expect(call![0]).toHaveProperty('entityNodeId', nodes[0]!.id);
      expect(call![0]).toHaveProperty('hasSubject', true);
      expect(call![0]).toHaveProperty('attribute', 'dietary_preference');
    });

    it('failed-to-persist error', async () => {
      const entityMemory = makeEntityMemory();
      vi.spyOn(entityMemory, 'storeFact').mockRejectedValueOnce(new Error('DB connection lost'));
      const ctx = makeCtx(
        entityMemory,
        { text: `${PII_SUBJECT} prefers aisle seats.`, source: 'test' },
        makeMockInfraLlm(['yes', factJson('dietary_preference', 'vegetarian')]),
      );
      const log = attachSpyLog(ctx);

      await new ExtractFactsHandler().execute(ctx);

      const call = findCall(log.error, /failed to persist fact/);
      expectNoRawSubject(call);
      const nodes = await entityMemory.findEntities(PII_SUBJECT);
      expect(call![0]).toHaveProperty('entityNodeId', nodes[0]!.id);
      expect(call![0]).toHaveProperty('hasSubject', true);
      expect(call![0]).toHaveProperty('attribute', 'dietary_preference');
    });
  });
});
