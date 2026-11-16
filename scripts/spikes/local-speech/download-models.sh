#!/usr/bin/env bash
# Fetch the #2469 candidate models into $1 (default ./models), mounted at /models.
# Moonshine STT/TTS assets and whisper.cpp models download themselves into
# /models/moonshine, /models/moonshine-tts and /models/whisper on first load.
set -euo pipefail
DEST="${1:-./models}"
mkdir -p "$DEST"
cd "$DEST"
B=https://github.com/k2-fsa/sherpa-onnx/releases/download
# The chosen pair by default; ALL=1 adds the candidates that were ruled out.
MODELS="asr-models/sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-80ms-int8.tar.bz2
asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2"
[[ "${ALL:-}" == 1 ]] && MODELS="$MODELS
asr-models/sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-480ms-int8.tar.bz2
asr-models/sherpa-onnx-streaming-zipformer-en-2023-06-26.tar.bz2
asr-models/sherpa-onnx-streaming-zipformer-en-2023-06-21.tar.bz2
tts-models/sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2
tts-models/kokoro-int8-multi-lang-v1_0.tar.bz2"
for f in $MODELS; do
  name="$(basename "$f" .tar.bz2)"
  [[ -d "$name" ]] && continue
  curl -sSLf "$B/$f" | tar xjf -
done
[[ -f silero_vad.onnx ]] || curl -sSLf -O "$B/asr-models/silero_vad.onnx"
du -sh -- */ silero_vad.onnx
