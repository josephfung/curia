# Local speech spike — results (#2469)

**Status: complete — measured on the target hosts, on the maintainer's own voice, and in live web-voice calls.**

The gate verdicts below come from two Hetzner hosts in hel1, the same location
as production. Each ran Postgres, LiveKit and an idle Curia from
`docker-compose.yml` beside the speech service:

| Host | Spec | CPU |
|---|---|---|
| cpx22 | 2 vCPU / 4 GB, the production type | AMD EPYC Genoa, AVX-512 VNNI |
| cpx32 | 4 vCPU / 8 GB | AMD EPYC Genoa, AVX-512 VNNI |

The Deepgram and Cartesia baseline ran through the same harness from cpx32, so it
includes production's network distance to those services.

The earlier Mac sections below are kept for the candidate eliminations. Their
latency figures are superseded by these.



## Live web-voice calls (2026-11-15)

Ten real calls in the console from the maintainer's laptop, on a cpx32 running
Curia built from this branch with production's `local.yaml`:

- **Brain:** voice on `claude-haiku-5-5`, as in production.
- **Transport:** LiveKit over Tailscale, served on the console's own origin as
  production serves it.
- **Script:** the same five scripted calls (date question, name and number,
  barge-in, mid-sentence pause, email address), run first on production speech
  and then on local speech.
- **Timings:** from Curia's own `voice.*` log metrics. The sample is small
  (7 user turns and 5 greetings per batch), so read p95 as "worst seen".

| `voice.*` metric | Production: Deepgram + Cartesia | Local: two-pass STT + Pocket (alba) |
|---|---|---|
| Last word → first audio (`last_word_to_audio_ms`), p50 / p95 | 2170 / 2840 ms | **1706 / 2469 ms** |
| End-of-speech wait (`end_of_speech_wait_ms`) | 1380 / 1410 ms | 930 / 1520 ms |
| First audio after the turn starts (`ttfa_ms`) | 868 / 1451 ms | 887 / 1056 ms |
| Greeting first audio, range | 560–1124 ms | 666–939 ms |
| LLM first token (same model), range | 437–694 ms | 447–636 ms |
| Barge-in detect / stop | 288 and 540 / 1–9 ms (2 barge-ins) | 30–132 / 1–4 ms (3 barge-ins) |
| Speech onsets below the barge-in level (Curia kept talking) | 8 | 0 |
| TTS starvation, playback gaps | 0 | 0 |
| Voice errors | 0 | 0 |

What the calls show:

- **Local speech answered sooner.** From the caller's last word to Curia's first
  audio, it was about 460 ms faster at p50. Most of that comes from the
  endpointing: local finalises sooner than Deepgram's `speech_final` plus the
  350 ms turn hold.
- **Greetings and LLM time match**, as expected with the same model.
- **Barge-in fired faster on local speech.** Production logged 8 speech onsets
  below the -20 dBFS barge-in level (production's setting), where Curia kept
  talking; local logged none. With this few calls, that may be how the
  maintainer spoke rather than the engines. It's worth watching once deployed.
- **Neither stack starved or errored.**

**By ear (maintainer):** local speech felt comparable to production: snappy, and
the voice was very clear and easy to understand.

- **One difference, in long answers.** On one multi-sentence answer, Pocket
  moved straight from one sentence into the next, where Cartesia paused
  naturally. A second test call sounded natural.
- **The audio rules out the obvious causes.**
  - Curia sends one sentence per TTS request on both stacks.
  - Neither stack had a delivery gap (`tts_gap_before_ms` was 0 throughout).
  - Silence at the sentence edges is similar: Pocket about 220 ms lead-in plus
    150 ms tail, Cartesia about 140 + 130 ms.
  - Pocket didn't speak faster: 13.0 characters per second over the calls,
    against Cartesia's 15.2.
  - What varies is how the sentence ending sounds. Pocket samples with a
    temperature above zero, so it differs run to run; Cartesia is steadier.
- **The greeting lost its first syllable on local speech.** The maintainer
  heard "-vening Joseph" instead of "Good evening, Joseph."
  - **It is a start-of-call race in VoiceRuntime, not Pocket.** Rendered five
    times offline, Pocket says the whole greeting with 240–340 ms of silence in
    front.
  - **The race.** Curia publishes the greeting's audio as soon as it is ready,
    without waiting for the caller to subscribe to its track, and anything sent
    before the browser has subscribed is lost.
  - **Local speech is ready sooner, so it loses more.** Measured from the
    browser joining the LiveKit room, the greeting started at +338, +11, +87,
    −41 and −151 ms. On production speech it started at +968, −29, +563, +984
    and +811 ms, so production clips occasionally too (the −29 ms call).
  - **Fix (#2470):** hold the greeting until the caller has subscribed to the
    agent's track (a LiveKit subscription event on the agent's side). A fixed
    lead-in of silence is the cruder alternative.
- **Knobs for #2470, if it recurs:**
  - A configurable pause after sentence-final punctuation, added by the
    service. Default 0; the spike rendered 250 ms and 400 ms variants.
  - A longer model-generated ending (`frames_after_eos`).
  - A lower sampling temperature (`TTSModel.load_model(temp=…)`).

## On the maintainer's own voice

These are the deciding numbers. The maintainer recorded the 30 `stt` sentences on
a laptop mic (one re-take, for s03). Each recording ran through every stack from
the same Helsinki hosts and was scored with the same canonicaliser.

| Stack | Rate | WER | Names, emails, numbers heard | End of speech → speechFinal p50 / p95 | speechFinal missing |
|---|---|---|---|---|---|
| **Two-pass: FastConformer + Parakeet final** (cpx22) | 16k | **3.6%** | **88%** | 697 / 845 ms | 0 |
| **Two-pass** (cpx22) | 48k | **3.3%** | **88%** | 669 / 775 ms | 0 |
| FastConformer alone (cpx22) | 16k | 14.2% | 62% | 441 / 491 ms | 0 |
| FastConformer alone (cpx22) | 48k | 15.8% | 60% | 422 / 451 ms | 0 |
| Deepgram nova-3, streaming (cpx32) | 16k | 12.4% | 83% | 714 / 1348 ms | 3 |
| Deepgram nova-3, streaming (cpx32) | 48k | 15.8% | 81% | 713 / 1339 ms | 4 |
| **Voice notes: Parakeet** (cpx22) | file | **3.6%** | 88% | 438 / 684 ms to process | — |
| Voice notes: Deepgram prerecorded (cpx32) | file | 3.6% | 90% | 206 / 428 ms to process | — |

What the recordings show:

- **The two-pass stack beats Deepgram's streaming transcription on this voice.**
  It makes about a third as many word errors, hears more of the names, emails
  and numbers, and finalises sooner at p50 and much sooner at p95. Deepgram also
  missed a `speechFinal` on 3–4 of 30 utterances; two-pass missed none.
- **Voice notes are a tie on WER.** Deepgram hears slightly more entities (90%
  against 88%).
- **Remaining misses on two-pass:**
  - rare names: Tomasz, Alo, Ngozi Okafor, Kenji Watanabe, Haddad, Oluwaseun
  - one email where Parakeet heard the dot as a full stop ("Lucas. Ferreira")

  Deepgram missed a different set: Raghunathan, Tomasz, Alo, Anjali Mehta,
  Haddad, "$1,250", two dates and the code K7F2Q9.
- **FastConformer alone isn't good enough on real speech** (62% of entities).
  The second pass is required, not optional.

## Verdict against the gates

The pair: **FastConformer 80 ms + Silero VAD** for STT, **Parakeet** for voice
notes, and for TTS either **Kokoro am_puck at 1.15** or **native Pocket**. All
latency figures are p50 / p95.

| Gate | Target | cpx22 (2 vCPU) | cpx32 (4 vCPU) | Cloud baseline |
|---|---|---|---|---|
| STT end of speech → `speechFinal` | p50 ≤ Deepgram + 150 (818 ms), p95 ≤ 700 ms | **451 / 541 ms** pass (48k: 437 / 475) | 451 / 537 pass | Deepgram 668 / 1365 |
| STT first interim | ≤ 300 ms from onset | 708 / 1029 miss | 712 / 1035 miss | Deepgram 404 / 1421 (also misses) |
| STT speech onset (what barge-in uses since #2401) | — | 181 / 502 | 181 / 501 | Deepgram 146 / 425 |
| STT WER | ≤ 1.5× Deepgram | 15.8% (16k), 17.5% (48k) pass (48k gate: 19.2%) | same | Deepgram 14.1% (16k), 12.8% (48k) |
| STT entities heard | listed | 60% (16k), 59% (48k) | same | Deepgram 78%, 80% |
| TTS first audio, Kokoro | p50 ≤ 300, p95 ≤ 600 ms, STT alongside | 334 / 471: **p50 misses by 34 ms** (48k: 349 / 481) | **281 / 396 pass** (48k: 305 / 409) | Cartesia 107 / 235 |
| TTS first audio, Pocket (native) | same | **136 / 160 pass** (48k: 144 / 165) | **131 / 152 pass** | |
| TTS RTF | < 0.5 | Kokoro 0.33, Pocket 0.33 pass | Kokoro 0.25, Pocket 0.44 pass | Cartesia 0.12 |
| Playback stalls | none | 0 | 0 | 0 |
| Cancel → silence | ≤ 100 ms | 1–5 ms | 1–6 ms | 1–2 ms |
| Memory (see below) | no swapping, headroom | fresh install fits; production-like doesn't | fits | — |
| By ear | maintainer | Pocket best; Kokoro am_puck at 1.15 comfortable; Piper rejected | | |

Notes on the gates:

- **Voice notes.** Parakeet scored WER 8.7% with 80% of entities heard, at
  RTF 0.075 on cpx22. Deepgram prerecorded scored 5.7%, 82% and 0.04. On real
  speech (LibriSpeech) both were 3.9%. The gap is on the synthetic accents.
- **The first-interim gate** is missed by every engine, Deepgram included. That
  matches why #2401 moved barge-in to the speech-onset event. The local onset
  event lags Deepgram's by about 35 ms.
- **Pocket ran slower with more threads.** At 4 threads on cpx32 its RTF was
  0.44, against 0.33 at 2 threads on cpx22. Pin `TTS_THREADS=2`.
- **Kokoro on 2 vCPU** misses the p50 first-audio gate by 34 ms. Its p95 and
  RTF pass with room to spare.

### Two-pass STT: Parakeet re-transcribes each finished utterance

FastConformer still drives interims, speech onset and the VAD endpoint. At the
endpoint the service re-transcribes the utterance with Parakeet (resident,
2 threads) and sends that text as the final (`SECOND_PASS=parakeet`).

| | WER (synthetic / LibriSpeech) | Entities heard | End of speech → speechFinal |
|---|---|---|---|
| FastConformer alone, cpx22 16k | 15.8% (19.5 / 3.9) | 60% | 451 / 541 ms |
| **Two-pass, cpx22 16k** | **8.1%** (9.5 / 3.4) | **79%** | 707 / 842 ms |
| **Two-pass, cpx22 48k** | **8.2%** (9.8 / 3.0) | **79%** | 680 / 828 ms |
| Two-pass, cpx32 16k | 8.1% | 79% | 724 / 871 ms |
| Deepgram nova-3, 16k / 48k | 14.1% / 12.8% | 78% / 80% | 668 / 1365 ms |

- **Accuracy.** Two-pass beats Deepgram on WER and matches it on entities, the
  gap that FastConformer alone left open.
- **Latency.** The second pass adds about 250 ms. The p50 still meets the
  relative gate (≤ 818 ms) and is close to Deepgram's own. The p95 (842 ms)
  misses the absolute 700 ms gate, but it is far better than Deepgram's p95
  (1365 ms), which misses that gate by more.
- **No gain from 4 vCPU.** cpx32 was no faster, because Parakeet runs at 2
  threads either way.
- **Memory.** The STT service holds 1.24 GB with Parakeet resident, up from
  0.3 GB for FastConformer alone. Voice notes reuse the same Parakeet, so it's
  no longer an on-demand load.
- **Hiding the delay (a #2470 design option).** VoiceRuntime already waits 350 ms
  after `speechFinal` before starting a turn (`DEFAULT_TURN_HOLD_MS`). If the
  service sent `speechFinal` at the endpoint and the second-pass text replaced it
  within that hold, the accuracy would cost nothing in latency. That needs a way
  to say "this final replaces the last one", which the event contract doesn't
  have today.

### STT while TTS generates (cpx22)

FastConformer at 16 kHz, measured while TTS generated nonstop in the same
service. That is harsher than a call, where Curia speaks in bursts.

| TTS running | End of speech → speechFinal | WER |
|---|---|---|
| None | 451 / 541 ms | 15.8% |
| Kokoro | 462 / 563 ms | 15.8% |
| Pocket (native, 2 threads) | 452 / 538 ms | 15.8% |

Neither TTS engine affects recognition on 2 vCPU.

### Voice choice (maintainer, 2026-11-15)

- **Pocket is the voice: "a great substitute for Cartesia".** Kokoro am_puck at
  1.15 is decent, but not as smooth.
- **Default voice: alba** (CC BY 4.0), which the maintainer will also use in
  production. It sounds male to him; the source recording is credited to Alba
  MacKenna, so the docs describe voices by name, not gender.
- **Documented alternative: eve** (VCTK p361, CC BY 4.0).
- **The curated set shown in setup** is alba, eve, michael, george, jane (CC BY
  4.0) and caro_davy (CC0).
- **Operator override.** Operators can name any other voice outside the wizard:
  another catalog voice, or a file in the models volume, resolved server-side.
  Its licence is then theirs to check.
- **Licence-safe English Pocket voices:**
  - alba
  - VCTK, CC BY 4.0: anna, vera, fantine, charles, paul, eponine, azelma,
    george, mary, jane, michael, eve
  - voice-donations, CC0: marius, javert
  - voice-zero / LibriVox, CC0: bill_boerst, peter_yearsley, stuart_bell,
    caro_davy
  - Excluded as non-commercial: cosette (Expresso) and jean (EARS).
- **Normaliser for Pocket.** Pocket reads digits itself, but on T04 the
  normaliser fixed a garbled email and a dropped phone digit. Run Pocket's
  input through it.

### Memory on the hosts

Peak host memory in use, sampled every 5 s, with a fresh idle Curia (498 MB):

| cpx22 (3.8 GB) | Host memory in use |
|---|---|
| Stack alone | 1.2 GB |
| Stack + speech service (FastConformer + Kokoro, 750 MB) | 1.9 GB |
| …plus Parakeet loaded for voice notes (1.0 GB) | 2.9 GB |
| Pocket service on its own | 1.25–1.43 GB RSS |

FastConformer + Pocket would be about 1.75 GB, against 0.75 GB for FastConformer + Kokoro.

These figures are for a fresh install. Production is heavier: curia-deploy#310
recorded the production curia container idling at 1.29 GB under a 2 GB cap, and
the separate browser container (#2541) wasn't published yet so couldn't be
measured. So on a 4 GB host:

- **A fresh install** fits FastConformer + Kokoro, with Parakeet loaded only
  while a voice note is transcribed.
- **A production-like install** doesn't fit: about 2.2–2.5 GB of base stack,
  plus 0.75 GB of resident speech, plus 1 GB of Parakeet on demand, plus
  browser peaks.
- **Pocket** doesn't fit a 4 GB host beside a production-like Curia.

### Minimum host

| Setup | Minimum host |
|---|---|
| Local STT + Kokoro TTS + on-demand Parakeet | **4 vCPU / 8 GB**. 2 vCPU / 4 GB works on CPU (only Kokoro's p50 first audio misses, by 34 ms) but has no memory headroom for a working Curia. |
| Local STT + Pocket TTS | **4 vCPU / 8 GB**, for memory; CPU would fit 2 vCPU. |
| A smaller host | Use a fallback: cloud TTS (Cartesia) with local STT, or local voice notes only. |

Rerun instructions: [README.md](README.md). Raw results: `results/`.

## What changed in the candidate list, and why

| Candidate | What happened |
|---|---|
| Kokoro via sherpa-onnx | **Dropped.** sherpa-onnx 2.0 removed espeak-ng (GPL) and is lexicon-only. It silently skips every word missing from the lexicon: "Priya", "Raghunathan", "3", "30" and "18th" all vanished from one sentence. |
| Kokoro via Moonshine's runtime | **Kept, as the Kokoro candidate.** `moonshine-voice` ships Kokoro voices with an MIT neural G2P that handles unknown names. That G2P does no text normalisation, though: "3:30 PM" came out as nonsense. The service runs a spoken-form normaliser first (`service/normalize.py`, which handles times, dates, ordinals, phone numbers, emails, money and years). |
| Piper (lessac) | **Dropped on licence.** The Lessac voice's dataset is research-only. sherpa-onnx 2.0 also can't phonemise Piper voices without the GPL piper-phonemize. |
| Piper (LJSpeech) on Moonshine's runtime | **Kept as the lightweight fallback.** The LJSpeech data is public domain. It uses the same normaliser. |
| Pocket TTS via sherpa-onnx | **Fails first audio.** sherpa-onnx's Pocket port invokes its callback once, at the end of a sentence, so it doesn't stream and cancel never lands mid-sentence. The native PyTorch `pocket-tts` does stream (first chunk about 290 ms warm on 2 cores), but its image is 1.84 GB and its RTF was about 0.73 on 2 cores. |
| Zipformer | Two builds were tested. **2023-06-21** (LibriSpeech + GigaSpeech) is the accurate one, but GigaSpeech's audio is licensed for non-commercial research only, so its provenance is weaker. **2023-06-26** (LibriSpeech only) has clean provenance but scored WER 31.6%. |
| **NeMo FastConformer streaming (added)** | Added under the issue's rule: Zipformer fails for a reason a different model fixes, since the licence-clean build is inaccurate and its 640 ms chunks delay interims. `nvidia/stt_en_fastconformer_hybrid_large_streaming_80ms`, transducer head, int8, CC-BY-4.0. Two lookaheads were tested, 80 ms and 480 ms. |
| Moonshine streaming | Three sizes were tested. **medium** was slower and no more accurate than small on the first fixtures, so it was dropped. tiny and small were run in full. |

## Streaming STT (Mac, candidate selection)

16 kHz, all 80 fixtures, Mac, unpinned. Each speech service ran beside three
other STT runs, so the latency here is contended. Pinned 2-core and 4-core
numbers are in [Host sizes](#host-sizes). Every engine uses the same Silero VAD
endpointer (400 ms of silence, the same setting as Deepgram's
`endpointing=400`). That choice is explained under [Events](#events).

| Engine | WER % (synthetic / LibriSpeech) | Entities heard | onset → speechStarted p50/p95 | onset → first barge-in interim p50/p95 | end of speech → speechFinal p50/p95 | speechFinal missing |
|---|---|---|---|---|---|---|
| FastConformer 80 ms | 15.7 (19.3 / **3.9**) | 60% | 182 / 503 | 722 / 1041 | **454 / 550** | 1 |
| FastConformer 480 ms | 21.5 (23.4 / 15.3) | 47% | 183 / 503 | 1135 / 1149 | 454 / 537 | 1 |
| Moonshine small | **11.7** (13.7 / 4.9) | **71%** | 182 / 504 | 539 / 1258 | 1252 / 1737 | 10 |
| Moonshine tiny | 17.0 (20.2 / 6.4) | 69% | 182 / 504 | 385 / 963 | 941 / 1623 | 2 |
| Zipformer (Libri+Giga) | 18.0 (19.6 / 12.8) | 68% | 182 / 501 | 700 / 1042 | 453 / 541 | 0 |
| Zipformer (Libri only) | 31.6 (36.0 / 17.2) | 53% | 182 / 502 | 758 / 1083 | 461 / 534 | 1 |
| Deepgram nova-3 (cpx32, hel1) | 14.1 (16.2 / 7.4) | 78% | 146 / 425 | 404 / 1421 | 668 / 1365 | 6 |

How to read the table:

- **WER** is scored after one spoken-form canonicaliser (`scoring.ts`), so a
  formatting difference such as "3:30 PM" against "three thirty p m" is not
  counted as an error.
- **Synthetic voices are harsher than they look.** The robotic accents carry
  most of the errors: Rishi (en_IN) and Tessa (en_ZA) sit at 25–35% for every
  engine, while Samantha (en_US) sits at 2–12%. LibriSpeech is real read speech.
- **Entities** are counted as heard only when the exact spoken form appears.
  The misses are mostly names that are uncommon in English
  (Raghunathan, Delacroix, Okafor, Oluwaseun) and email addresses. Every engine
  misses most of them. Deepgram's figure on the same fixtures will show how much
  of this is the synthetic voices and how much is the models. (It did: Deepgram heard 78% on the same fixtures.)
- **Moonshine finalises slowly.** Its best text comes only from a forced
  re-decode at the endpoint, which takes about 350 ms on small. Closing the line
  on the last pass's text instead ("fast final") cut the delay but raised small's
  WER from 21% to 34% on a 12-fixture slice, because the partial passes contain
  repetitions ("7pmpmpm.com"). Under CPU contention its passes also stretch, and
  it falls behind real time: 10 of 80 utterances got no `speechFinal` before the
  stream closed.

## Events

This answers the issue's question 3.

| | Moonshine | Zipformer / FastConformer (sherpa-onnx online) |
|---|---|---|
| Interims | Yes, one per transcription pass (0.25 s floor, more under load). Text is cased and punctuated. | Yes, one per decoded chunk: about every 160 ms for FastConformer and 640 ms for Zipformer. Text is lower case with no punctuation. |
| `isFinal` / `speechFinal` | Its own VAD line segmentation closes a line about 1 s after speech ends, which is too slow. | sherpa's trailing-silence rule takes about 1 s, which is also too slow. |
| Endpointing used | **Silero VAD in the service** (MIT): 400 ms of silence after speech emits `isFinal` + `speechFinal`. This is the same rule for every engine. | The same Silero VAD rule. |
| Speech onset (`onSpeechStarted`) | Silero VAD, which needs 100 ms of voiced audio before it fires. p50 182 ms after true onset. | The same. |
| `speechStartedAgoMs` / `speechEndedAgoMs` | From the line span. The end is about 300 ms late because the line includes VAD padding. | From token timestamps. The end is about 150 ms off (FastConformer). |
| `confidence` | None. | None. |

Notes on the events:

- **Confidence.** VoiceRuntime treats a missing confidence as confident
  (`voice-runtime.ts:919`), so with a local engine only the 3-character length
  gate guards barge-in on transcripts. Onset barge-in (#2401) is guarded by the
  caller's level, so the missing confidence matters less than it used to.
- **The barge-in interim gate (first interim ≤ 300 ms from onset) is not met by
  any local engine.** But since #2401, VoiceRuntime barges in on the
  speech-onset event, because waiting for an interim cost "~1.2 s on calls" with
  Deepgram. On that event every engine is at 182 ms p50. The Deepgram baseline
  will show whether its interims meet 300 ms at all.

## Voice notes (batch STT, Mac)

Mac, all 80 fixtures, each sent as a WAV file.

| Engine | WER % (synthetic / LibriSpeech) | Entities heard | processing p50 / p95 | RTF | RSS |
|---|---|---|---|---|---|
| **Parakeet TDT 0.6B v2 int8** | 10.1 (12.1 / 3.4) | **79%** | 597 / 885 ms | **0.11** | 930 MB |
| whisper.cpp base.en q5_1 | 14.6 (16.6 / 7.9) | 64% | 1795 / 1940 ms | 0.29 | 240 MB |
| whisper.cpp small.en q5_1 | 8.4 (9.5 / 4.9) | 77% | 6436 / 6792 ms | 1.05 | — |
| Deepgram nova-3 prerecorded (cpx32, hel1) | 5.7 (6.2 / 3.9) | 82% | 206 / 435 ms | 0.04 | — |

Parakeet is the voice-note pick on accuracy and speed. Its 930 MB of memory is
the cost. Voice notes are not real-time, so the service can load it on demand
(2.7 s) and drop it when idle, rather than keep it resident.

## TTS (Mac, candidate selection)

Mac, unpinned, with a FastConformer STT session streaming beside it. Three
reps × 12 sentences, plus 5 cancels. Pinned numbers are in [Host sizes](#host-sizes).

| Engine | Rate | first audio p50 / p95 | RTF p50 / p95 | sentences with a playback stall | cancel → silence |
|---|---|---|---|---|---|
| Kokoro (Moonshine) | 24k | 640 / 842 ms | 0.60 / 0.72 | 20 of 36 | 1 / 2 ms |
| Kokoro (Moonshine) | 48k | 698 / 1028 ms | 0.69 / 0.86 | 32 of 36 | 0 / 2 ms |
| Piper LJSpeech | 24k | 399 / 643 ms | 0.40 / 0.53 | 4 of 36 | 1 / 4 ms |
| Piper LJSpeech | 48k | 410 / 901 ms | 0.40 / 0.79 | 6 of 36 | 1 / 4 ms |
| Pocket (sherpa-onnx) | 24k | 1065 / 1490 ms | 0.37 / 0.47 | 0 (one chunk) | never mid-sentence |
| Pocket native (PyTorch), cpx22 | 24k | 136 / 160 ms | 0.33 / 0.37 | 0 | 1 / 4 ms |
| Cartesia sonic-3.5 (cpx32, hel1) | 24k | 107 / 235 ms | 0.12 / 0.16 | 0 | 1 / 2 ms |

Notes on these numbers:

- **The unpinned Mac numbers here are pessimistic for Kokoro.** Moonshine's TTS
  runtime starts a thread per core, and on 20 cores beside another container it
  oversubscribed: the container showed 2400% CPU. Unloaded, the same model
  produced a first chunk in 267 ms at RTF 0.39. The pinned runs are the ones to
  read.
- **Cancel** is immediate for every engine that streams, because the provider
  aborts the HTTP stream and the service stops generating on the next chunk.
  - The figure measures the client only: from `cancel()` to the iterator ending.
  - A service that kept generating behind the engine lock would show up
    instead as a slower first audio on the next sentence. No run showed that.

### Intelligibility round trip

Each saved 24 kHz sentence was transcribed by Parakeet and scored against its
text. This is a stand-in for listening, not a replacement: it catches dropped
words and misread numbers, emails and names, but not prosody.

| Voice | Round-trip WER | Typical misses |
|---|---|---|
| Cartesia (production, from hel1) | **3.0%** | It spelled the email "PRIYA. R … dot CCA" |
| Pocket native, alba (hel1) | 7.7% | Garbled the email ("Priya, Rowbridge, Ka"), **dropped a digit from the phone number**, and misread some names |
| Kokoro am_puck 1.15 + normaliser (hel1) | 11.8% | Rare names, and the speed-up blurs a few words ("Got it bossed") |
| Kokoro af_heart 1.0 + normaliser (Mac, round one) | 7.1% | Rare names ("Reginathan"), "Q3" heard as "X", ".ca" heard as "c" |
| Pocket (no normaliser) | 14.8% | Reads digits itself, but read "3:30" as "3", "$1,250" as "$1,050", and garbled the email |
| Piper LJSpeech + normaliser | 24.9% | Mumbled names, and "Boss" heard as "Bos" |

The by-ear page puts these side by side (link in the PR). The Cartesia column
fills in once the baseline runs.

## By ear (maintainer, 2026-11-15)

**Round one** (12 lines at 24 kHz: Kokoro af_heart, Pocket alba, Piper LJSpeech):

- **Pocket is the best.** Its tempo and clarity are right.
- **Kokoro and Piper are passable**, but their tempo is somewhat awkward.
- **Piper is out.** It sounds tinny and slightly mispronounced.
- Every voice had minor pronunciation hiccups:

| Line | What happened |
|---|---|
| T04 | Pocket read the email as a sentence: "." became a pause and "r@oakbridge" a word. Kokoro and Piper said ".ca" as "dot sea". |
| T05 | Pocket mispronounced "Siobhan", and Piper mispronounced "Q3". |
| T06 | Pocket rushed "$1,250" until it was hard to hear. |
| T08 | Kokoro and Piper said "AM" as "am". |
| T10 | Piper said "Accenture" as "accench". |
| T12 | Pocket rushed "Got it" until it sounded like "getout". |

**Round two** (five lines: Kokoro in male voices at speeds 1.1–1.25, beside Pocket):

- **Kokoro am_puck at speed 1.15 is the most pleasant overall**, and a comfortable option.
- The one exception is T12. Pocket pauses briefly after "Got it, Boss." in a more natural way, where Kokoro runs straight into the next sentence. That isn't a dealbreaker.
- The normaliser spelled the letter A as "ay", which Kokoro read as "eye". The G2P reads only "ae" as "eɪ", so the normaliser now uses "ae".

Speed is tunable for Kokoro only: a single multiplier (`KOKORO_SPEED`). Pocket has
no speaking-rate parameter, so its pace comes from the voice prompt.

**Latency of the preferred voice (Kokoro am_puck, 1.15), Mac, single-threaded, 24 kHz:**

| Setup | First audio p50 / p95 | RTF p50 / p95 |
|---|---|---|
| Alone | 464 / 715 ms | 0.42 / 0.51 |
| STT streaming in the same process | 606 / 877 ms | 0.60 / 0.75 |
| STT streaming in a separate container | 658 / 898 ms | 0.67 / 0.79 |

As measured, every setup misses the first-audio gate (p50 ≤ 300 ms, p95 ≤ 600 ms),
and the runs with STT alongside miss RTF < 0.5 as well. Splitting STT into another
container didn't help, even with both containers near idle on 20 cores, so this
looks like Moonshine's spinning thread pool interacting with Docker Desktop's VM
rather than real CPU demand. The verdict needs a Linux host.

## Host sizes on the Mac (superseded by the VPS runs)

The two VPS runs are still to do. On this Mac, the speech service was pinned to
two cores (`--cpuset-cpus=0,1`), with FastConformer, Kokoro and Piper in one
process.

| Engine | Rate | WER % (synthetic / LibriSpeech) | onset → speechStarted | onset → barge-in interim | end of speech → speechFinal | speechFinal missing |
|---|---|---|---|---|---|---|
| FastConformer 80 ms | 16k | 15.7 (19.3 / 3.9) | 182 / 503 | 723 / 1044 | **454 / 550** | 1 |
| FastConformer 80 ms | 48k (Signal path) | 17.5 (20.7 / 6.9) | 184 / 560 | 722 / 1042 | **441 / 482** | 2 |

What these runs show:

- **FastConformer is unaffected by two cores.** Its numbers match the unpinned
  run, and the container sat at about 30% of one core while streaming. It runs
  single-threaded (`STT_THREADS=1`).
- **The 48 kHz path costs accuracy.** LibriSpeech WER rose from 3.9% to 6.9%.
  The LibriSpeech clips are 16 kHz originals, upsampled to 48 kHz and back
  down, and the service uses libsamplerate's fastest converter. #2470 should
  use a better converter (`sinc_medium`) and recheck.
- **Moonshine's TTS can't be measured under Docker CPU limits.** Pinned or
  quota-limited, Kokoro and Piper on Moonshine's runtime ran about 10× slower
  (RTF 3–4, first audio about 4 s), even with `MOONSHINE_ORT_SINGLE_THREAD=1`.
  Unpinned and single-threaded, the same models run at RTF 0.33 (Kokoro) and
  0.23 (Piper), with first audio at 300–400 ms. The likely cause: the runtime
  sizes ONNX Runtime's spinning thread pool from the 20 host cores it can see,
  not from the two it is allowed, and it exposes no option to set the thread
  count. A real 2-vCPU VM reports two cores, so the VPS run is the only valid
  measure. This is the issue's warning about Docker CPU limits, here in the
  pessimistic direction.
- **A thread-controllable fallback was tried and was slower.** sherpa-onnx's
  Kokoro (int8) fed with Moonshine's phonemes respects `num_threads`. On two
  cores it ran at RTF 0.96, and it doesn't stream within a sentence.

Provisional reading, until the VPS runs:

- FastConformer + Silero easily fits two vCPUs.
- Kokoro on Moonshine needs about one core at RTF 0.33. It should fit beside
  STT on two vCPUs, but the margin for first audio (about 300–400 ms, against
  a 300 ms p50 gate) is thin.
- Memory, not CPU, is the likely limit on the 2 vCPU / 4 GB host (see
  [Footprint](#footprint)).

## Footprint

| | Image | Model files loaded | RSS warm (per engine, own process) | Cold load |
|---|---|---|---|---|
| Service base (Python, FastAPI, sherpa-onnx, ffmpeg) | sherpa 730 MB; moonshine 782 MB; whisper 747 MB | — | about 150 MB of each figure below | — |
| FastConformer 80 ms | (sherpa) | 134 MB | 310 MB | 1.7 s |
| Zipformer (Libri+Giga) | (sherpa) | 195 MB | 338 MB | 1.5 s |
| Moonshine tiny / small | (moonshine) | 43 / 138 MB | 294 / 535 MB | 0.3 / 0.5 s |
| Parakeet TDT 0.6B int8 | (sherpa) | 633 MB | 930 MB | 2.7 s |
| whisper.cpp base.en | (whisper) | 60 MB | 240 MB | 0.2 s |
| Kokoro (Moonshine runtime) | (moonshine) | 81 MB + 53 MB G2P | 600 MB | 0.7 s |
| Piper LJSpeech (Moonshine runtime) | (moonshine) | 28 MB + G2P | 464 MB | 1.0 s |
| Pocket int8 (sherpa) | (sherpa) | 208 MB | 670 MB | 0.7 s |
| Silero VAD | (all) | 0.6 MB | — | — |

Notes on the footprint:

- **One process serving FastConformer and Kokoro measured 673 MB** after loading.
- **About 400 MB of each image is ffmpeg** and its Debian libraries. ffmpeg is
  only needed to decode voice notes, and a static ffmpeg build or PyAV could
  shrink it.
- **Production memory context.** curia-deploy#310 recorded the prod host
  (2 vCPU, 3.7 GiB) with the curia container idling at 1.29 GB under a 2 GB
  cap, and OOM-killed during browser work. Adding about 0.7 GB of resident
  speech service (plus Parakeet on demand) leaves no headroom on that host for
  browser peaks. A memory measurement of the stack on the spike hosts is still
  to do.

## Licences

| Component | Code | Weights | Conditions | Verdict |
|---|---|---|---|---|
| sherpa-onnx 2.0.1 | Apache-2.0 | — | Pin ≥ 2.0. 1.x wheels bundle espeak-ng (GPL-3.0). | OK |
| onnxruntime | MIT | — | | OK |
| moonshine-voice 0.1.6 | MIT | English streaming STT: MIT | Non-English legacy models use a non-commercial community licence. Don't use them. | OK |
| Moonshine's Kokoro / Piper TTS assets | MIT runtime | Kokoro-82M Apache-2.0; LJSpeech public domain | The licence on Moonshine's own repackaged `.ort` Kokoro assets is not stated separately. To verify. | OK, pending that check |
| NeMo FastConformer streaming (sherpa int8) | Apache-2.0 | CC-BY-4.0 | Attribution to NVIDIA | OK with attribution |
| Parakeet TDT 0.6B v2 | Apache-2.0 | CC-BY-4.0 | Attribution to NVIDIA | OK with attribution |
| Zipformer 2023-06-21 | Apache-2.0 | Apache-2.0 tag | Trained on GigaSpeech, whose audio is licensed for non-commercial research only | Weaker provenance, avoid |
| Zipformer 2023-06-26 | Apache-2.0 | Apache-2.0 (LibriSpeech, CC BY 4.0) | | OK, but inaccurate |
| whisper.cpp + Whisper weights | MIT | MIT | | OK |
| Pocket TTS | MIT | CC-BY-4.0; the cloning weights are gated | Prohibited-use terms (no impersonation). The catalog voices vary: alba is CC BY 4.0, voice-donations are CC0, cosette/jean are CC BY-NC. The sherpa archive's README says "non-commercial" but ships a CC BY 4.0 LICENSE. | OK with conditions |
| Piper (lessac) | MIT (archived) or GPL-3.0 (piper1) | Lessac dataset: research only | | **No** |
| Silero VAD | MIT | MIT | | OK |
| espeak-ng | GPL-3.0 | — | Not needed: sherpa-onnx ≥ 2.0 and Moonshine both avoid it. Shipping it in a published image would trigger GPL source obligations. | Avoid |

## Does the contract fit?

Yes, unchanged.

- **The interfaces.** `LocalSttProvider` and `LocalTtsProvider` implement
  `SpeechToTextProvider`, `BatchSpeechToTextProvider` and `TextToSpeechProvider`
  as they are. The service emits Deepgram-shaped events, so the provider is a
  thin translation, as `DeepgramSttProvider` is.
- **What a local provider skips.** It needs no KeepAlive and no language
  parameter.
- **Resampling.** It lives in the service: 48 kHz in to 16 kHz for the models,
  and the 24 kHz native voice out to 48 kHz for Signal, using libsamplerate
  (BSD-2).
- **Not prototyped.** `BatchTextToSpeechProvider.synthesizeToFile` was not
  built. A WAV file is a header plus PCM; MP3 needs an encoder in the container.

## For #2470

Implementation-plan changes, drafted, to be folded in when the verdict is final:

- **Text normalisation is required for the G2P voices.** Kokoro and Piper are
  unusable on numbers, times and emails without it, and Pocket also misreads
  some. Add it to the provider and test it.
- **Endpointing.** Silero VAD (400 ms) for `speechFinal` and onset, the same for
  every engine. The engine's own endpointing is about 1 s, which is too slow.
- **Confidence.** No local engine reports one. Either synthesise one or accept
  that the length gate is the only transcript guard.
- **STT is two-pass**: FastConformer for interims, onset and endpointing, and
  Parakeet for the final text. Parakeet stays resident and also serves voice
  notes.
  - Consider adding a "replaces previous final" event, so the second pass can
    land inside VoiceRuntime's 350 ms turn hold instead of in front of it.
- **TTS is native Pocket** (`pocket-tts` 4.x, the version tested)
  at `TTS_THREADS=2`, with alba as the default voice and eve documented.
  - Voice selection uses the existing `voiceId` setting, checked against a
    licence-safe allowlist.
  - The setup wizard's identity step gets a voice picker with the six curated
    voices (alba, eve, michael, george, jane, caro_davy). Its previews speak
    the assistant's name and are rendered server-side from a fixed sentence,
    so the endpoint can't be used as an open TTS service.
  - An operator override outside the wizard accepts any other catalog voice, or
    a voice file in the models volume, resolved server-side by name.
  - Pre-fetch the weights and voices at install time.
  - Add a sentence-pause setting (default 0), and consider a lower Pocket
    temperature, in case the run-on endings the maintainer heard once recur.
- **Hold the greeting until the caller has subscribed to Curia's audio track.**
  Local speech is fast enough to beat the browser's subscription, which clipped
  "Good e-" from 4 of 5 greetings. Production clips occasionally for the same
  reason.
- **One `curia-speech` image** (about 1.9 GB) serves FastConformer, Parakeet,
  Pocket and Kokoro. Publish it only when `service/` changes.
- **Pin sherpa-onnx ≥ 2.0** (the GPL-free release), and keep espeak-ng out of
  the image.
- **Image size.** Replace Debian's ffmpeg with a static build, or decode with
  PyAV.
- **Thread control.** Moonshine's runtime gives no way to set ONNX Runtime's
  thread count, and it collapses under container CPU limits. Production compose
  files often set CPU limits, so either confirm upstream behaviour on a real
  small VM or get a thread option added upstream before relying on it.
- **Resampling quality.** Use a better libsamplerate converter for 48 kHz → 16 kHz.
