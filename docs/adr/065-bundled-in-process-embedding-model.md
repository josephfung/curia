# ADR-065: A bundled in-process embedding model is the default

Date: 2026-11-15
Status: Accepted

Amends [ADR-051](051-knowledge-graph-embeddings-from-a-configurable-endpoint.md), whose alternative 1 it implements. ADR-051 stays accepted.

## Context

ADR-051 made knowledge-graph embeddings come from any OpenAI-compatible `/embeddings` endpoint, with a profile per model, a stamp on every vector, a boot gate and `pnpm reembed:kg`. With no endpoint configured it still fell back to OpenAI, so a fresh install that followed the quick start with only an Anthropic key had no knowledge graph, and with it no sensitivity classifier and no setup wizard. ADR-051 deferred its alternative 1, an open model shipped in the image and run in-process, until an evaluation had been run and a runtime chosen.

Issue #2023 gives the reasons: installability, one fewer outage mode and key, privacy (labels stay on the server) and latency. Cost is not one of them.

The evaluation has now been run, on a hand-labelled set drawn from a production graph. The write-up is in the issue: https://github.com/josephfung/curia/issues/2023#issuecomment-6901002341. `all-MiniLM-L6-v2` (int8 ONNX, 384 dimensions, about 23 MB) tied `text-embedding-3-small` on entity names and beat it on fact dedup. That write-up compares the incumbent with seven open candidates that pass #2023's hard requirements (all-MiniLM-L6-v2, nomic-embed-text-v1.5, granite-embedding-english-r2, snowflake-arctic-embed-m-v2.0, BGE-M3, Qwen3-Embedding-0.6B and EmbeddingGemma 2) on quality, safe thresholds and cost on the prod VPS class. It records why three more were left out: harrier-oss-v1 (its ONNX export would not load), EmbeddingGemma v1 (Gemma Terms of Use) and jina-embeddings-v5-text-small (CC-BY-NC). The harness is `scripts/embedding-eval.ts`, with the committed synthetic fixture in `tests/fixtures/embedding-eval/`.

The setup wizard catalog needs no entry: there is nothing to configure for the default, and the `kg_memory` task that asked for an OpenAI key was removed earlier in #2023.

The bounds were set before building: no network call from the bundled path, ever; no change to an operator's chosen model without their action, including at upgrade; vectors from two models never compared; Curia's container memory up by no more than ~100 MB; image growth not much beyond ~70 MB.

Alternatives considered:

**Runtime.**

| | Approach | Image growth | Why / why not |
|---|---|---|---|
| **A** | `onnxruntime-node` + `@huggingface/tokenizers`, with mean pooling and L2 normalisation written in Curia | ~70 MB estimated | Chosen. Curia owns about 20 lines of pooling, and each bundled profile names its pooling strategy |
| B | `@huggingface/transformers` (used in the evaluation spike) | ~245 MB | Hard dependencies on `onnxruntime-web` (140 MB) and `sharp` (19 MB), which Curia does not use |
| C | A sidecar (llama.cpp, Ollama) through ADR-051's HTTP path | +1 container, ~+100 MB RAM | No new inference code, but it is the extra container #2023 counts against. It stays the documented path for a larger model |

**Upgrade behaviour for installs that already hold vectors.**

| | Approach | Why / why not |
|---|---|---|
| (i) | Re-embed toward the bundled model automatically at boot | Rejected. Some operators chose their model on purpose, and this would overrule them |
| **(ii)** | An install whose graph holds another model's vectors keeps that model; fresh installs and empty graphs get the bundled model; switching is an explicit operator step | Chosen. Nobody's model changes under them, OpenAI or any other |
| (iii) | Switch the default and require a manual `pnpm reembed:kg` | The knowledge graph goes dark on upgrade until someone acts |

## Decision

### Resolution

One rule for every provider: **no `EMBEDDING_BASE_URL` means the bundled in-process model; an `EMBEDDING_BASE_URL` means that server**, OpenAI included. The default `.env` sets neither variable. `resolveEmbedding()` in `src/memory/embedding.ts` decides, from the stamps the boot gate already reads:

1. **Base URL set:** that server and `EMBEDDING_MODEL`'s profile, keyed by the vault's `embedding_api_key`. OpenAI is configured this way like any other server (`EMBEDDING_BASE_URL=https://api.openai.com/v1`, `EMBEDDING_MODEL=text-embedding-3-small`).
2. **No base URL:** the bundled model. `EMBEDDING_MODEL` may be unset or name the bundled model. Exceptions:
   - The graph holds another model's vectors, or an unfinished `reembed:kg` run targets one, and `EMBEDDING_MODEL` does not name the bundled model. Curia does not switch. A non-OpenAI stored model leaves the knowledge graph off (`stored_model_without_endpoint`), with the reason naming both ways out. An unfinished run's target counts, so a re-embed that stopped after clearing vectors cannot make the install look fresh.
   - `EMBEDDING_MODEL` names the bundled model. That is the operator's switch signal. The boot gate then sees mismatched stamps and keeps the knowledge graph off until `pnpm reembed:kg` runs, as for any model change under ADR-051.
   - Any other `EMBEDDING_MODEL` without a base URL leaves the knowledge graph off (`non_bundled_model_without_base_url`).

**Deprecated compatibility rule.** Before this change, no base URL plus an `openai_api_key` meant OpenAI. Under (ii) those installs keep working: with no base URL, `EMBEDDING_MODEL` unset or `text-embedding-3-small`, and `text-embedding-3-small` vectors in the graph (or an open run targeting it), Curia uses OpenAI at its standard URL with `openai_api_key`. It keys on the stored stamps, not on the key, so a fresh install holding an OpenAI key for image generation still gets the bundled model. Boot logs a deprecation warning each time, naming both ways forward, and `/api/health` reports `knowledge_graph: ok` with `details.knowledge_graph: "implicit_openai_deprecated"`. This is the only place `openai_api_key` is read for embeddings. Moving to explicit OpenAI needs no re-embed, because the stamp does not change.

**Phase-out.** A later release removes the rule (#2628, `TODO(#2628)` at the rule). An install still relying on it then gets `stored_model_without_endpoint` like any other stored model, with both ways forward in the reason. At least one release ships the warning first, and the removing release says so in its notes.

### The bundled backend and profile

- `OnnxEmbeddingBackend` (`src/memory/embedding-onnx.ts`) loads eagerly at boot, so a missing or corrupt file shows in the boot log and in health, not on the first write. It runs on the CPU execution provider with `intraOpNumThreads: 1` and `interOpNumThreads: 1`, truncates at 256 tokens, applies mean pooling over the attention mask and L2 normalisation, and serialises calls through an in-process queue. `onnxruntime-node` is imported dynamically on the bundled path only, so an endpoint-only install never loads the native binding.
- It takes a local directory and nothing else. No code path turns a missing file into a download.
- The built-in profile `all-MiniLM-L6-v2`: 384 dimensions, empty prefixes, `mean` pooling, and the calibrated thresholds below. An operator override (`base: all-MiniLM-L6-v2` under `embedding.profiles`) inherits the pooling, so it can change thresholds without changing the stamp.

### Pinned weights and the stamp

- `models/embedding/manifest.json` pins `Xenova/all-MiniLM-L6-v2` at revision `751bff37182d3f1213fa05d7196b954e230abad9`: `onnx/model_quantized.onnx` (22,972,370 bytes) and the tokenizer files, each with its sha256.
- The Docker build stage downloads them by that revision and fails on a checksum mismatch. The runtime image holds them at `/app/models/embedding/all-MiniLM-L6-v2/`. CI image builds therefore depend on Hugging Face being up; a running Curia never contacts it. A source checkout runs `pnpm fetch:embedder` for the same download and check into `models/embedding/` (gitignored). `EMBEDDING_MODEL_DIR` points at weights kept elsewhere.
- The stamp carries a short hash of the weight file **actually loaded**, computed at boot: `all-MiniLM-L6-v2#weights:afdb6f1a0e45` for the shipped file. A later image with other weights (another quantisation or export) reads to the existing gate as a model change, never as silent drift. When the loaded file differs from the manifest, boot logs a warning and the stamp carries the real hash. The hash belongs to the bundled backend: the same model served by an endpoint stamps as its bare name.
- The runtime image keeps only `onnxruntime-node`'s `linux/<arch>` binaries, pruned from both `node_modules` and the pnpm store that the image keeps for curia-deploy (#1758), in the same `RUN` as the install. The kept files are hardlinked to their store copies. A build-time check loads the model once when the build platform matches the target (a cross-arch build logs a skip); the native arm64 egress run and CI's native amd64 `curia-image` job cover each architecture.
- `tests/docker/test-bundled-embedder-egress.sh` runs the built image on a Docker network with no route out, with no embedding variables or secrets, and checks that a fact stores and reads back through the bundled model.

### Calibrated thresholds

The policy is ADR-051's: the lowest value with no wrong merge on the labelled set. The run used the bundled model with the identifier guard on (below), through `pnpm embedding-eval --bundled --identifier-guard` against the private set, on 2026-11-15. Counts and scores only:

| | Entity resolution | Fact dedup |
|---|---|---|
| Labelled pairs (same / different) | 89 / 51 | 62 / 63 |
| Dropped by the identifier guard (same / different) | 0 / 7 | 0 / 11 |
| ROC-AUC, guard on (guard off) | 0.878 (0.780) | 0.847 (0.840) |
| **Shipped threshold** | **`fuzzy_resolve` 0.92**: resolves 15 of 89 same pairs (16.9%), 0 wrong | **`fact_dedup` 0.95**: merges 7 of 62 same pairs (11.3%), 0 wrong |
| Ambiguity floor | **`fuzzy_ambiguity_floor` 0.61**: 85 of 89 same pairs score at or above it | n/a |

Search over 29 queries and 6,405 labels: recall@5 0.450, MRR 0.676. The guard is load-bearing: without it, the lowest entity threshold with no wrong merge is 0.99, which resolves nothing.

### Identifier guard (every model)

Before a fuzzy candidate auto-resolves and before a fact merges in dedup, `hasConflictingIdentifiers()` (`src/memory/identifier-guard.ts`) compares the identifier tokens of the two labels: digit runs of 4 or more after in-number separators are removed, and alphanumeric runs of 8 or more with a digit. If both labels carry tokens and neither set is a subset of the other, the pair is not the same. Years (bare 1900–2099) yield to a stronger shared token. It applies to every model, OpenAI and endpoints included. On the private set it blocks 7 of 7 ID-like different name pairs and 0 of 151 same pairs (89 names, 62 facts). It also blocks 11 of 63 different fact pairs.

### Health and drift

- `/api/health` gains `checks.knowledge_graph` (`ok` when entity memory runs, `fail` when it is off, `skipped` in setup mode) and an optional `details.knowledge_graph` with the reason code. Both are additive. `fail` degrades the status, never `down`.
- **Endpoint drift.** The stored vectors are the baseline. For every endpoint source, OpenAI included, boot re-embeds 5 stored labels (stable order by id, the current stamp, `document` purpose, 5 s timeout) and compares each new vector with the stored one. When the lowest cosine is at or above `DRIFT_SAME_MIN` 0.995, the weights are the same. When the median cosine is below `DRIFT_SHIFT_FLOOR` 0.9, they changed. Otherwise they shifted: the graph stays on and health reports `ok` with `weights_shifted`, and any sampled row below 0.9 is logged at warn by id. The median, not the minimum, decides `changed` so that one stale row cannot switch the graph off; a different model scores near 0 on every row. An endpoint that answers with vectors of another width also counts as changed. When they changed, the graph stays off with `weights_changed` until `pnpm reembed:kg --force`, a new flag that re-embeds every row even when its stamp matches. An unreachable endpoint never blocks boot (`drift_unchecked`), and the daily embeddings canary retries. A change found by the canary fails health and logs the command; there is no runtime switch-off. The bundled model needs no check: its stamp carries the weights hash.
- Measured to set those values (20 invented labels; @huggingface/transformers on CPU):

  | Pair | Minimum cosine | Maximum |
  |---|---|---|
  | Same weights, embedded twice | 1.000000 | 1.000000 |
  | EmbeddingGemma 2, q4 vs q8 | 0.980855 | 0.991421 |
  | all-MiniLM-L6-v2, q8 vs fp32 | 0.986651 | 0.994801 |
  | granite-embedding-english-r2 vs nomic-embed-text-v1.5 | -0.058568 | 0.064908 |

  The same-weights cutoff is 0.995, not the 0.999 first planned: hosted and GPU endpoints are not bit-for-bit repeatable the way these CPU runs were, and every measured re-quantisation still falls below 0.995. The floor of 0.9 sits about 0.08 under the lowest re-quantisation and 0.84 above the highest cross-model score.

### Footprint

Measured on 2026-11-16 on a Hetzner cpx22 (2 shared AMD EPYC-Genoa vCPU, 3,814 MiB RAM, 4 GiB swap, Docker Engine 29.9.3 with the containerd image store), stock `docker-compose.yml`, comparing the image before this work with this branch, both built natively on the box. The run had no real LLM key, so it covers idle and embed-only load.

| What | Change |
|---|---|
| Curia container memory at rest (docker stats) | +68.9 MiB (postgres + curia), +70.7 MiB (stock, with the browser), +69.3 MiB (stock + voice) |
| Curia container anonymous memory (cgroup) | +41.6 MiB / +42.4 MiB; the rest (+50 MiB) is file-backed pages of the runtime and weights |
| Curia main process VmRSS | +62.9 to +65.9 MiB |
| Boot peak (cgroup `memory.peak`) | +71.8 to +104.0 MiB |
| Idle CPU | none measurable |
| Boot to first HTTP 200 | +0.5 to +1.4 s; the model load itself is 0.29 to 0.36 s |
| Embed latency, one short label | p50 0.80 / 0.82 ms, p95 0.97 / 1.00 ms (two runs of 200) |
| Image, amd64 unpacked layers | +123.3 MB (+123,292,829 bytes) |
| Image, amd64 pull (compressed) | +53.1 MB (+53,121,581 bytes) |
| Image, amd64 `docker image inspect` `.Size` | +176.4 MB. Docker 29's containerd store counts the compressed content and the unpacked snapshot, so this is the two lines above added together |
| Image, arm64 `.Size` (local build on Apple Silicon, not on the VPS) | +78.2 MB |

Against the ~100 MB memory budget: at rest the Curia container grows +68.9 to +70.7 MiB, inside it. The boot peak grows +71.8 MiB in the stock configuration but +104.0 MiB with only postgres and curia running, marginally over. A one-off command run inside the container that loads the model itself (here `scripts/bundled-embedder-smoke.ts`, a separate tsx process of about 176–210 MiB RSS) raises container memory transiently, by +154.8 MiB at its peak in the light-use run. The app process itself did not grow. Image growth is over the ~70 MB budget: by about 53 MB unpacked on amd64 and about 8 MB on arm64. The weights are 23.7 MB and the kept runtime binaries are 46 MB (amd64) or about 24 MB (arm64), but they ship twice. The pre-existing `chown -R curia:curia /app` layer copies every file under `/app` again, including all of `node_modules` (about 600 MB before this change, 648 MB after, measured in the amd64 image), which is the real cause of the image's size. Fixing that layer touches the #1758 store contract and is a separate follow-up. The maintainer accepted the image and boot-peak overage on 2026-11-15, with the `chown -R` layer fix tracked in #2631.

## Consequences

- A fresh install, or one whose graph is empty, has a working knowledge graph with only an Anthropic key, with no network call for embeddings and no extra container. The sensitivity classifier and the setup wizard come with it.
- Labels stay on the server by default. Nothing is billed per embedding.
- No existing install changes model on upgrade. OpenAI installs relying on the old default keep working for one more release, warned at boot and in health, and need one vault key (`embedding_api_key`) to move to explicit OpenAI.
- Switching models stays the ADR-051 step: set the variables, stop Curia, run `pnpm reembed:kg`, start.
- `/api/health` says why entity memory is off, and an endpoint that starts serving other weights under the same model name is noticed. Monitors see a `degraded` status when the knowledge graph is off, including during an operator's own re-embed.
- Image builds need Hugging Face to be reachable, and a weights change is a deliberate manifest change that turns the knowledge graph off on upgrade until a re-embed.
- The console shows the `knowledge_graph` pill but not the reason text; the reason is in `/api/health` and the boot log.

Known limits:

- **Low recall at the shipped thresholds.** 16.9% of same-name pairs auto-resolve and 11.3% of duplicate facts merge on the private set. Most true matches land in the ambiguous band for the caller to pick, and most duplicate facts stay duplicates. That is the safe direction for a small model, but duplicates are the accepted cost.
- **The committed synthetic fixture is not clean at the shipped values.** On `tests/fixtures/embedding-eval/fixture.json` they give 1 wrong resolve (of 34 different entity pairs) and 1 wrong merge (of 25 different fact pairs). The private set governs under ADR-051's policy; `fixture-structured.json` gives 0 of each.
- **Vectors differ slightly by CPU architecture.** The q8 model's int8 kernels differ between arm64 and x86_64, so the same text and weights give vectors with a cosine of about 0.997 or better across the two (0.9973 was the lowest of the three golden inputs in CI). The calibration and golden vectors were made on arm64; prod runs on amd64. A pair scoring within a few thousandths of a threshold can therefore land on the other side of it on amd64; the calibration is not exact to that precision, and the unmeasured amd64 effect on the AUCs is assumed small. A graph moved between architectures needs no re-embed.
- **English only.** MiniLM-L6 is an English model. An install that needs other languages should run a multilingual model through an endpoint.
- **The drift sample is 5 rows, and the median decides `changed`.** A single row whose stored vector no longer matches its label, such as a node-merge survivor that kept its old vector, reads as `weights_shifted` (with a warn naming the row's id) rather than turning the graph off. Three such rows out of five would turn it off. A model swap that kept three of five rows above 0.9 would read as shifted rather than changed; no measurement has shown one.
- **Sibling checkpoints are unmeasured.** A fine-tune or a sibling version served under the same model name could score between 0.9 and 0.98 and read as `weights_shifted` rather than `weights_changed`. It still shows in health.
- **The guard's year rule.** A bare 4-digit id between 1900 and 2099 counts as a year, and years yield when the two labels share a stronger token. Two labels that carry the same date and differ only in such an id (two ticket numbers in that range) are therefore not blocked, and are left to the score.
- **The guard reads a phone number with and without a `+1` country code as different.** That errs safe (a duplicate, not a wrong merge).
- **Image size** is over budget until the `chown -R` layer is fixed (#2631), as above.
