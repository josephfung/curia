# Bundled Embedding Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `all-MiniLM-L6-v2` in the Curia image, running in-process, so the knowledge graph works with only an Anthropic key, without moving any existing install off the model it uses.

**Architecture:**
- **Resolution** becomes "no `EMBEDDING_BASE_URL` → bundled in-process model; a base URL → that server". OpenAI is an ordinary endpoint, apart from one deprecated compatibility rule that keys on stored OpenAI vectors.
- **The bundled backend** is `onnxruntime-node` plus `@huggingface/tokenizers`, with mean pooling in Curia. Its weights are pinned by revision and sha256, fetched at build time, and stamped with a weights hash.
- **Model-independent fixes:** an identifier guard, a `knowledge_graph` health check, and endpoint drift probes.

**Tech Stack:** TypeScript (ESM, Node 26), `onnxruntime-node` 1.30.0, `@huggingface/tokenizers` 0.2.x, PostgreSQL + pgvector, Vitest, Docker, pnpm 11.

**Spec:** `docs/wip/2026-11-15-bundled-embedder-design.md` (read it first; this plan argues from it).

## Global Constraints

- Bundled model: `Xenova/all-MiniLM-L6-v2`, revision `751bff37182d3f1213fa05d7196b954e230abad9`. Files and sha256:
  - `onnx/model_quantized.onnx`: 22,972,370 bytes, `afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1`
  - `tokenizer.json`: 711,661 bytes, `da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0`
  - `tokenizer_config.json`: 366 bytes, `9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3`
- ONNX graph: inputs `input_ids`, `attention_mask`, `token_type_ids` (int64, shape `[1, n]`); output `last_hidden_state` `[1, n, 384]`. Mean-pool over `attention_mask`, then L2-normalise. Truncate to **256** tokens, keeping the final `[SEP]`. (Verified against the transformers.js pipeline: cosine 1.000000 on four strings, including a truncated one.)
- Profile name `all-MiniLM-L6-v2`; dimensions 384; all prefixes `''`; pooling `mean`.
- Session options: `intraOpNumThreads: 1`, `interOpNumThreads: 1`, CPU provider.
- **No network call on the bundled path at runtime or first boot.** There is no code path from a missing file to a download.
- Default weights dir: `path.resolve(process.cwd(), 'models/embedding/all-MiniLM-L6-v2')`; override with `EMBEDDING_MODEL_DIR`. `models/embedding/manifest.json` is committed; the weight files are gitignored.
- `onnxruntime-node` is CommonJS: `import ort from 'onnxruntime-node'` (default import, CLAUDE.md #2410).
- `allowBuilds: onnxruntime-node: false` stays. Its postinstall only fetches CUDA providers.
- pnpm `minimumReleaseAge: 1440` applies to the new dependencies.
- No `console.log` in `src/`/`tests/`; no `any`; no empty `catch {}`; parameterised SQL only.
- Budgets: Curia RSS growth ≤ ~100 MB on the default path; image growth ~70 MB.
- curia is public: commits, PRs, fixtures and ADRs carry no labels, names or numbers from the maintainer's private evaluation set (counts and scores only).

## Review Focus

1. **A database with vectors from a non-OpenAI model and no `EMBEDDING_BASE_URL`** (configuration lost). The knowledge graph must stay off and name the stored model, never switch to bundled. Test in Task 4.
2. **`EMBEDDING_MODEL_DIR` pointing at a different export of the same model.** The stamp must carry the loaded file's hash and boot must warn, so its vectors never pass as the shipped weights. Test in Task 3.
3. **A label with an identifier only on one side** (`tax: $1,204.50` vs `tax: $1,204.50 (no change since 2030)`). The guard must allow the merge (subset rule). Test in Task 1.
4. **Concurrent `embed()` calls on the bundled backend** (two agent turns writing facts at once). They must serialise and both resolve correctly. Test in Task 3.
5. **An endpoint unreachable at boot** (Ollama started after Curia). The knowledge graph stays on and health reports `drift_unchecked`; boot doesn't wait more than the probe timeout. Test in Task 7.

---

### Task 1: Identifier guard

**Files:**
- Create: `src/memory/identifier-guard.ts`
- Modify: `src/memory/entity-memory.ts` (fuzzy phase, ~L409-465), `src/memory/validation.ts` (dedup loop, ~L180-200)
- Test: `tests/unit/memory/identifier-guard.test.ts`; extend `tests/unit/memory/entity-memory.resolve-or-create.test.ts` and the validation unit test

**Interfaces:**
- Produces: `extractIdentifierTokens(label: string): Set<string>` and `hasConflictingIdentifiers(a: string, b: string): boolean` (true when both sets are non-empty and neither is a subset of the other).

- [ ] **Step 1: Write the failing unit tests** in `identifier-guard.test.ts`:
  - `extractIdentifierTokens('Order #418-5530217-6094412')` contains `'41855302176094412'` (separators inside a number removed).
  - `extractIdentifierTokens('(905) 555-0176')` equals `extractIdentifierTokens('905-555-0176')`.
  - `extractIdentifierTokens('Message ID 7c2e90af41b3d586')` contains `'7c2e90af41b3d586'` (alphanumeric ≥8 with a digit, lower-cased).
  - `extractIdentifierTokens('Robert Lindqvist')` is empty; `extractIdentifierTokens('Q3 board meeting')` is empty (runs shorter than 4 digits don't count).
  - `hasConflictingIdentifiers('Order #418-5530217-6094412', 'Order #418-5530217-6094512')` → `true`.
  - `hasConflictingIdentifiers('tax: $1,204.50', 'tax: $1,204.50 (no change since 2030)')` → `false`.
  - `hasConflictingIdentifiers('cell_phone: 226-555-0193', 'phone: 226-555-0193')` → `false`.
  - `hasConflictingIdentifiers('start_time: 2031-08-09T14:15:00', 'end_time: 2031-08-09T16:45:00')` → `true`.
  - `hasConflictingIdentifiers('Acme Corp', 'Acme Corporation')` → `false` (no identifiers).

  All strings are invented. None comes from the private set.
- [ ] **Step 2: Run** `pnpm -C <worktree> exec vitest run tests/unit/memory/identifier-guard.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `identifier-guard.ts`.** Tokens are:
  - digit runs ≥4 after deleting `-`, `.`, `,`, spaces, `(`, `)` between digits;
  - `[a-z0-9]{8,}` runs containing a digit, after lower-casing.

  Comment why a subset counts as compatible.
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Write failing wiring tests.**
  - Fuzzy: in `resolveOrCreate`, a candidate scoring above `fuzzyResolve` whose label conflicts on identifiers is **not** auto-resolved and **not** returned as ambiguous. The result is `created`.
  - Dedup: in `MemoryValidator.validate`, a connected fact above `factDedup` with conflicting identifiers is not merged; a non-conflicting one still is.
- [ ] **Step 6: Wire the guard.**
  - Fuzzy phase: filter `fuzzyResults` with `!hasConflictingIdentifiers(options.label, r.node.label)` before partitioning.
  - Dedup loop: `continue` beside `isDistinctMultiValuedFact`.
- [ ] **Step 7: Run** the memory unit tests: `pnpm -C <worktree> exec vitest run tests/unit/memory`. Expected: PASS.
- [ ] **Step 8: Commit** `feat(memory): identifier guard for fuzzy resolve and fact dedup (#2023)`.

### Task 2: Weights manifest and fetch script

**Files:**
- Create: `models/embedding/manifest.json`, `scripts/fetch-embedder.ts`
- Modify: `.gitignore` (ignore `models/embedding/*/`), `package.json` (`"fetch:embedder": "tsx scripts/fetch-embedder.ts"`)
- Test: `scripts/fetch-embedder.test.ts`

**Interfaces:**
- Produces:
  - `interface EmbedderManifest { model: string; repo: string; revision: string; files: Array<{ path: string; dest: string; bytes: number; sha256: string }> }`
  - `loadEmbedderManifest(file?: string): EmbedderManifest`
  - `verifyEmbedderFiles(dir: string, manifest: EmbedderManifest): Promise<{ ok: true } | { ok: false; problems: string[] }>`
  - CLI: `pnpm fetch:embedder [--dir <path>]`. It downloads each file from `https://huggingface.co/<repo>/resolve/<revision>/<path>` into `<dir>/<dest>` and verifies size and sha256. It exits 1 on any mismatch and deletes the bad file. If the files already verify, it does nothing and exits 0.

- [ ] **Step 1: Write the failing tests:**
  - the manifest parses and holds the three Global Constraints entries;
  - `verifyEmbedderFiles` returns `ok:false` naming the file when a byte is flipped;
  - it returns `ok:true` for matching files (use a tmp dir and a synthetic manifest with tiny files).
- [ ] **Step 2: Run** `pnpm -C <worktree> exec vitest run scripts/fetch-embedder.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write `manifest.json`** with the Global Constraints values. `dest`: `model_quantized.onnx`, `tokenizer.json`, `tokenizer_config.json` under `all-MiniLM-L6-v2/`.
- [ ] **Step 4: Implement `fetch-embedder.ts`.** Stream to a temp file, hash while streaming, rename on success. This is the only file in the repo that downloads weights.
- [ ] **Step 5: Run the tests, then the real fetch:** `pnpm -C <worktree> fetch:embedder`. Expected: three files present; a second run prints "already verified".
- [ ] **Step 6: Add `pnpm fetch:embedder`** before "Run tests" in `.github/workflows/ci.yml`. Cache `models/embedding` with `actions/cache`, keyed on `hashFiles('models/embedding/manifest.json')`.
- [ ] **Step 7: Commit** `feat(memory): pinned bundled-embedder manifest and fetch script (#2023)`.

### Task 3: Bundled profile, weights-hashed stamp, ONNX backend

**Files:**
- Create: `src/memory/embedding-onnx.ts`
- Modify: `src/memory/embedding-profiles.ts`, `src/memory/embedding.ts`, `package.json` (deps `onnxruntime-node@1.30.0`, `@huggingface/tokenizers@^0.2.0`)
- Test: `tests/unit/memory/embedding-profiles.test.ts` (extend), `tests/unit/memory/embedding-onnx.test.ts`, `tests/integration/embedding-onnx-golden.test.ts`, `tests/fixtures/embedding-golden/minilm-l6.json`

**Interfaces:**
- Consumes: Task 2 `loadEmbedderManifest`, `verifyEmbedderFiles`.
- Produces:
  - `EmbeddingProfile` gains `pooling?: 'mean' | 'cls' | 'last_token'` and `weightsSha256?: string`.
  - `ALL_MINILM_L6_V2: EmbeddingProfile`. Thresholds start at `{ factDedup: 0.95, fuzzyResolve: 0.92, fuzzyAmbiguityFloor: 0.61 }`, marked `TODO(#2023): replaced by calibration in Task 8`. It's added to `BUILTIN_EMBEDDING_PROFILES`.
  - `BUNDLED_EMBEDDING_MODEL = 'all-MiniLM-L6-v2'`.
  - `embeddingStamp(profile)` appends `#weights:<first 12 hex of weightsSha256>` when `weightsSha256` is set. Existing stamps are unchanged.
  - `parseEmbeddingProfiles` carries `base.pooling`, and rejects `pooling`/`weightsSha256` keys from YAML (unknown-key error).
  - `hashBundledWeights(modelDir: string, logger: Logger): Promise<string>`: sha256 of `model_quantized.onnx`. Warns if it differs from the manifest; never throws on a mismatch, throws only if the file is missing.
  - `EmbeddingService.createBundled(modelDir: string, profile: EmbeddingProfile, logger: Logger, bus?: EventBus, modelRegistry?: ModelRegistry): Promise<EmbeddingService>`. It requires `profile.weightsSha256`, recomputes the hash, and throws if they differ. It loads the session and tokenizer eagerly.
  - `type EmbeddingSource = { kind: 'endpoint'; endpoint: EmbeddingEndpoint } | { kind: 'bundled'; modelDir: string }`
  - `EmbeddingService.create(source: EmbeddingSource, profile, logger, bus?, modelRegistry?): Promise<EmbeddingService>` dispatches to `createWithEndpoint` / `createBundled`.

- [ ] **Step 1: Write failing profile tests:**
  - `embeddingStamp({...ALL_MINILM_L6_V2, weightsSha256: 'afdb6f1a0e45b715...'})` → `'all-MiniLM-L6-v2#weights:afdb6f1a0e45'`;
  - `embeddingStamp(OPENAI_TEXT_EMBEDDING_3_SMALL)` → `'text-embedding-3-small'` (unchanged);
  - a YAML override `{ base: 'all-MiniLM-L6-v2', thresholds: { fact_dedup: 0.9 } }` keeps `pooling: 'mean'`;
  - a YAML `pooling:` key is rejected.
- [ ] **Step 2: Run them.** Expected: FAIL. **Step 3: Implement** the profile changes. **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Add the dependencies** with `pnpm -C <worktree> add onnxruntime-node@1.30.0 @huggingface/tokenizers@^0.2.0`. Confirm `pnpm-workspace.yaml` `allowBuilds` is unchanged; commit `package.json` and `pnpm-lock.yaml` together.
- [ ] **Step 6: Write failing backend unit tests** (`embedding-onnx.test.ts`), with weights present via Task 2. Use `describe.skipIf(!weightsPresent && !process.env.CI)`, and in CI fail loudly if they're missing:
  - `embed('Robert Lindqvist')` returns 384 numbers with norm 1 ± 1e-6;
  - an input of 2,000 `'x'` characters returns 384 numbers (truncation path);
  - **Review Focus 4:** `Promise.all` of 20 `embed()` calls returns 20 vectors, each equal to its sequential result;
  - **Review Focus 2:** `createBundled` with a profile whose `weightsSha256` differs from the file throws, and `hashBundledWeights` on a copied, modified file returns the new hash and logs a manifest-mismatch warning;
  - a missing model dir throws an error whose message names `pnpm fetch:embedder`.
- [ ] **Step 7: Implement `embedding-onnx.ts`.** Follow the Global Constraints exactly (inputs, pooling, truncation keeping the last id, thread options). A promise-chain queue serialises `run()`. `embedding.call` telemetry carries `estimatedCostUsd: 0`, and failures publish `embedding.error`, matching `HttpEmbeddingBackend`. Tokenizer: `new Tokenizer(tokenizerJson, tokenizerConfig)`, then `encode(text)`.
- [ ] **Step 8: Golden vectors.**
  - Generate `tests/fixtures/embedding-golden/minilm-l6.json` with a throwaway transformers.js script outside the repo (`pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' })`, mean pooling, normalised). The strings are `["Robert Lindqvist", "Prefers morning meetings", "phone_number: 416-555-0182"]` and the fixture stores full vectors.
  - The integration test asserts cosine ≥ 0.9999 per string.
- [ ] **Step 9: Run** `pnpm -C <worktree> exec vitest run tests/unit/memory tests/integration/embedding-onnx-golden.test.ts`. Expected: PASS.
- [ ] **Step 10: Run** `pnpm -C <worktree> exec tsup src/index.ts --format esm --no-dts` then `pnpm -C <worktree> run check:dist-imports`. Expected: PASS.
- [ ] **Step 11: Commit** `feat(memory): in-process ONNX embedding backend with bundled MiniLM profile (#2023)`.

### Task 4: Resolution rework and call sites

**Files:**
- Modify: `src/memory/embedding.ts` (`resolveEmbedding`, reasons, `describeEmbeddingUnavailable`), `src/memory/embedding-schema.ts` (`resolveKnowledgeGraphEmbedding`), `src/config.ts` (`embeddingModelDir`), `src/index.ts` (~L705-768), `src/startup/test-mode-stack.ts` (~L1261), `scripts/dedup-contacts.ts` (~L718-746), `scripts/reembed-kg.ts`
- Test: `tests/unit/memory/embedding.test.ts` (extend), `tests/integration/knowledge-graph-bundled.test.ts`

**Interfaces:**
- Consumes: Task 3 `EmbeddingSource`, `EmbeddingService.create`, `hashBundledWeights`, `BUNDLED_EMBEDDING_MODEL`.
- Produces:
  - `interface StoredEmbeddingState { stamps: string[]; openRunTarget?: string }`
  - `storedStateFromSnapshot(s: EmbeddingSchemaSnapshot): StoredEmbeddingState`
  - `stampModel(stamp: string): string` (the part before the first `#`)
  - `resolveEmbedding(config, profileOverrides, stored: StoredEmbeddingState): EmbeddingResolution`
  - `EmbeddingResolution`:
    - `| { ok: true; source: EmbeddingSource; profile: EmbeddingProfile; deprecation?: 'implicit_openai' }`
    - `| { ok: false; reason: 'no_model' }`
    - `| { ok: false; reason: 'no_profile'; model: string }`
    - `| { ok: false; reason: 'non_bundled_model_without_base_url'; model: string }`
    - `| { ok: false; reason: 'stored_model_without_endpoint'; storedModel: string }`
    - `| { ok: false; reason: 'implicit_openai_without_key' }`
  - `KnowledgeGraphEmbedding`'s ok branch becomes `{ ok: true; source: EmbeddingSource; profile: EmbeddingProfile; deprecation?: 'implicit_openai' }`. For bundled sources the profile already carries `weightsSha256`.
  - A new failure `{ ok: false; gate: 'bundled'; message: string; reason: 'bundled_weights_missing' }`.
  - `Config.embeddingModelDir: string` (from `EMBEDDING_MODEL_DIR`, else the default).

- [ ] **Step 1: Write failing unit tests**, one per branch of design §1, with `resolveEmbedding` pure over `StoredEmbeddingState`:
  - base URL + model → endpoint, `embeddingApiKey`;
  - base URL + OpenAI URL + `text-embedding-3-small` → endpoint; `openaiApiKey` is **not** used;
  - base URL without model → `no_model`;
  - nothing set, empty stored → bundled, profile `all-MiniLM-L6-v2`;
  - nothing set, an OpenAI key present, empty stored → **bundled** (the key alone never selects OpenAI);
  - nothing set, stored `['text-embedding-3-small']`, key → endpoint `https://api.openai.com/v1` with `openaiApiKey`, `deprecation: 'implicit_openai'`;
  - `EMBEDDING_MODEL=text-embedding-3-small`, no base URL, stored OpenAI, key → same compatibility result;
  - nothing set, stored `['text-embedding-3-small']`, no key → `implicit_openai_without_key`;
  - nothing set, `openRunTarget: 'text-embedding-3-small'`, `stamps: []`, key → compatibility (OpenAI);
  - **Review Focus 1:** nothing set, stored `['Qwen3-Embedding-4B']` → `stored_model_without_endpoint`, `storedModel: 'Qwen3-Embedding-4B'`;
  - `EMBEDDING_MODEL=all-MiniLM-L6-v2`, stored `['text-embedding-3-small']` → bundled (the switch signal);
  - `EMBEDDING_MODEL=nomic-embed-text`, no base URL → `non_bundled_model_without_base_url`;
  - stored `['all-MiniLM-L6-v2#weights:afdb6f1a0e45']` → bundled;
  - base URL + `EMBEDDING_MODEL=all-MiniLM-L6-v2` (MiniLM served by Ollama) → endpoint with the MiniLM profile's thresholds and pooling, and **no** `weightsSha256`, so its stamp is the bare model name (design §3).
- [ ] **Step 2: Run them.** Expected: FAIL. **Step 3: Implement** `resolveEmbedding` and the reason texts. Each `describeEmbeddingUnavailable` message names the fix:
  - `stored_model_without_endpoint`: "restore EMBEDDING_BASE_URL/EMBEDDING_MODEL for <model>, or set EMBEDDING_MODEL=all-MiniLM-L6-v2 and run pnpm reembed:kg";
  - `non_bundled_model_without_base_url`: "a non-bundled model needs EMBEDDING_BASE_URL";
  - `implicit_openai_without_key`: names `openai_api_key` and the explicit-endpoint alternative.

  Put `// TODO(#<phase-out issue>): remove the implicit OpenAI compatibility rule` at the rule; the issue number is filled in Task 10.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Rework `resolveKnowledgeGraphEmbedding`:**
  - order: read the snapshot → `resolveEmbedding(..., storedStateFromSnapshot(snapshot))` → for bundled, `hashBundledWeights` and set `profile.weightsSha256` → lock-holder check → `checkEmbeddingSchema`;
  - a missing weights file → `gate: 'bundled'`;
  - a `deprecation` → one `logger.warn` naming both ways forward (design §1).
- [ ] **Step 6: Update the four call sites** to `await EmbeddingService.create(result.source, result.profile, logger, bus, modelRegistry)`.
  - `index.ts` logs `embeddingSource: 'bundled' | 'endpoint'` (redacted URL for endpoints) in "Entity memory initialized", and updates the comment at L711 that says the vault's `openai_api_key` is required.
  - `reembed-kg.ts` opens the pool and reads the snapshot **before** resolving (it needs the stored state).
- [ ] **Step 7: Write failing integration tests** (`knowledge-graph-bundled.test.ts`, real Postgres via `scratch-database.ts`), driving `resolveKnowledgeGraphEmbedding` plus `EmbeddingService.create`:
  - fresh database, no embedding config → ok, bundled, column resized to 384; `memory-store` then `memory-query` round-trips through `EntityMemory`;
  - database with rows stamped `text-embedding-3-small`, no config, `openaiApiKey` set → ok, endpoint OpenAI, `deprecation` (endpoint not called: use the fake backend for the endpoint path via the existing test seam);
  - same database with explicit OpenAI config → ok, no deprecation, no re-embed needed;
  - database with rows stamped `Qwen3-Embedding-4B`, no config → `gate: 'config'`, message names `Qwen3-Embedding-4B`;
  - database with OpenAI rows + `EMBEDDING_MODEL=all-MiniLM-L6-v2` → `gate: 'schema'`, `model_mismatch`; after `reembedKnowledgeGraph` → ok.
- [ ] **Step 8: Run** `pnpm -C <worktree> exec vitest run tests/unit/memory tests/integration/knowledge-graph-bundled.test.ts tests/integration/reembed-kg.test.ts tests/integration/agent-bootstrap.test.ts`. Expected: PASS.
- [ ] **Step 9: Run** `pnpm -C <worktree> run typecheck`. Expected: clean. **Commit** `feat(memory): bundled model is the default embedding source; OpenAI is an ordinary endpoint (#2023)`.

### Task 5: `/api/health` `knowledge_graph` check

**Files:**
- Create: `src/memory/kg-health.ts`
- Modify: `src/health/types.ts`, `src/health/health-service.ts` (`getStatus` ~L233-290, `aggregateStatus` ~L621), `src/index.ts` (wire)
- Test: `tests/unit/health/health-service.test.ts` (extend), `tests/unit/memory/kg-health.test.ts`

**Interfaces:**
- Consumes: Task 4 resolution results.
- Produces:
  - `type KnowledgeGraphReason = 'no_model' | 'no_profile' | 'non_bundled_model_without_base_url' | 'stored_model_without_endpoint' | 'implicit_openai_without_key' | 'bundled_weights_missing' | 'width_mismatch' | 'model_mismatch' | 'reembed_in_progress' | 'schema_check_failed' | 'weights_changed' | 'implicit_openai_deprecated' | 'drift_unchecked' | 'weights_shifted'`
  - `class KnowledgeGraphHealth { set(result: 'ok' | 'fail', reason?: KnowledgeGraphReason): void; get(): { result: CheckResult; reason?: KnowledgeGraphReason } }`
  - `knowledgeGraphReasonFrom(kg: KnowledgeGraphEmbedding): { result: 'ok' | 'fail'; reason?: KnowledgeGraphReason }`
  - `HealthResponse.checks.knowledge_graph: CheckResult` and `HealthResponse.details?: { knowledge_graph?: KnowledgeGraphReason }`
  - A `HealthService` option `knowledgeGraphHealth?: KnowledgeGraphHealth` (absent → `'skipped'`, for setup-mode boots).

- [ ] **Step 1: Write failing tests:**
  - `knowledgeGraphReasonFrom` maps each failure gate and state to its reason. `open_run` and the lock holder both map to `reembed_in_progress`; a deprecation maps to `ok` + `implicit_openai_deprecated`.
  - `getStatus()` includes `checks.knowledge_graph`; `fail` makes the overall status `degraded`, never `down`; `details.knowledge_graph` carries the reason; `ok` with a reason keeps the status `ok`.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** Add `checks.knowledge_graph` to `aggregateStatus`'s non-critical list. Comment, as for `signal_voice`, that the additions are additive to a public surface. **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Wire it in `index.ts`:** create one `KnowledgeGraphHealth`, `set` it from the boot resolution, pass it to `HealthService`.
- [ ] **Step 6: Commit** `feat(health): knowledge_graph check says why entity memory is off (#2023)`.

### Task 6: `pnpm reembed:kg --force`

**Files:**
- Modify: `src/memory/reembed.ts` (`ReembedOptions`, `openRunAndClear`), `scripts/reembed-kg.ts`
- Test: `tests/integration/reembed-kg.test.ts` (extend)

**Interfaces:**
- Produces: `ReembedOptions.force?: boolean`. When set, every vector is cleared and re-embedded even if its stamp matches, via the same path `widthChanges` uses. CLI flag `--force`, shown in the header comment and `--dry-run` output.

- [ ] **Step 1: Write a failing test.** A database whose rows already carry the configured stamp: without `force`, `rowsEmbedded` is 0; with `force`, it equals the row count, and every vector is rewritten (assert `embedding_model` set and an open-run row finished).
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(memory): reembed:kg --force re-embeds every row (#2023)`.

### Task 7: Endpoint drift check (stored vectors as the baseline)

**Why:** for an endpoint, the stamp proves only the model *name*. If the server starts serving different weights under that name (a re-pulled Ollama tag with another quantisation, a swapped llama.cpp file), new vectors get compared with old ones from different weights, silently. The stored vectors in `kg_nodes` are already the baseline: re-embed a few of their labels and compare. **No migration, no new table, no baseline to record** (maintainer-approved over a baseline table). The bundled path doesn't need this; its stamp carries the weights hash.

**Files:**
- Create: `src/memory/embedding-drift.ts`
- Modify: `src/memory/embedding-schema.ts` (`resolveKnowledgeGraphEmbedding`: run the check for endpoint sources), `src/health/health-service.ts` (the embeddings canary re-runs the check), `src/memory/kg-health.ts` (reason mapping), `src/index.ts`, `src/startup/test-mode-stack.ts`, `scripts/dedup-contacts.ts` (use `result.service`)
- Test: `tests/unit/memory/embedding-drift.test.ts`, `tests/integration/embedding-drift.test.ts`

**Interfaces:**
- Consumes: Task 3 `EmbeddingService`, `embeddingStamp`; Task 5 `KnowledgeGraphHealth`, `knowledgeGraphReasonFrom`; Task 6 `reembed:kg --force` (the recovery path).
- Produces:
  - `DRIFT_SAMPLE_SIZE = 5`; `DRIFT_SAME_MIN = 0.995` (lowered from a planned 0.999 to tolerate hosted/GPU nondeterminism, ruling R13); `DRIFT_SHIFT_FLOOR = 0.9` (set in Step 1); `DRIFT_TIMEOUT_MS = 5000`.
  - `type DriftOutcome = 'same' | 'shifted' | 'changed' | 'unchecked'`
  - `sampleStoredLabels(pool: DbPool, stamp: string, n = DRIFT_SAMPLE_SIZE): Promise<Array<{ label: string; embedding: number[] }>>`: rows `WHERE embedding_model = $1 AND embedding IS NOT NULL ORDER BY id LIMIT $2` (parameterised, deterministic).
  - `checkEmbeddingDrift(pool: DbPool, service: EmbeddingService, logger: Logger, timeoutMs = DRIFT_TIMEOUT_MS): Promise<DriftOutcome>`:
    - re-embeds each sampled label with `service.embed(label, 'document')` and takes the **minimum** cosine against the stored vectors;
    - no sampled rows → `same` (nothing to protect);
    - any embed error, or the whole check exceeding `timeoutMs` → `unchecked`.
  - `KnowledgeGraphEmbedding` gains `{ ok: false; gate: 'drift'; message: string; reason: 'weights_changed' }`; its ok branch gains `drift?: 'shifted' | 'unchecked'` and `service?: EmbeddingService`.
  - For endpoint sources, `resolveKnowledgeGraphEmbedding` builds the service, runs the check after the schema gate passes, and returns the built service. Call sites use `result.service` when present instead of building a second one.
  - `knowledgeGraphReasonFrom` maps `gate: 'drift'` → `fail`/`weights_changed`, `drift: 'shifted'` → `ok`/`weights_shifted`, and `drift: 'unchecked'` → `ok`/`drift_unchecked`.

- [ ] **Step 1: Measure the floor.** Using the evaluation spike (maintainer-provided path), embed ~20 invented short labels and take the minimum cosine between:
  - (a) the q8 and fp32 exports of the same model, for MiniLM-L6, nomic-v1.5 and EmbeddingGemma 2;
  - (b) two different 768-dim models (granite-r2 vs nomic-v1.5).

  Set `DRIFT_SHIFT_FLOOR` between the smallest (a) and the largest (b), and record both numbers in the ADR (Task 10). If same-weights noise dips below `DRIFT_SAME_MIN` (0.995) for some model, lower it to just under that noise, and record that too.
- [ ] **Step 2: Write failing unit tests.** Use a fake service whose output for a label is the stored vector plus a controllable perturbation, and stub `sampleStoredLabels` rows:
  - identical vectors → `same`;
  - perturbation giving min cosine between `DRIFT_SHIFT_FLOOR` and `DRIFT_SAME_MIN` → `shifted`;
  - unrelated vectors → `changed`;
  - zero sampled rows → `same`;
  - the service throws on one label → `unchecked`;
  - **Review Focus 5:** a service that never resolves → `unchecked`, resolving within `timeoutMs` + 100 ms (fake timers).
- [ ] **Step 3: Run** `pnpm -C <worktree> exec vitest run tests/unit/memory/embedding-drift.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement `embedding-drift.ts`.**
- [ ] **Step 5: Run.** Expected: PASS.
- [ ] **Step 6: Wire it** (design §7 failure cases):
  - **boot, endpoint sources only** (OpenAI included): `changed` → `gate: 'drift'`, knowledge graph off; `shifted` and `unchecked` → ok with `drift` set;
  - **the embeddings canary re-runs the check** when the source is an endpoint: `changed` → canary `fail` and `KnowledgeGraphHealth.set('fail', 'weights_changed')`, plus an error log naming `pnpm reembed:kg --force`. There's no runtime shutdown. `shifted` and `unchecked` → set the matching ok reason; `same` clears a previous `drift_unchecked`.
- [ ] **Step 7: Write the integration test** (real Postgres, fake endpoint service):
  - seed rows stamped with the endpoint's model; a matching service → ok, no `drift`;
  - perturb the service beyond the floor → `gate: 'drift'`, `weights_changed`;
  - run `reembedKnowledgeGraph({ force: true })` with the perturbed service → the next resolution is ok (the stored vectors now match the current weights, with no baseline step).

  **Run** `pnpm -C <worktree> exec vitest run tests/integration/embedding-drift.test.ts tests/integration/knowledge-graph-bundled.test.ts`. Expected: PASS.
- [ ] **Step 8: Commit** `feat(memory): detect weight changes behind an endpoint model name (#2023)`.

### Task 8: Harness in-process mode, anonymised fixture, calibration

**Files:**
- Modify: `scripts/embedding-eval.ts` (`EvalArgs`, `parseArgs`, `main`, `evaluate`), `scripts/embedding-eval.test.ts`, `src/memory/embedding-profiles.ts` (thresholds)
- Create: `tests/fixtures/embedding-eval/fixture-structured.json`

**Interfaces:**
- Consumes: Task 1 `hasConflictingIdentifiers`; Task 3 `EmbeddingService.createBundled`, `hashBundledWeights`.
- Produces:
  - `EvalArgs.bundled: boolean`. With `--bundled`, `--base-url`/`--model` aren't required and the default model dir is used (or `--model-dir`).
  - `EvalArgs.identifierGuard: boolean` (`--identifier-guard`). Pairs the guard blocks are dropped from the pair tasks before thresholds are chosen, and the report prints how many it dropped per class.

- [ ] **Step 1: Write failing tests** for `parseArgs`:
  - `--bundled` with no base URL parses;
  - `--bundled --base-url x` is rejected;
  - `--identifier-guard` sets the flag.

  Also: `evaluate` with the guard on drops a fixture pair whose identifiers conflict.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Write `fixture-structured.json`**, every string invented, in the existing fixture schema:
  - ≥20 `attribute: value` fact merge pairs (same value, synonym attributes);
  - ≥20 distinct pairs (`current_`/`former_`, `known_email_1`/`_2` with different values, start/end times, tax vs total amounts);
  - ≥10 ID-like entity distinct pairs (order numbers or message IDs differing by one or two characters);
  - ≥15 name-variant match pairs (initials, dropped middle name, `Last, First`, a bare first name);
  - ≥10 keyword-style search queries over a ≥60-label corpus.
- [ ] **Step 6: Calibrate on the private set** (maintainer-provided; convert it to the fixture schema outside the repo):
  - run `pnpm -C <worktree> embedding-eval --bundled --identifier-guard --fixture <private-fixture.json>`;
  - set `ALL_MINILM_L6_V2.thresholds`: `factDedup` and `fuzzyResolve` to the harness's lowest no-wrong-merge values, `fuzzyAmbiguityFloor` to the 95%-keep floor (ADR-051's policy);
  - remove the Task 3 TODO; the code comment cites the run (date, counts, ROC-AUC). No private strings anywhere.
- [ ] **Step 7: Check the guard's acceptance** on the private set: every ID-like "different" pair is blocked, and zero "same" pairs are blocked (report counts in the PR, not pairs). If a "same" pair is blocked, refine the Task 1 rule and add an invented equivalent to its tests.
- [ ] **Step 8: Run** `pnpm -C <worktree> embedding-eval --bundled --identifier-guard` (committed fixtures). Expected: runs clean; record the numbers for the ADR. **Commit** `feat(memory): calibrate bundled profile; structured eval fixture; harness bundled mode (#2023)`.

### Task 9: Docker: weights in the image, platform pruning, egress check

**Files:**
- Modify: `Dockerfile` (build stage: fetch; runtime stage: copy weights, prune in the install `RUN`, build-time load check), `.dockerignore` if needed
- Create: `scripts/bundled-embedder-smoke.ts`, `tests/docker/test-bundled-embedder-egress.sh`
- Modify: `.github/workflows/ci.yml` (run the egress script after the image build step)

**Interfaces:**
- Consumes: Task 2 `fetch:embedder`; Task 3 `EmbeddingService.createBundled`; Task 4 resolution.
- Produces:
  - `scripts/bundled-embedder-smoke.ts`: with `DATABASE_URL`, it resolves through `resolveKnowledgeGraphEmbedding` with no embedding config, stores one fact through `EntityMemory`, queries it back, exits 0 on success, and prints the source and RSS.

- [ ] **Step 1: Build stage:** `RUN pnpm fetch:embedder` (verifies sha256; a mismatch fails the build).
- [ ] **Step 2: Runtime stage:** `COPY --from=build /app/models/embedding ./models/embedding` (manifest plus weights).
- [ ] **Step 3: Prune other platforms in the same `RUN` as `pnpm install --frozen-lockfile --prod`.**
  - For every file under `node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v*/` that isn't the image's `linux/<TARGETARCH>` (map Docker's `amd64` to `x64`), delete each of its hardlinks with `find /root/.local/share/pnpm -samefile "$f" -delete`, then the file itself. The node_modules entries are hardlinks into the store, so deleting by inode frees the store copies too.
  - Fail closed, matching the #1758 section: afterwards, assert that no `darwin`/`win32` directory remains and that `node -e "require('onnxruntime-node')"` loads.
- [ ] **Step 4: Build-time load check:** `RUN ./node_modules/.bin/tsx -e` loading the model once via `EmbeddingService.createBundled` and embedding one string. It fails the build if the weights or the native binary don't load.
- [ ] **Step 5: Egress test script.**
  - `docker network create --internal curia-egress-test`; run the published Postgres image on it; run the built image with `scripts/bundled-embedder-smoke.ts` on it.
  - Assert exit 0 and a printed source of `bundled`.
  - The internal network has no route out, so any outbound call fails the run.
- [ ] **Step 6: Run locally on Apple Silicon** (native arm64) and record the result. Add the script to CI after the image build (amd64). Record image size before and after (`docker image inspect -f '{{.Size}}'`). Expected: growth within ~70 MB plus the tokenizer.
- [ ] **Step 7: curia-deploy downstream check (maintainer decision: verify before merge).** Build `curia-deploy/deploy/compose/Dockerfile.curia` against the locally built image, from a worktree of curia-deploy, never the main checkout:

  ```bash
  docker build --build-arg CURIA_IMAGE_TAG=<local-tag> -f deploy/compose/Dockerfile.curia .
  ```

  Expected: success. A re-download of `onnxruntime-node` in its log is acceptable; a failure is not.
- [ ] **Step 8: Commit** `build(docker): bundle the embedding model, prune unused onnxruntime platforms, egress check (#2023)`.

### Task 10: Records, docs, system requirements, phase-out issue

**Files:**
- Create: `docs/adr/065-bundled-in-process-embedding-model.md`, `changes/feat-bundled-embedder.md`
- Modify: `docs/adr/README.md`, `docs/adr/051-*.md` (an "Amended by ADR-065" line), `docs/dev/configuration.md`, `docs/dev/setup.md`, `docs/specs/01-memory-system.md`, `.env.example`, `config/default.yaml` (comment on `embedding.profiles`)
- curia-docs (separate PR from a curia-docs worktree): `get-started/installation.mdx`, `integrations/openai-embeddings.mdx` (or a new `integrations/embedding-models.mdx`, linked from the boot log and `REEMBED_DOCS_URL` if the path changes), `core-concepts/memory.mdx`, `references/memory-schemas.mdx`

- [ ] **Step 1: File the phase-out issue** in josephfung/curia: "Remove the implicit OpenAI embedding default".
  - Apply all fitting existing labels plus `size:S`; set the milestone after this one.
  - Acceptance criteria: the compatibility rule is removed; an install relying on it gets `stored_model_without_endpoint` with both ways forward; release notes call it out.
  - Put the number into the Task 4 `TODO(#…)`.
- [ ] **Step 2: Measure system requirements** on the prod VPS class. **Ask the maintainer before creating a temporary server.** Run the stock `docker-compose.yml` with this image, then record:
  - CPU and RSS per container at rest and under light use (a few `memory-store`/`memory-query` calls);
  - disk for the images and a fresh volume;
  - the same with voice and the browser service enabled.
- [ ] **Step 3: Write ADR-065,** per design §9:
  - choice and evidence (link to the #2023 comment);
  - runtime A vs B/C;
  - upgrade (ii) and the deprecation and phase-out;
  - pinned weights and the weights-hashed stamp;
  - the calibrated thresholds (Task 8);
  - the drift floor measurements (Task 7);
  - RSS, latency and image size (Task 9, Step 2).

  Add the README row and the ADR-051 amendment line.
- [ ] **Step 4: Repo docs.**
  - `configuration.md`: precedence, `EMBEDDING_MODEL_DIR`, `fetch:embedder`, `reembed:kg --force`, health `knowledge_graph`.
  - `setup.md`: dev needs `pnpm fetch:embedder`.
  - `01-memory-system.md`.
  - `.env.example`: both variables commented; unset = bundled; OpenAI shown as one endpoint example; implicit default deprecated.
- [ ] **Step 5: curia-docs PR.**
  - `installation.mdx`: "What you'll need" gains the measured requirements; the knowledge graph works out of the box; the "exact-match only" wording goes.
  - The swap guide covers design §8's table, how to see the active model (boot log, `details.knowledge_graph`), profiles and calibration, and the English-only default.
  - Memory pages: the width depends on the profile.

  Link the curia-docs PR from the curia PR, and merge both before a release ships this.
- [ ] **Step 6: Changelog fragment.** One bullet each, ≤15 words after the dash:
  - Added: bundled embedding model; `knowledge_graph` health check (public surface); `reembed:kg --force`.
  - Changed: the identifier guard.
  - Deprecated: the implicit OpenAI default.
- [ ] **Step 7: Confirm the setup catalog** (`skills/setup/tools/setup-status/catalog.yaml`) needs nothing; note it in the PR.
- [ ] **Step 8: Full verification:** `pnpm -C <worktree> run typecheck`, `pnpm -C <worktree> lint` (full), `pnpm -C <worktree> test`. Expected: all pass. **Commit** `docs: ADR-065, configuration and changelog for the bundled embedding model (#2023)`.

---

## Before the PR

- Run `pr-review-toolkit:code-reviewer` and `pr-review-toolkit:silent-failure-hunter` in parallel on the branch. Also run a security review, since this touches an external dependency and a build-time download.
- Self-review against `docs/dev/review-checklist.md`.
- Check migration prefixes are unique after any rebase.
- PR body: `Closes #2023`; counts-only evaluation figures; the curia-docs PR link; the curia-deploy downstream build result.
