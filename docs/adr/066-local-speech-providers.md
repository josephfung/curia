# ADR-066: Local speech providers (amends ADR-037)

Date: 2026-11-15
Status: Proposed — measured on the target hosts, on the maintainer's own voice and in live calls against the production speech stack; voice chosen by the maintainer (#2469)

## Context

ADR-037 made Deepgram (STT) and Cartesia (TTS) the voice defaults, behind the
`SpeechToTextProvider` / `TextToSpeechProvider` interfaces in `src/speech/types.ts`.
Without both keys, Curia turns off the voice channel, Signal calls and
voice-note transcription. That means a new install needs two more vendor
accounts before voice works at all. It also means principal audio leaves the
host.

Spike #2469 asked whether local models, running in a separate container on a
CPU-only host beside Postgres, LiveKit and Curia, are fast and good enough to be
the default. The candidates were:

- **Streaming STT:** Moonshine streaming and sherpa-onnx Zipformer. NeMo
  FastConformer streaming was added once Zipformer failed.
- **Voice-note STT:** Parakeet TDT 0.6B and whisper.cpp.
- **TTS:** Kokoro-82M, Kyutai Pocket TTS, and Piper as a lightweight fallback.

Each ran through the real provider interfaces in a harness
(`scripts/spikes/local-speech/`), against gates set relative to the cloud
baseline. The full numbers are in that folder's `RESULTS.md`.

The findings that shape the decision. Latency and memory were measured on
Hetzner cpx22 (2 vCPU / 4 GB, the production type) and cpx32 (4 vCPU / 8 GB)
in hel1, with the Curia stack running alongside:

- **The interfaces fit unchanged.** A thin provider talks to a speech service
  that emits Deepgram-shaped events.
- **No local engine's own endpointing is fast enough.** Moonshine and sherpa
  both take about 1 s to close an utterance. A Silero VAD endpointer in the
  service, using the same 400 ms of silence as Deepgram, brings end of speech
  → `speechFinal` to 451 ms p50 and 541 ms p95 on 2 vCPU. Deepgram measured 668
  and 1365 ms from the same host. Silero supplies the speech-onset event in 181 ms
  (Deepgram: 146 ms).
- **Streaming STT accuracy against latency.** Moonshine small is the most
  accurate on accented synthetic speech. But it finalises slowly (a forced
  re-decode) and falls behind real time under CPU contention. NeMo FastConformer
  80 ms is the most accurate on real read speech (3.9% WER on LibriSpeech),
  keeps up, and endpoints fastest. Its overall WER (15.8%) is within the gate of
  1.5× Deepgram's (14.1%). But it hears fewer names, emails and numbers: 60%,
  against Deepgram's 78%. The licence-clean Zipformer (LibriSpeech only)
  is too inaccurate. The accurate one was trained on GigaSpeech, whose audio is
  licensed for non-commercial research only.
- **Voice notes.** Parakeet TDT 0.6B is the most accurate local option. It
  scored WER 8.7% with 80% of entities heard, against Deepgram's 5.7% and 82%,
  at 0.075× real time. But it holds about 1 GB resident.
- **TTS needs text normalisation.** sherpa-onnx ≥ 2.0 dropped espeak-ng (GPL),
  and its Kokoro silently skips names and digits. Kokoro on Moonshine's runtime
  has an MIT G2P that handles names but not numbers or emails. With a
  spoken-form normaliser in front it is intelligible. On 2 vCPU it starts
  speaking in 334 ms p50 and 471 ms p95, at RTF 0.33. That misses the 300 ms
  p50 gate by 34 ms. It passes on 4 vCPU (281 / 396 ms).
- **Pocket TTS sounds best to the maintainer.** Natively (PyTorch, streaming)
  it starts speaking in 136 ms on 2 vCPU, close to Cartesia's 107 ms. But it
  holds about 1.3–1.4 GB and needs a 1.9 GB image. The sherpa-onnx port doesn't
  stream. Pocket reads digits itself, but it garbled an email and dropped a
  digit from a phone number.
- **Piper's usual voice (Lessac) is research-only.** Its LJSpeech voice is
  public domain, but the least intelligible.
- **Memory decides the host size.** On cpx22, a fresh idle stack plus
  FastConformer and Kokoro peaked at 1.9 GB of 3.8. With Parakeet loaded as
  well, it peaked at 2.9 GB. Production's Curia idles about 0.8 GB higher
  (curia-deploy#310), and browser work comes on top of that.
- **Live calls.** Five calls on each stack, with Curia built with a provider
  switch and production's config. Local speech reached first audio about 460 ms
  sooner after the caller's last word (p50 1706 ms, against 2170 ms for
  Deepgram + Cartesia). Neither stack had playback gaps or errors.

## Decision

*Proposed. Supported by the measurements and the maintainer's listening.*

1. **A separate speech-service container** (Python, sherpa-onnx ≥ 2.0 and
   moonshine-voice, no GPL components), started by a compose profile. Curia talks
   to it through `LocalSttProvider`, `LocalTtsProvider` and
   `LocalBatchSttProvider`, which implement the existing interfaces. Deepgram
   and Cartesia stay as optional providers, chosen separately for STT and TTS.
   - **Exposure.** Its endpoints are unauthenticated, so the service is
     reachable only on an internal compose network.
     - There is no published `ports:`, and the network has no egress once the
       models are pre-fetched.
     - It runs as a non-root user with the models volume mounted read-only.
     - A shared-secret header between Curia and the service is optional
       defence in depth.
   - **Input hardening.** Voice notes come from outside senders.
     - ffmpeg decodes stdin only (`-protocol_whitelist pipe`), from an allowlist
       of containers, with a duration cap and a timeout. That stops playlist
       tricks that fetch URLs or local files.
     - Sample rates are allowlisted, and text, body size, session length and
       queues are bounded.
     - Voice names are resolved only by the server: an allowlist, or a basename
       checked against the models volume, never a path or URL from a request.
     - Pin package versions and check model checksums.
2. **Streaming STT, two-pass.**
   - **NeMo FastConformer streaming 80 ms** (int8, CC-BY-4.0) produces interims.
   - **Silero VAD** in the service produces speech onset and endpointing (400 ms
     of silence → `isFinal` + `speechFinal`).
   - At each endpoint, **Parakeet TDT 0.6B v2** (int8, CC-BY-4.0) re-transcribes
     the utterance, and its text is the final.
   - **Measured on the maintainer's own voice** (30 recorded sentences, 2 vCPU):
     WER 3.6% and 88% of names, emails and numbers heard, against Deepgram
     streaming's 12.4% and 83%. End of speech → `speechFinal` is 697 / 845 ms,
     against Deepgram's 714 / 1348 ms. The p95 misses the 700 ms ceiling; the
     second pass can move inside the turn hold (see Consequences).
   - **On the synthetic accents and LibriSpeech:** WER 7.6% and 81%, against
     Deepgram's 13.9% and 79%.
   - The endpointing and second-pass rules live in the service, the same for any
     engine, so a model can be swapped without touching VoiceRuntime.
3. **Voice notes: the same resident Parakeet.**
4. **TTS: Kyutai Pocket TTS, native (PyTorch, streaming), two threads.**
   - Input goes through the spoken-form normaliser: times, dates, ordinals,
     phone numbers, emails, money and years, with letters spelled by name.
     Pocket reads digits itself, but the normaliser fixes emails and long digit
     strings.
   - **Default voice: alba** (CC BY 4.0). **Documented alternative: eve**
     (VCTK, CC BY 4.0).
   - **Curated set of six**, chosen by the maintainer: alba, eve, michael,
     george, jane (CC BY 4.0) and caro_davy (CC0).
     - The setup wizard's assistant-identity step shows these six as cards,
       with alba preselected and previews that speak the assistant's name.
       Previews are rendered server-side from a fixed sentence.
     - Settings → Personality offers the same picker later; a change applies
       to the next call.
   - **Operator override, outside the wizard.** An operator can name any other
     voice, either another Pocket catalog voice or a voice file they place in
     the models volume.
     - Only the server resolves voice names. A request never carries a path
       or URL.
     - The licence is then the operator's responsibility. The docs list which
       catalog voices are non-commercial (cosette, jean).
   - Voice cloning, whose weights are gated, is not offered.
   - **Kokoro-82M** (am_puck at 1.15) stays as the light option for hosts where
     Pocket's memory doesn't fit.
   - **Piper is rejected.** It failed by ear, and its usual voice (Lessac) has a
     research-only dataset licence.
5. **Minimum host for local voice: 4 vCPU / 8 GB** (Hetzner cpx32 class).
   - **CPU** is not the limit: the STT and both TTS options run on 2 vCPU.
   - **Memory** is the limit. A production-like Curia plus local speech
     doesn't fit in 4 GB.
   - **A 2 vCPU / 4 GB install** falls back to local STT with Cartesia TTS, or
     to local voice-note transcription only.

## Consequences

- **A new install can have voice with no speech API keys**, and principal audio
  and transcripts stay on the host. That reverses ADR-037's privacy consequence
  for installs that use local speech.
- **Attribution.** The FastConformer and Parakeet weights are CC-BY-4.0, so the
  docs and the service image must credit NVIDIA. The Kokoro assets that Moonshine
  repackages need their licence confirmed before release.
- **Text normalisation becomes Curia's job.** Cartesia normalises server-side;
  a local G2P voice does not. The normaliser needs tests for the forms
  principals hear most: times, dates, phone numbers and email addresses.
- **No local engine reports a confidence.** With local STT, barge-in on
  transcripts is guarded only by the 3-character gate. Onset barge-in (#2401)
  is guarded by the caller's level, as before.
- **Names and numbers need the second pass.** FastConformer alone heard 60% of
  names, emails and numbers on synthetic voices (62% on the maintainer's voice).
  Re-transcribing each utterance with Parakeet brings that to 81% (88% on the
  maintainer's voice), beating Deepgram, at about 250 ms of added latency.
  - A "replaces previous final" event would let the second pass finish inside
    VoiceRuntime's 350 ms turn hold instead.
- **The speech service adds about 2.6 GB resident with Pocket**: FastConformer
  0.3 GB, Parakeet about 0.95 GB (now resident for the second pass), and Pocket
  1.25–1.4 GB. With Kokoro instead, it adds about 0.75 GB. That memory is what
  sets the 8 GB minimum.
- **A third published image.** `curia-speech` is about 1.9 GB per architecture,
  mostly PyTorch and Debian's ffmpeg; the Curia image itself doesn't grow.
  - It joins `docker-publish.yml`'s matrix (amd64 and arm64, signed, with an
    SBOM) and `trivy.yml`'s image scans. Expect more code-scanning alerts from
    PyTorch's and ffmpeg's packages.
  - Rebuild it only when the service changes, and keep an eye on the GitHub
    Actions cache, whose 10 GB per-repo default is shared with the other images.
  - A static ffmpeg would save about 400 MB.
- **Pocket's weights and voices download from Hugging Face** on first start,
  without authentication. The installer should pre-fetch them into the models
  volume.
- **Faster speech exposes a start-of-call race in VoiceRuntime.** The greeting's
  audio is published before the caller has subscribed to Curia's track. With
  local speech ready sooner, 4 of 5 live-call greetings lost their first
  syllable. Production clips occasionally for the same reason. #2470 holds the
  greeting until the caller has subscribed.
- **Switching an existing deployment is a separate decision**, made after the
  by-ear verdict. If prod switches, its Signal calls switch too.
