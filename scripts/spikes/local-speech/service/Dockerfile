# Local speech service for the #2469 spike. One target per runtime, so the
# image size the spike reports belongs to that runtime alone:
#
#   docker build --target sherpa    -t curia-speech:sherpa    .   # zipformer, parakeet, pocket, kokoro-sherpa
#   docker build --target moonshine -t curia-speech:moonshine .   # moonshine-{tiny,small,medium} STT; kokoro, piper TTS
#   docker build --target whisper   -t curia-speech:whisper   .   # whisper.cpp (batch only)
#   docker build --target pocket    -t curia-speech:pocket    .   # moonshine + native pocket-tts (PyTorch)
#
# Models are mounted at /models (see ../download-models.sh), not baked in, so
# image size and model download size are reported separately.
#
# Every target runs as the unprivileged `speech` user. Its home directory is
# writable because pocket-tts caches its Hugging Face downloads under ~/.cache;
# /models can be mounted read-only.
FROM python:3.12-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir \
      "fastapi==0.121.*" "uvicorn[standard]==0.38.*" "numpy==2.*" "samplerate==0.2.*" \
      "sherpa-onnx==2.0.1"
RUN useradd --create-home --uid 10001 --user-group speech
WORKDIR /app
COPY server.py normalize.py ./
ENV MODELS_DIR=/models PYTHONUNBUFFERED=1
EXPOSE 8000
USER speech
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--log-level", "warning"]

FROM base AS sherpa
USER speech

FROM base AS moonshine
USER root
RUN pip install --no-cache-dir "moonshine-voice==0.1.6"
USER speech

FROM base AS whisper
USER root
RUN pip install --no-cache-dir "pywhispercpp==1.*"
USER speech

# Kyutai's native pocket-tts (PyTorch CPU), which streams; the sherpa-onnx port does not.
FROM moonshine AS pocket
USER root
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir "pocket-tts==4.*"
USER speech
