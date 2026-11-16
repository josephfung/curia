# Bundled embedding model (default) — design

Date: 2026-11-15
Issue: #2023 (remaining work after #2225)
Status: Ready for approval

## Intent

Every Curia install should have a working knowledge graph with only an Anthropic key. Today
entity memory needs an embedding endpoint: OpenAI by default, or an OpenAI-compatible server
(#2225). A fresh install that follows the documented quick start has no knowledge graph, and with
it no sensitivity classifier and no setup wizard.

This work ships a small embedding model **inside the Curia image** and runs it **in-process**, so
the knowledge graph works with no configuration, no network call at runtime and no extra container.
The reasons are the ones #2023 gives: installability, one less outage mode and key, privacy (labels
stay on the server), and latency. It is not a cost play.

The model was chosen by evaluation on a hand-labelled set drawn from a production graph. Results:
https://github.com/josephfung/curia/issues/2023#issuecomment-6901002341. Summary:
`all-MiniLM-L6-v2` (int8 ONNX, 384 dims, about 23 MB) ties `text-embedding-3-small` on entity
names and beats it on fact dedup. On the prod VPS class (2 vCPU x86) it adds about 90 MB of
resident memory and takes about 1 ms per label.

## Goals

1. A fresh install with only an Anthropic key starts with entity memory on, backed by the bundled
   model, and `memory-store`, `memory-query`, `query-relationships` and `delete-relationship` work
   end to end.
2. The bundled model makes **no network call** at runtime or first boot, on x86-64 and arm64.
3. **Existing installs keep the model they use today.** An install whose graph holds vectors from
   any other model (OpenAI, or a model on a custom endpoint such as a Qwen3 server) never moves to
   the bundled model unless its operator switches.
4. **OpenAI becomes an ordinary endpoint.** It is configured like any other server: base URL,
   model and key. The one OpenAI-specific path left is a deprecated compatibility rule for installs
   that relied on the old implicit default, and a later release removes it (section 1).
5. Switching to or from the bundled model is a documented, deliberate operator step.
6. Fixes the evaluation found that hold whatever the model:
   - an **identifier guard**, so labels carrying different order numbers, message IDs and the
     like never auto-resolve or merge;
   - **calibrated thresholds** for the bundled profile;
   - a committed **anonymised fixture** that reproduces the real-data cases.
7. The two follow-ups from the #2023 thread:
   - `/api/health` says **why** entity memory is off;
   - Curia notices when the **weights behind a model name change**.
8. An **operator guide** for swapping the bundled model for a larger one (or back to OpenAI).

## Non-goals

- Migrating existing installs automatically. The maintainer chose to leave that to each operator
  (approach (ii) below).
- Hybrid keyword + vector search. On the labelled set, keyword matching surfaced more relevant
  labels than vector search (55% vs 44%), and no candidate model closed that gap. It is worth its
  own issue; #2023 lists it out of scope.
- A multilingual default. MiniLM-L6 is English-only, and the guide points operators who need more
  languages at a larger model.
- GPU inference, batching across requests, or any embedding use beyond KG labels and queries.
- Cleaning up agent bookkeeping stored as KG facts (opaque keys, follower lists, run logs). The
  evaluation excluded these; they are a separate hygiene question.

## Anti-goals (a failure even if it technically works)

- **Changing an operator's chosen model without their action**, including at upgrade.
- **Comparing vectors from two models**, in any window. #2225's stamp and boot gate must keep
  holding.
- **Any outbound request from the bundled path**, including a lazy download "just this once".
- **Growing the Curia container's memory by more than ~100 MB** on the default path. Prod's
  container limits already add up to more than the host's RAM.
- **Image growth well beyond ~70 MB.** This is the reason for not using transformers.js; see
  Approaches.
- **The identifier guard blocking real merges.** Every pair labelled "same" in the evaluation set
  must still pass it.

## Constraints

- **#2225 is the base.** Endpoint resolution (`resolveEmbedding`), per-model profiles
  (`embedding-profiles.ts`), the `embedding_model` stamp with its CHECK, the boot gate
  (`resolveKnowledgeGraphEmbedding` / `checkEmbeddingSchema`), `pnpm reembed:kg` with the instance
  lock, and `pnpm embedding-eval` all stay. The bundled model is one more backend and one more
  built-in profile.
- **Width.** The `kg_nodes.embedding` column is resized by the existing paths: automatically when
  the table holds no vectors, by `pnpm reembed:kg` otherwise. 384 is well under the 2,000 HNSW cap.
  No new migration is expected; if one turns out to be needed, raise it with the maintainer first.
- **Weights ship in the image**, fetched at **build** time from a pinned source and verified by
  checksum. Never at runtime.
- **x86-64 and arm64.** `onnxruntime-node` 1.30 bundles CPU binaries for both (44 MB and 24 MB).
  Its postinstall only fetches CUDA providers and stays disabled (`allowBuilds: onnxruntime-node:
  false` is already in `pnpm-workspace.yaml`).
- **Image size.** `onnxruntime-node` unpacks to about 301 MB because it carries every platform's
  binaries. The runtime image must keep only `linux/<arch>`, in both `node_modules` and the pnpm
  store that the image deliberately keeps for curia-deploy (#1758). See section 4.
  - **Measured** (`docker image inspect -f '{{.Size}}'`, against the image before this work):
    arm64 **+78.2 MB** (3,122,600,860 → 3,200,776,352 bytes; +861.8 MB had nothing been
    pruned); amd64 **+119.5 MB** (3,127,949,004 → 3,247,451,012 bytes, an emulated
    `docker buildx build --platform linux/amd64` on Apple Silicon). CI's `curia-image` job
    prints the native amd64 size on every build.
  - **Why over the ~70 MB budget:** the weights are 23.7 MB, and the kept binary (24 MB arm64,
    44 MB amd64) ships twice. pnpm copies (does not hardlink) a package with a build script, so
    the prune hardlinks the kept `node_modules` files back to their store copies (one copy in
    that layer), but the pre-existing `chown -R curia:curia /app` layer copies every file under
    `/app` again. That chown layer duplicates *all* of `node_modules` (about 600 MB before this change,
    648 MB after, measured in the amd64 image), which is the real cause of the image's size;
    fixing it is a follow-up outside #2023 (#2631), since it touches the #1758 store contract.
    The maintainer accepted the image and boot-peak overage on 2026-11-15.
- **pnpm minimum release age** applies to new dependencies.
- **ESM, CommonJS default import rule** (CLAUDE.md, #2410). `onnxruntime-node` is CommonJS; use
  the default import and run `check:dist-imports`.

## Approaches considered

**Runtime (decided: A).**

| | Approach | Image growth | Trade-off |
|---|---|---|---|
| **A** | `onnxruntime-node` + `@huggingface/tokenizers`, with pooling and normalisation written in Curia (about 20 lines) | ~70 MB (runtime for one platform 44 MB, weights 23 MB, tokenizer 0.6 MB) | Curia owns pooling; each bundled profile names its pooling strategy |
| B | `@huggingface/transformers` (used in the evaluation spike) | ~245 MB | Hard dependencies on `onnxruntime-web` (140 MB) and `sharp` (19 MB), which Curia doesn't use |
| C | Sidecar (llama.cpp / Ollama) through #2225's HTTP path | +container, +~100 MB RAM | No new inference code, but it's the extra container #2023 counts against; it stays the documented upgrade path for larger models |

**Upgrade behaviour for existing installs (decided: (ii)).**

| | Approach | Why not / why |
|---|---|---|
| (i) | Re-embed automatically at boot toward the bundled model | Rejected by the maintainer. Some operators chose their model deliberately, and this would overrule them |
| **(ii)** | **An install whose graph holds another model's vectors keeps that model; fresh installs and empty graphs get the bundled model. Switching is an explicit operator step** | Chosen. Nobody's model changes under them, whether it is OpenAI or a model they picked themselves |
| (iii) | Switch the default and require a manual `pnpm reembed:kg` | The knowledge graph goes dark on upgrade until someone acts |

## Design

### 1. Model resolution (replaces today's default)

One rule, the same for every provider: **no `EMBEDDING_BASE_URL` means the in-process bundled
model; an `EMBEDDING_BASE_URL` means that server**, whether it is OpenAI, Ollama, llama.cpp or
anything else that speaks the `/embeddings` API. The default `.env` sets neither variable.
Operators set them only to override the default; `.env.example` keeps both commented out.

Precedence in `resolveEmbedding`:

1. **`EMBEDDING_BASE_URL` set** → that endpoint and `EMBEDDING_MODEL`'s profile, with the vault's
   `embedding_api_key` when the server needs one. `EMBEDDING_MODEL` is required, as #2225 made it.
   **OpenAI is configured this way too:** `EMBEDDING_BASE_URL=https://api.openai.com/v1`,
   `EMBEDDING_MODEL=text-embedding-3-small`, key in `embedding_api_key`.
2. **No base URL** → the bundled backend. `EMBEDDING_MODEL` may be left unset, or name the bundled
   model; any other value keeps the knowledge graph off with a reason that says a non-bundled
   model needs `EMBEDDING_BASE_URL`. Exceptions:
   - **The graph holds another model's vectors, or an unfinished `reembed:kg` run targets another
     model, and `EMBEDDING_MODEL` doesn't explicitly name the bundled model.** Curia does not
     switch the install to the bundled model.
     - If that model is `text-embedding-3-small`, see the compatibility rule below.
     - Otherwise (for example a Qwen3 server whose `EMBEDDING_BASE_URL` was removed or lost), the
       knowledge graph stays off. The reason names the stored model and the two ways out: restore
       its endpoint settings, or set `EMBEDDING_MODEL` to the bundled model and run
       `pnpm reembed:kg`.

     Counting an unfinished run's target matters: a re-embed that stopped after clearing vectors
     must not leave the install looking "fresh" and silently switch it on the next run.
   - **`EMBEDDING_MODEL` explicitly names the bundled model.** That is the operator's switch
     signal. The bundled profile is chosen, the boot gate sees the stored vectors don't match and
     keeps the knowledge graph off until `pnpm reembed:kg` runs, exactly as for any model change
     today.

**Compatibility rule for the old implicit OpenAI default (deprecated).** Before this change, an
install with no base URL and an `openai_api_key` used OpenAI implicitly. Under (ii) those installs
must keep working untouched, so in this release:

- no base URL, `EMBEDDING_MODEL` unset or set to `text-embedding-3-small` (#2225 allowed naming
  it without a base URL), and the graph holds `text-embedding-3-small` vectors (or an open run
  targets it) → OpenAI at its standard URL with `openai_api_key`, exactly as before;
- a fresh install or empty graph never takes this path, even with an OpenAI key in the vault: it
  gets the bundled model, or OpenAI only through step 1;
- boot logs a **deprecation warning** each time this rule applies. It says the implicit OpenAI
  default goes away in a later release and gives both ways forward: set OpenAI explicitly (step 1)
  or switch to the bundled model (section 8);
- `checks.knowledge_graph` stays `ok` (the graph is on), with `details.knowledge_graph:
  "implicit_openai_deprecated"` so the warning is visible in health too.

This is the only place that reads `openai_api_key` for embeddings, and the only OpenAI-specific
branch left in resolution. The built-in `text-embedding-3-small` profile stays: profiles belong to
models, not providers.

**Phase-out (a later release, not this one).** Remove the compatibility rule. An install still
relying on it then hits the step 2 exception like any other stored model: knowledge graph off,
with a reason naming both ways forward. The release that removes it says so in its notes, and at
least one release ships with the deprecation warning first. File a follow-up issue for the removal
when this ships, and add a `TODO(#<issue>)` comment at the rule.

Resolution needs the stored stamps before choosing a profile. The boot gate already reads them
(`readEmbeddingSchema`), so resolution should use that same snapshot, not a second query. The
test-mode stack and `scripts/dedup-contacts.ts` share the boot gate and must resolve the same way.
`pnpm reembed:kg` re-embeds toward whatever resolution picks, so an operator switching models sets
the variables first (section 8).

The reason codes that `describeEmbeddingUnavailable` explains gain the new cases:
- bundled weights missing or unloadable;
- a non-bundled `EMBEDDING_MODEL` with no base URL;
- the graph holding another model's vectors with no endpoint configured for it;
- the OpenAI compatibility rule without a key.

The `no_endpoint` reason no longer occurs.

### 2. The bundled backend

A new `EmbeddingBackend` implementation, for example `OnnxEmbeddingBackend` in
`src/memory/embedding-onnx.ts`:

- **Loads at boot**, eagerly, so a missing or corrupt weight file shows up in the boot log and in
  health rather than on the first write. Load takes about 0.1 s.
- **Session options:** CPU execution provider, `intraOpNumThreads: 1`, `interOpNumThreads: 1`.
  MiniLM needs no more, and the box is shared with Postgres. Graph optimisation at the default
  level.
- **Tokenizer:** `@huggingface/tokenizers` reading the pinned `tokenizer.json`; truncate at the
  model's maximum sequence length (256 tokens for this model), padding off (one text per call).
- **Pooling:** mean pooling over the attention mask, then L2 normalisation. The profile records the
  pooling strategy (`mean` here) so a future bundled model can use `cls` or `last_token` with a
  small switch, not a new backend.
- **Concurrency:** calls are serialised through a small in-process queue. Single-label inference
  is about 1 ms, so a queue costs nothing, and it removes any question about concurrent `run()`
  calls on one session.
- **Errors and telemetry:** same shape as `HttpEmbeddingBackend`. `embedding.error` on failure,
  `embedding.call` with `estimatedCostUsd: 0` and real latency on success. No `console.log`.
- **Never fetches.** The backend takes a local directory path and nothing else. There is no code
  path that turns a missing file into a download.

### 3. The bundled profile

A new built-in profile in `embedding-profiles.ts`:

- `model`: `all-MiniLM-L6-v2`; `dimensions`: 384; prefixes all empty (the model has no task
  prompts); pooling `mean`.
- **Thresholds** come from the calibration run (section 6). The ADR and a code comment cite it.
  Indicative values from the evaluation, before the identifier guard:

  | Threshold | Indicative value | What it does at that value |
  |---|---|---|
  | fuzzy auto-resolve | ~0.92 | lowest value with no wrong merge; resolves ~18% of true name matches |
  | ambiguity floor | ~0.61 | keeps 95% of true matches in the ask band |
  | fact dedup | ~0.95 | lowest value with no wrong merge; merges ~11% of true duplicates |

  The policy is the one ADR-051 set: lowest value with no wrong merge on the labelled set.

**Stamp.** The stamp includes a short hash of the weight file, for example
`all-MiniLM-L6-v2#weights:<sha256-12>`. A weights change shipped in a later image (another
quantisation, a different export) then reads as a model mismatch to the existing gate, never as
silent drift.

- **The hash is of the file actually loaded,** computed at boot (sha256 of ~23 MB, tens of
  milliseconds), not copied from the manifest. When it differs from the manifest (an
  `EMBEDDING_MODEL_DIR` holding another export), boot logs a warning and the stamp carries the
  real hash. Vectors are then never labelled as the shipped weights when they aren't.
- **The weights hash belongs to the bundled backend, not to the model name.** If an operator
  serves the same model through an endpoint (`EMBEDDING_BASE_URL` with
  `EMBEDDING_MODEL=all-MiniLM-L6-v2`), its profile's thresholds and pooling apply, but the stamp
  carries no weights hash (the endpoint's weights are unknown). Section 7's drift check covers
  drift there.
- **Profile overrides** of the bundled profile (`base: all-MiniLM-L6-v2` under
  `embedding.profiles`) may change thresholds. `parseEmbeddingProfiles` must carry the base's
  pooling through, so an override doesn't change the stamp or turn the knowledge graph off.

### 4. Weights in the image (and in dev)

- **Source:** the pinned Hugging Face revision of `Xenova/all-MiniLM-L6-v2` (`onnx/model_quantized.onnx`
  and `tokenizer.json`). A manifest file in the repo records the revision commit and the sha256 of
  each file, for example `models/embedding/manifest.json`.
- **Docker:** the build stage downloads both files by the pinned revision, verifies the sha256s
  (and fails the build on mismatch), and copies them into the runtime image at a fixed path, for
  example `/app/models/embedding/all-MiniLM-L6-v2/`.
- **Pruning other platforms (maintainer's decision).** In the **same `RUN` step** as the runtime
  stage's `pnpm install --prod`, delete every `onnxruntime-node/bin/napi-v*/<platform>/<arch>`
  directory except the image's own, from **both** `node_modules` and the pnpm content-addressable
  store. The image keeps that store on purpose (#1758), so pruning `node_modules` alone frees
  nothing, and pruning in a later layer frees nothing either.
  - Accepted risk: curia-deploy's downstream `pnpm add` may see the store copy as incomplete and
    re-download that one package. That costs bandwidth, which is acceptable.
  - Not acceptable: a failed downstream build. **Before merging, build curia-deploy's
    `Dockerfile.curia` against the new base image** and confirm it succeeds.
  - The existing fail-closed checks in that Dockerfile section stay. Add one that the image's
    own platform binary still loads (for example, by loading the model once at build time).
- **Local dev:** `pnpm fetch:embedder` runs the same download and verify into `models/embedding/`
  (gitignored). If the files are missing, the knowledge graph stays off with a reason that names
  the command. Unit tests don't need the weights; they keep using the fake backend.
- **Location override:** an `EMBEDDING_MODEL_DIR` environment variable for operators who keep
  weights elsewhere. It must be readable at boot; nothing is fetched.

### 5. Identifier guard (model-independent)

Before a fuzzy candidate **auto-resolves**, and before a fact **merges** in dedup, compare the
**identifier tokens** of the two labels. If both labels contain identifier tokens and neither
label's set is a subset of the other's, the pair is treated as **not the same**. It doesn't
auto-resolve or merge. Whether it may still appear as an ambiguous candidate is the builder's call,
from what the fixture shows works.

- **Identifier tokens:** runs of 4 or more digits after removing in-number separators (so
  `(905) 555-0176` and `905-555-0176` normalise the same), and alphanumeric runs of 8 or more
  characters that contain at least one digit (message IDs, hex hashes). The builder refines the
  exact rule against the labelled set.
- **Subset, not equality:** `tax: $1,204.50` and `tax: $1,204.50 (no change since 2030)` were
  labelled the same fact. Their tokens are a subset, so the guard allows the merge. Two different
  order numbers are not subsets of each other, so it blocks them.
- **Applies to every model,** OpenAI and endpoints included. It sits in `entity-memory.ts` (fuzzy
  phase) and `validation.ts` (dedup loop) and doesn't depend on the profile.
- **Acceptance:** on the private labelled set, the guard blocks every ID-like pair labelled
  "different" and blocks **no** pair labelled "same". The anonymised fixture reproduces both
  cases as committed tests.

### 6. Calibration, fixture and harness

- **Harness:** `scripts/embedding-eval.ts` gains an in-process mode (`--bundled`, or a backend
  selector), so the bundled model is scored by the same code that scores endpoints. It also gains
  an option to apply the identifier guard before computing thresholds, so the thresholds match
  what runs in production.
- **Anonymised fixture:** a new committed fixture (or a second section in the existing one) that
  reproduces what the evaluation found in real data:
  - structured `attribute: value` facts;
  - same-value/different-attribute pairs (`current_` vs `former_`, `known_email_1` vs `_2`, start
    vs end times);
  - ID-like entity labels;
  - name variants: initials, dropped middle names, punctuation, a bare first name;
  - keyword-style search queries.

  Every string is invented. The maintainer's private set (kept outside git) is used with
  `--fixture` for the real calibration run; the committed fixture keeps the cases covered in CI.
- **Inputs the builder needs from the maintainer:** the private labelled set and the evaluation
  spike's scripts and per-model results. The maintainer holds both locally and provides the path.
  The golden vectors (Verification) are regenerated from that spike with a throwaway
  transformers.js script, not committed from it.
- **Calibration run:** bundled model, with the identifier guard on, against the private set. It
  produces the profile's three thresholds. The ADR records the values and the run's numbers
  (ROC-AUC, share resolved or merged at each threshold).

### 7. Health and drift (the #2023 follow-ups)

- **`/api/health` gets a `knowledge_graph` check (maintainer's decision).** Today
  `/api/health` has no knowledge-graph entry; only the daily canary mentions embeddings, and it
  says "skipped" both when the graph was never configured and when Curia turned it off.
  - `checks.knowledge_graph` is `ok` when entity memory is on and `fail` when it's off for any
    reason, which turns the overall status `degraded`. With a bundled default, "off" always means
    something is wrong or a switch is in progress, so tripping monitors is correct; that includes
    an operator's own `reembed:kg` window.
  - The reason travels in a new optional field alongside `checks`, for example
    `details.knowledge_graph: "reembed_in_progress"`. Values: no profile, width or model mismatch,
    re-embed in progress, bundled weights missing, OpenAI-stamped graph without a key, weights
    changed. "Drift unchecked" and "weights shifted" (below) report `ok` with the reason set,
    since the graph is on.
  - Both are additive changes to a public surface. The console renders `checks` with
    `Object.entries`, so it needs no change. The changelog fragment calls the additions out.
  - The daily embeddings canary keeps running whenever entity memory is on, as #2225 left it.
- **Weight drift.**
  - *Bundled model:* covered by the weights hash in the stamp (section 3).
  - *Endpoints:* **the stored vectors are the baseline.** At boot, take a small sample of existing
    `kg_nodes` rows carrying the current stamp (for example 5, chosen deterministically by id),
    embed their labels again through the endpoint with the `document` purpose they were stored
    with, and compare each new vector with the stored one. No new table, no migration, no
    baseline to record or keep in sync.
    - minimum cosine ≥ 0.995: same weights (room for hosted/GPU endpoints that are not
      bit-for-bit repeatable; measured re-quantisations still score below it);
    - median cosine below a "shifted" floor: treated as a model mismatch, knowledge graph off
      until re-embed. The median, not the minimum, decides this (ruling R21): one stored row
      whose vector no longer matches its label (a node-merge survivor renamed while the graph
      was off, older data) must not switch the graph off, and a different model scores ~0.06
      on every row. Rows below the floor while the median is above it are logged at warn with
      their ids and cosines (never their labels). With fewer than 5 rows, the median of what
      is there. An endpoint that answers with vectors of another width is also a model
      mismatch;
    - otherwise: weights shifted (e.g. re-quantised). The knowledge graph stays on, health
      reports `ok` with the reason `weights_shifted`, and boot logs a warning naming the
      recovery, `pnpm reembed:kg --force`.

    The builder sets the floor from a measurement: re-quantise one model, embed the same labels,
    and choose a value between that shift and a genuinely different model's score.

  Failure cases:
  - **Scope:** every HTTP endpoint, including OpenAI (explicit or through the compatibility
    rule). The check re-embeds a handful of labels, so the cost is negligible.
  - **Endpoint unreachable at boot:** the check never blocks boot. A local server that starts
    after Curia must not turn the knowledge graph off. The check has a short timeout; on
    failure, the knowledge graph stays on, health reports "drift unchecked", and the check
    retries on the canary schedule.
  - **Empty graph** (no rows with the current stamp): nothing to compare and nothing to protect;
    the check reports same.
  - **Below the floor (found at boot):** the knowledge graph stays off with a "weights changed"
    reason. Recovery is `pnpm reembed:kg --force`, which re-embeds every row even when the stamp
    matches. Today's command skips rows whose stamp already matches, so `--force` is new. After
    it, the stored vectors come from the current weights, so the next check passes on its own.
  - **Below the floor (found by a later canary):** health fails with that reason and an error is
    logged. The knowledge graph is not switched off mid-run; there's no runtime toggle for it,
    and adding one is out of scope.
  - **Shifted band:** the graph stays on and health keeps the `weights_shifted` reason (status
    `ok`) until the operator runs `pnpm reembed:kg --force`. It is never accepted silently: the
    reason and the boot warning say what happened and how to recover.

### 8. Switching models (operator steps; also the guide's core)

Every switch has the same shape: change the two variables (and the key, if the server needs one),
stop Curia, run `pnpm reembed:kg`, start. Only the variables differ.

| From → to | Variables |
|---|---|
| anything → bundled | unset `EMBEDDING_BASE_URL`; set `EMBEDDING_MODEL=all-MiniLM-L6-v2` (the explicit name is the switch signal when the graph holds another model's vectors) |
| anything → a server such as Ollama or llama.cpp | `EMBEDDING_BASE_URL` and `EMBEDDING_MODEL`, plus a profile under `embedding.profiles` unless a built-in one fits; `embedding_api_key` if the server checks one |
| anything → OpenAI | `EMBEDDING_BASE_URL=https://api.openai.com/v1`, `EMBEDDING_MODEL=text-embedding-3-small`, `embedding_api_key` in the vault |
| implicit OpenAI (deprecated) → explicit OpenAI | set the OpenAI row's variables and seed `embedding_api_key`. **No re-embed:** the stamp is unchanged, so the boot gate passes and the deprecation warning stops |

The command and the stamp already make every switch safe; this work adds the bundled source and
the documentation. The operator guide (curia-docs, linked from the boot log line in section 1)
also covers:
- how to see which model is active (boot log, health);
- why a model without a profile keeps the knowledge graph off;
- how to calibrate a profile with `pnpm embedding-eval`;
- the English-only limitation of the default.

### 9. Docs and records

- **ADR-065:** bundled in-process default embedding model. Records:
  - the choice and its evidence (link to the issue comment);
  - the runtime (A) and why not B/C;
  - upgrade behaviour (ii);
  - the weights pinning and stamp hash;
  - the calibrated thresholds;
  - memory and latency on the prod VPS class.

  It amends ADR-051 (whose alternative 1 it implements); ADR-051 stays accepted. Add a row to
  `docs/adr/README.md`.
- **Repo docs:** `docs/dev/configuration.md` (precedence, `EMBEDDING_MODEL_DIR`,
  `pnpm fetch:embedder`), `docs/dev/setup.md`, spec `01-memory-system.md`. `.env.example` keeps
  `EMBEDDING_BASE_URL` and `EMBEDDING_MODEL` commented out, with the comment rewritten:
  - unset means the bundled model;
  - OpenAI is shown as one example endpoint among others;
  - the implicit OpenAI default is deprecated.
- **curia-docs:**
  - `get-started/installation.mdx`: the knowledge graph works out of the box; fix the incorrect
    "exact-match only" wording. **Add system requirements** to "What you'll need", which today
    lists only Docker, Compose and curl, with no CPU, memory or disk figures anywhere in the docs.
    The figures are **measured**, not estimated: CPU, RAM and disk for a vanilla install (the
    stock `docker-compose.yml` services) at rest and under light use, on the prod VPS class (2
    vCPU / 4 GB), with this change in place. State what's included (Postgres, Curia, the bundled
    embedding model) and what adds to it (voice/LiveKit, the browser service, a larger embedding
    model). Link the swap guide for the larger-model case;
  - `integrations/openai-embeddings.mdx`: becomes the embedding-models / swap guide (or links to a
    new page);
  - `core-concepts/memory.mdx`;
  - `references/memory-schemas.mdx`: the width depends on the profile.
- **Setup catalog:** #2225 removed `kg_memory`; confirm nothing new is needed. The knowledge graph
  now has no setup step.
- **Changelog fragment** in `changes/`.

## Verification

- **Unit:**
  - resolution precedence, every branch of section 1, including the OpenAI-stamped graph without a
    key;
  - pooling and normalisation;
  - the identifier guard, including the subset rule and phone-number normalisation;
  - the stamp with the weights hash.
- **Golden vectors:** embed three fixed strings with the bundled backend and compare them with
  reference vectors committed from the spike's transformers.js output (cosine ≥ 0.9999). This
  catches tokenizer or pooling drift.
- **Integration (real Postgres):**
  - a fresh database with only an Anthropic key → entity memory on, column resized to 384,
    `memory-store` and `memory-query` round-trip;
  - a database holding OpenAI-stamped vectors with no embedding variables → stays on OpenAI
    through the compatibility rule, logs the deprecation warning, health shows the reason;
  - the same database with OpenAI configured explicitly (base URL, model, `embedding_api_key`) →
    serves with no re-embed and no warning;
  - a database holding another model's vectors (e.g. a Qwen3 stamp) with no base URL →
    knowledge graph off, reason names the stored model; never switched to bundled;
  - a database holding OpenAI-stamped vectors with `EMBEDDING_MODEL=all-MiniLM-L6-v2` → gate
    refuses until `reembed:kg`, then serves.
- **Egress:** boot the built image with networking disabled (`--network none` plus a reachable
  Postgres, or an equivalent egress block) on x86-64 and arm64. Entity memory initialises and a
  store and query round-trip.
- **Footprint:** record image size growth and Curia container RSS before and after, on the prod VPS
  class, in the ADR. Budget: ~70 MB image, ~100 MB RSS.
- **Existing tests:** memory unit and integration tests pass; `check:dist-imports` passes; full
  lint and typecheck.

## Decided by the maintainer

- Default bundled model: `all-MiniLM-L6-v2` (option A of the model decision).
- Runtime: `onnxruntime-node` + `@huggingface/tokenizers` directly (approach A).
- Upgrade: (ii). An install whose graph holds another model's vectors (OpenAI or any custom
  endpoint) keeps that model; switching is explicit and documented.
- The default `.env` sets no embedding variables; operators set them only to override.
- OpenAI is treated as an ordinary endpoint. The old implicit default survives one release as a
  deprecated compatibility rule, and a later release removes it.
- curia-docs gains system requirements, with measured figures.
- An operator guide for swapping models ships with this work.
- Image size: prune unused `onnxruntime-node` platforms from both `node_modules` and the pnpm
  store; a re-download in curia-deploy's downstream build is an accepted cost; verify that build
  before merging.
- Health: a new `knowledge_graph` check in `/api/health`, with the reason in an optional field.

## Calls made in this design (check these)

- **The compatibility rule keys on stored OpenAI stamps, not on the presence of an OpenAI key,**
  so a fresh install that holds a key for image generation still gets the bundled default.
- **Explicit OpenAI uses `embedding_api_key`,** the same vault key as every other endpoint.
  `openai_api_key` is read for embeddings only by the deprecated compatibility rule. Moving from
  implicit to explicit OpenAI therefore means seeding one more vault key; in exchange there's no
  provider special case to remove later.
- **The phase-out ships in a later release,** after at least one release with the warning;
  tracked as a follow-up issue filed when this ships.
- **Weights hash in the bundled stamp.** A future weights change in the image turns the knowledge
  graph off until `pnpm reembed:kg`, like any other model change (no automatic re-embed, consistent
  with (ii)).
- **Weights fetched at Docker build time** from a pinned Hugging Face revision with sha256
  verification, not committed to git. CI image builds therefore depend on Hugging Face being up.
- **Identifier guard blocks auto-resolve and merge only;** whether blocked pairs still show as
  ambiguous candidates is left to the builder.
- **Endpoint drift detection re-embeds a sample of stored labels** and compares the new vectors
  with the stored ones, so the stored vectors are the baseline: no table, no migration. It never
  blocks boot, retries on the canary schedule, covers OpenAI too, and clears only through
  `pnpm reembed:kg --force` (new flag). (The maintainer approved this over a baseline table.)
- **The bundled stamp hashes the file actually loaded,** and the weights hash belongs to the
  bundled backend, not the model name.
- **An unfinished re-embed's target model counts** as the install's model in precedence step 3.
- **`intraOpNumThreads: 1`** and a serialising queue.
- **ADR-065 amends ADR-051** rather than superseding it.

## Left to the builder

- Exact identifier-token rule (within the acceptance in section 5).
- The drift sample size and how rows are chosen, and the "shifted" floor value (from a
  measurement).
- Module names and file layout; whether the fixture is a new file or a new section.
- How the Docker build verifies and prunes (stage layout, script vs inline).
- The egress test's mechanics in CI.
