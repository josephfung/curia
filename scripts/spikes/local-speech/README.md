# Local speech spike harness (#2469)

Can a local STT/TTS pair replace Deepgram and Cartesia on a CPU-only host? This
harness measures the gates in #2469 for each candidate, with the cloud pair
measured the same way beside it. Results and the verdict: [RESULTS.md](RESULTS.md)
and the ADR that amends ADR-037.

## Pieces

| File | What it is |
|---|---|
| `service/` | The local speech service: one container per runtime (`sherpa`, `moonshine`, `whisper`, `pocket` build targets). Streaming STT over WebSocket with Deepgram-shaped events, batch STT and streaming TTS over HTTP. |
| `local-providers.ts` | `LocalSttProvider` (streaming + batch) and `LocalTtsProvider`, implementing `src/speech/types.ts` unchanged. |
| `run-stt.ts` | Streams fixtures in real time as 20 ms frames through any `SpeechToTextProvider` (local or `DeepgramSttProvider`) and times onset, barge-in interim and end of speech → `speechFinal`; scores WER and entities. `MODE=batch` runs the voice-note path. |
| `run-tts.ts` | First audio, real-time factor, playback stalls and cancel → silence through any `TextToSpeechProvider` (local or `CartesiaTtsProvider`), optionally with an STT session streaming beside it. Saves the audio for listening. |
| `make-fixtures.ts` | Builds the STT fixtures outside the repo: the `stt` sentences read by six macOS `say` accents and local TTS voices, 20 LibriSpeech test-clean utterances, and the maintainer's recordings when present. 16 kHz and 48 kHz. |
| `scoring.ts` | Spoken-form canonicaliser (so "3:30 PM", "3:30 p.m." and "three thirty p m" score the same), WER and entity matching. |
| `sentences.json` | The sentence set (text only). |
| `report.ts` | Results JSON → the markdown tables in RESULTS.md (re-scores WER and entities with the current `scoring.ts`). |
| `tts-intelligibility.ts` | Transcribes saved TTS audio with Parakeet and scores it against the text: a stand-in for listening that catches dropped words and misread numbers, emails and names. |
| `collect-results.ts` | Copies run outputs into `results/` without the per-event timelines. |
| `download-models.sh` | Fetches the sherpa-onnx models; Moonshine and whisper.cpp fetch their own on first load. |

## Rerun

```bash
H=scripts/spikes/local-speech
# 1. Images and models
for t in sherpa moonshine whisper pocket; do docker build --target $t -t curia-speech:$t $H/service; done
bash $H/download-models.sh ~/speech-models
# The images run as uid 10001, and Moonshine and whisper.cpp download into /models
# on first load, so on Linux hand the folder to that uid (Docker Desktop needs nothing).
sudo chown -R 10001:10001 ~/speech-models

# 2. One container per candidate (memory is then the candidate's own). The chosen stack:
#    two-pass STT (FastConformer + Parakeet final) and native Pocket TTS, voice alba.
docker run -d --name sp-stt    -p 8701:8000 -v ~/speech-models:/models -e ENDPOINT=vad -e SECOND_PASS=parakeet \
  -e ENGINES=fastconformer,parakeet curia-speech:sherpa
docker run -d --name sp-pocket -p 8704:8000 -v ~/speech-models:/models -e TTS_THREADS=2 -e POCKET_VOICE=alba \
  -e ENGINES=pocket-native curia-speech:pocket
# Candidates ruled out, for comparison: moonshine-tiny/small (STT), kokoro (KOKORO_VOICE, KOKORO_SPEED), pocket (sherpa port)
docker run -d --name sp-kokoro -p 8703:8000 -v ~/speech-models:/models -e KOKORO_VOICE=kokoro_am_puck -e KOKORO_SPEED=1.15 \
  -e ENGINES=kokoro curia-speech:moonshine
curl -s localhost:8701/health   # load times and RSS

# 3. Fixtures (needs macOS `say`, a kokoro and a pocket service; LibriSpeech test-clean unpacked)
FIXTURES_DIR=~/speech-fixtures FIXTURE_TTS_URL=http://127.0.0.1:8703 FIXTURE_POCKET_URL=http://127.0.0.1:8704 \
  LIBRISPEECH_DIR=…/LibriSpeech/test-clean pnpm exec tsx $H/make-fixtures.ts

# 4. STT, both sample-rate paths
for r in 16000 48000; do
  RATE=$r STT=local:fastconformer STT_URL=http://127.0.0.1:8701 HOST_LABEL=cpx22 pnpm exec tsx $H/run-stt.ts
  RATE=$r STT=deepgram DEEPGRAM_API_KEY=… HOST_LABEL=cpx22 pnpm exec tsx $H/run-stt.ts
done
MODE=batch STT=local:parakeet STT_URL=http://127.0.0.1:8701 pnpm exec tsx $H/run-stt.ts

# 5. TTS, both output rates, with STT streaming alongside
for r in 24000 48000; do
  RATE=$r TTS='local:pocket-native#alba' TTS_URL=http://127.0.0.1:8704 CONCURRENT_STT=local:fastconformer@http://127.0.0.1:8701 pnpm exec tsx $H/run-tts.ts
  RATE=$r TTS=cartesia CARTESIA_API_KEY=… CARTESIA_VOICE_ID=… CONCURRENT_STT=… pnpm exec tsx $H/run-tts.ts
done

# 6. Intelligibility round trip (TTS audio → Parakeet), then commit-sized results and tables
STT_URL=http://127.0.0.1:8705 pnpm exec tsx $H/tts-intelligibility.ts <audio-dir>/local_kokoro.24000 …
pnpm exec tsx $H/collect-results.ts $H/results-raw   # drops per-event timelines
pnpm exec tsx $H/report.ts $H/results
```

Fixtures, audio and model files stay outside the repo; only the JSON results are
committed.

### Service knobs

| Env | Default | Meaning |
|---|---|---|
| `ENGINES` | — | Comma list: `fastconformer` (80 ms), `fastconformer-480`, `pocket-native` (image `pocket`), `moonshine-{tiny,small,medium}`, `zipformer` (LibriSpeech+GigaSpeech), `zipformer-libri`, `parakeet`, `whisper-{base,small}.en`, `kokoro`, `piper`, `pocket`, `kokoro-sherpa` |
| `ENDPOINT` | `engine` | `vad`: Silero VAD closes the utterance after `ENDPOINT_MS` of silence, for every engine. `engine`: Moonshine's line segmentation or sherpa-onnx's trailing-silence rule. |
| `ENDPOINT_MS` | 400 | Same silence Deepgram is configured with (`deepgram-stt.ts`). |
| `MOONSHINE_FAST_FINAL` | 1 | Close a VAD-endpointed line on the last pass's text instead of forcing a re-decode. Faster, but less accurate (see RESULTS.md). |
| `SECOND_PASS` | — | `parakeet`: at each endpoint, re-transcribe the utterance with that batch engine and send its text as the final (needs it in `ENGINES`). |
| `POCKET_VOICE` | `alba` | Default native-Pocket voice. Request voices are checked against an allowlist (`POCKET_NATIVE_VOICES` in `server.py`). |
| `KOKORO_VOICE` / `KOKORO_SPEED` | `kokoro_af_heart` / 1.0 | Kokoro on Moonshine's runtime. |
| `STT_THREADS` / `TTS_THREADS` / `BATCH_THREADS` | 1 / 2 / 2 | Threads per engine. `TTS_THREADS` also sets PyTorch's for native Pocket, which ran slower at 4 than at 2. |

Don't pin or quota-limit the Moonshine container to stand in for a small host:
its runtime sizes ONNX Runtime's thread pool from the cores it can see and runs
about 10× slower under Docker CPU limits (RESULTS.md, "Host sizes"). Use a real
small VM.

## Recording fixtures

Input to TTS goes through `service/normalize.py` (times, dates, phone numbers,
emails, money; letters spelled by name) for every engine Curia would ship; pass
`"normalize": false` in a `/tts` request to send text raw.

Synthetic voices are clean and easy. The real test is the maintainer's own voice.
Record each `stt` sentence in `sentences.json` as `<id>.wav` or `<id>.m4a` (a phone voice memo is fine, any rate)
into a folder outside the repo, then rerun `make-fixtures.ts` with
`RECORDED_DIR=<folder>`. Recorded fixtures are scored as their own source
column. `RECORDED_ONLY=1` rebuilds just the recorded fixtures and keeps the rest.
