"""Local speech service for the #2469 spike.

One process serves one candidate (ENGINES=…), so each container's memory and
image size belong to that candidate alone. Curia would reach it the way it
reaches Deepgram and Cartesia today: over a socket, from a provider that
implements src/speech/types.ts (see ../providers/).

  WS   /stt/stream?engine=…&sample_rate=…   streaming STT, Deepgram-shaped events
  POST /stt/batch?engine=…                  one finished file → transcript
  POST /tts                                 {text, engine, voice, sample_rate} → raw s16le PCM, streamed
  GET  /health                              loaded engines, load times, RSS

Streaming STT events (JSON text frames), times in seconds of stream audio:
  {"type":"SpeechStarted","timestamp":t}             Silero VAD onset
  {"type":"Results","text":…,"is_final":b,"speech_final":b,"start":t0,"end":t1,"confidence"?:c}

Endpointing (speech_final) comes from the engine by default (ENDPOINT=engine):
Moonshine's own VAD line segmentation, or sherpa-onnx's trailing-silence rule.
ENDPOINT=vad uses the Silero VAD for every engine instead: ENDPOINT_MS of
silence after speech closes the utterance.
"""

from __future__ import annotations

import asyncio
import json
import os
import queue
import resource
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np
import samplerate
import sherpa_onnx
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse

MODELS = os.environ.get("MODELS_DIR", "/models")
ENGINES = [e for e in os.environ.get("ENGINES", "").split(",") if e]
STT_THREADS = int(os.environ.get("STT_THREADS", "1"))
TTS_THREADS = int(os.environ.get("TTS_THREADS", "2"))
BATCH_THREADS = int(os.environ.get("BATCH_THREADS", "2"))
# Same silence Deepgram is configured with (deepgram-stt.ts ENDPOINTING_MS).
ENDPOINT_MS = int(os.environ.get("ENDPOINT_MS", "400"))
ENDPOINT_MODE = os.environ.get("ENDPOINT", "engine")
VAD_THRESHOLD = float(os.environ.get("VAD_THRESHOLD", "0.5"))
MOONSHINE_UPDATE_S = float(os.environ.get("MOONSHINE_UPDATE_S", "0.25"))
MOONSHINE_FAST_FINAL = os.environ.get("MOONSHINE_FAST_FINAL", "1") == "1"
# Two-pass: at each endpoint, re-transcribe the finished utterance with this
# batch engine (e.g. parakeet) and send its text as the final. The streaming
# engine still drives interims and endpointing.
SECOND_PASS = os.environ.get("SECOND_PASS", "")
ASR_RATE = 16000
# Inputs are bounded even in a spike: #2470 copies this service's shape.
ALLOWED_RATES = {8000, 16000, 22050, 24000, 44100, 48000}
MAX_TTS_CHARS = 2000
MAX_BATCH_BYTES = 25 * 1024 * 1024
MAX_BATCH_SECONDS = 600
MAX_STREAM_SECONDS = 3600
MAX_INBOX_FRAMES = 500  # ~10 s of 20 ms frames waiting on the worker

app = FastAPI()
LOADED: dict[str, Any] = {}
LOAD_SECONDS: dict[str, float] = {}


def rss_mb() -> float:
    with open("/proc/self/status") as f:
        for line in f:
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) / 1024
    return 0.0


def peak_rss_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


# ─── Model loading ──────────────────────────────────────────────────────────


def _p(*parts: str) -> str:
    return os.path.join(MODELS, *parts)


def load_engine(name: str) -> Any:
    t0 = time.monotonic()
    if name.startswith("moonshine-"):
        # moonshine-tiny | moonshine-small | moonshine-medium (English streaming, MIT)
        import moonshine_voice as mv
        from moonshine_voice.transcriber import Transcriber

        size = name.split("-", 1)[1]
        arch = mv.string_to_model_arch(f"{size}-streaming")
        path, arch = mv.get_model_for_language("en", arch, cache_root=_p("moonshine"))
        opts = {}
        if os.environ.get("MOONSHINE_VAD_THRESHOLD"):
            opts["vad_threshold"] = os.environ["MOONSHINE_VAD_THRESHOLD"]
        if os.environ.get("MOONSHINE_VAD_WINDOW"):
            opts["vad_window_duration"] = os.environ["MOONSHINE_VAD_WINDOW"]
        engine = Transcriber(str(path), arch, update_interval=MOONSHINE_UPDATE_S, options=opts or None)
    elif name in ("zipformer", "zipformer-libri"):
        # zipformer: LibriSpeech + GigaSpeech (2023-06-21); zipformer-libri: LibriSpeech only (2023-06-26)
        d = _p("sherpa-onnx-streaming-zipformer-en-2023-06-21" if name == "zipformer" else "sherpa-onnx-streaming-zipformer-en-2023-06-26")
        enc = next(f for f in os.listdir(d) if f.startswith("encoder") and f.endswith(".int8.onnx"))
        dec = next(f for f in os.listdir(d) if f.startswith("decoder") and f.endswith(".onnx") and "int8" not in f)
        joi = next(f for f in os.listdir(d) if f.startswith("joiner") and f.endswith(".int8.onnx"))
        engine = sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=os.path.join(d, "tokens.txt"),
            encoder=os.path.join(d, enc),
            decoder=os.path.join(d, dec),
            joiner=os.path.join(d, joi),
            num_threads=STT_THREADS,
            sample_rate=ASR_RATE,
            enable_endpoint_detection=True,
            rule1_min_trailing_silence=2.4,
            rule2_min_trailing_silence=ENDPOINT_MS / 1000,
            rule3_min_utterance_length=30,
        )
    elif name.startswith("fastconformer"):
        # NVIDIA NeMo streaming FastConformer transducer (CC-BY-4.0), cache-aware,
        # 80 ms (fastconformer) or 480 ms (fastconformer-480) lookahead.
        lookahead = "480ms" if name.endswith("480") else "80ms"
        d = _p(f"sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-{lookahead}-int8")
        engine = sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=os.path.join(d, "tokens.txt"),
            encoder=os.path.join(d, "encoder.int8.onnx"),
            decoder=os.path.join(d, "decoder.int8.onnx"),
            joiner=os.path.join(d, "joiner.int8.onnx"),
            num_threads=STT_THREADS,
            sample_rate=ASR_RATE,
            enable_endpoint_detection=True,
            rule1_min_trailing_silence=2.4,
            rule2_min_trailing_silence=ENDPOINT_MS / 1000,
            rule3_min_utterance_length=30,
        )
    elif name == "parakeet":
        d = _p("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8")
        engine = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=os.path.join(d, "encoder.int8.onnx"),
            decoder=os.path.join(d, "decoder.int8.onnx"),
            joiner=os.path.join(d, "joiner.int8.onnx"),
            tokens=os.path.join(d, "tokens.txt"),
            num_threads=BATCH_THREADS,
            model_type="nemo_transducer",
        )
    elif name.startswith("whisper-"):
        # whisper-base.en | whisper-small.en  (whisper.cpp via pywhispercpp)
        from pywhispercpp.model import Model

        engine = Model(name.split("-", 1)[1] + "-q5_1", models_dir=_p("whisper"), n_threads=BATCH_THREADS, print_progress=False, print_realtime=False)
    elif name in ("kokoro", "piper"):
        # Kokoro-82M (af_heart) or Piper LJSpeech (public-domain data) on Moonshine's
        # runtime, whose MIT G2P handles out-of-lexicon names. Text goes through
        # normalize.py first: that G2P does no number/email normalisation.
        from moonshine_voice.tts import TextToSpeech

        voice = os.environ.get("KOKORO_VOICE", "kokoro_af_heart") if name == "kokoro" else os.environ.get("PIPER_VOICE", "piper_en_US-ljspeech-high")
        engine = TextToSpeech().language("en_us").voice(voice).models_from(_p("moonshine-tts"), download=True)
        if name == "kokoro" and os.environ.get("KOKORO_SPEED"):
            # Kokoro scales phoneme durations; > 1 is faster (1.15 ≈ Pocket's natural pace).
            engine = engine.options({"speed": os.environ["KOKORO_SPEED"]})
        engine.load()
        engine.sample_rate = 24000
        engine.lock = threading.Lock()
    elif name == "pocket-native":
        # Kyutai's own pocket-tts (PyTorch, CPU): streams frame by frame, unlike
        # the sherpa-onnx port. Catalog voices only (the cloning weights are gated).
        import torch
        from pocket_tts import TTSModel

        torch.set_num_threads(TTS_THREADS)
        engine = TTSModel.load_model()
        engine.voice_states = {}
        engine.lock = threading.Lock()
        def voice_state(v: str) -> Any:
            # Computing a voice state takes about a second: once per voice, not per request.
            if v not in engine.voice_states:
                engine.voice_states[v] = engine.get_state_for_audio_prompt(v)
            return engine.voice_states[v]

        engine.voice_state = voice_state
        engine.voice_state(os.environ.get("POCKET_VOICE", "alba"))
    elif name == "kokoro-sherpa":
        # Kept to show the failure: sherpa-onnx ≥2.0 is lexicon-only (no espeak),
        # so out-of-lexicon words and every digit are dropped silently.
        d = _p("kokoro-int8-multi-lang-v1_0")
        cfg = sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                    model=os.path.join(d, "model.int8.onnx"),
                    voices=os.path.join(d, "voices.bin"),
                    tokens=os.path.join(d, "tokens.txt"),
                    lexicon=f"{d}/lexicon-us-en.txt",
                    data_dir=os.path.join(d, "espeak-ng-data"),
                    dict_dir=os.path.join(d, "dict"),
                    lang="en-us",
                ),
                num_threads=TTS_THREADS,
            ),
            max_num_sentences=1,
        )
        engine = sherpa_onnx.OfflineTts(cfg)
    elif name == "pocket":
        d = _p("sherpa-onnx-pocket-tts-int8-2026-01-26")
        files = os.listdir(d)

        def pick(prefix: str) -> str:
            return os.path.join(d, next(f for f in files if f.startswith(prefix) and f.endswith(".onnx")))

        cfg = sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                pocket=sherpa_onnx.OfflineTtsPocketModelConfig(
                    lm_flow=pick("lm_flow"),
                    lm_main=pick("lm_main"),
                    encoder=pick("encoder"),
                    decoder=pick("decoder"),
                    text_conditioner=pick("text_conditioner"),
                    vocab_json=os.path.join(d, "vocab.json"),
                    token_scores_json=os.path.join(d, "token_scores.json"),
                ),
                num_threads=TTS_THREADS,
            ),
        )
        engine = sherpa_onnx.OfflineTts(cfg)
    else:
        raise ValueError(f"unknown engine {name}")
    LOAD_SECONDS[name] = round(time.monotonic() - t0, 3)
    return engine


_vad_model: str = _p("silero_vad.onnx")


def make_vad() -> sherpa_onnx.VoiceActivityDetector:
    cfg = sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model = _vad_model
    cfg.silero_vad.threshold = VAD_THRESHOLD
    cfg.silero_vad.min_silence_duration = ENDPOINT_MS / 1000
    cfg.silero_vad.min_speech_duration = 0.1
    cfg.silero_vad.window_size = 512
    cfg.silero_vad.max_speech_duration = 30
    cfg.sample_rate = ASR_RATE
    cfg.num_threads = 1
    return sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=60)


@app.on_event("startup")
def _startup() -> None:
    t0 = time.monotonic()
    for e in ENGINES:
        LOADED[e] = load_engine(e)
    if SECOND_PASS and SECOND_PASS not in LOADED:
        raise RuntimeError(f"SECOND_PASS={SECOND_PASS} but that engine is not in ENGINES; a two-pass run would silently be single-pass")
    LOAD_SECONDS["_total"] = round(time.monotonic() - t0, 3)


@app.get("/health")
def health() -> dict[str, Any]:
    return {"engines": list(LOADED), "load_seconds": LOAD_SECONDS, "rss_mb": round(rss_mb(), 1), "peak_rss_mb": round(peak_rss_mb(), 1)}


# ─── Resampling ─────────────────────────────────────────────────────────────


class StreamResampler:
    """Streaming libsamplerate (BSD-2) resampler; identity when rates match."""

    def __init__(self, src: int, dst: int):
        self.ratio = dst / src
        self.r = None if src == dst else samplerate.Resampler("sinc_fastest", channels=1)

    def __call__(self, x: np.ndarray, end: bool = False) -> np.ndarray:
        if self.r is None:
            return x
        return self.r.process(x, self.ratio, end_of_input=end).astype(np.float32)


# ─── Streaming STT ──────────────────────────────────────────────────────────


@dataclass
class SttSessionState:
    emit: Callable[[dict[str, Any]], None]
    sample_rate: int
    received_s: float = 0.0  # stream seconds received (at the 16 kHz model rate)
    in_speech: bool = False
    last_voiced_s: float = 0.0
    words_open: bool = False
    last_text: str = ""
    utterance_start: float | None = None
    stats: dict[str, Any] = field(default_factory=lambda: {"frames": 0, "proc_s": 0.0})


class OnsetVad:
    """Silero VAD over the 16 kHz stream: onset events, and an optional silence endpoint."""

    def __init__(self, st: SttSessionState):
        self.st = st
        self.vad = make_vad()
        self.buf = np.zeros(0, dtype=np.float32)
        self.pos = 0  # samples fed
        self.speaking = False

    def feed(self, x: np.ndarray) -> tuple[bool, bool]:
        """Returns (onset, endpoint) for this chunk."""
        onset = endpoint = False
        self.buf = np.concatenate([self.buf, x])
        while len(self.buf) >= 512:
            win, self.buf = self.buf[:512], self.buf[512:]
            self.vad.accept_waveform(win)
            self.pos += 512
            detected = self.vad.is_speech_detected()
            if detected and not self.speaking:
                self.speaking = True
                onset = True
                # Silero needs min_speech_duration of voiced audio before it
                # flags speech; the segment began that long (plus a window) ago.
                start_s = max(0.0, (self.pos - 512) / ASR_RATE - 0.1)
                self.st.emit({"type": "SpeechStarted", "timestamp": round(start_s, 3)})
            elif not detected and self.speaking:
                # The detector drops to "no speech" after min_silence_duration.
                self.speaking = False
                endpoint = True
            while not self.vad.empty():
                self.vad.pop()
        return onset, endpoint


class MoonshineSession:
    def __init__(self, transcriber: Any, st: SttSessionState):
        from moonshine_voice.transcriber import LineCompleted, LineTextChanged

        self.st = st
        self.stream = transcriber.create_stream(update_interval=MOONSHINE_UPDATE_S)
        self.completed: set[int] = set()
        self.vad_closed: set[int] = set()
        # Latest text per open line, as of the last transcription pass.
        self.open_lines: dict[int, tuple[str, float, float]] = {}

        def on_event(ev: Any) -> None:
            line = ev.line
            span = (round(line.start_time, 3), round(line.start_time + line.duration, 3))
            if isinstance(ev, LineTextChanged) and not line.is_complete:
                if line.text.strip() and line.line_id not in self.vad_closed:
                    self.open_lines[line.line_id] = (line.text.strip(), *span)
                    st.emit({"type": "Results", "text": line.text.strip(), "is_final": False, "speech_final": False,
                             "start": span[0], "end": span[1]})
            elif isinstance(ev, LineCompleted):
                self.open_lines.pop(line.line_id, None)
                if line.line_id in self.completed:
                    return
                self.completed.add(line.line_id)
                if ENDPOINT_MODE == "vad" and line.line_id in self.vad_closed:
                    return
                st.emit({"type": "Results", "text": line.text.strip(), "is_final": True, "speech_final": True,
                         "start": span[0], "end": span[1]})

        self.stream.add_listener(on_event)
        self.stream.start()

    def feed(self, x: np.ndarray, vad_endpoint: bool) -> None:
        self.stream.add_audio(x.tolist(), ASR_RATE)
        if ENDPOINT_MODE != "vad" or not vad_endpoint:
            return
        if MOONSHINE_FAST_FINAL:
            # Close on the text from the last pass (≤ update interval old).
            # Speech ended ENDPOINT_MS ago, so that pass already heard it.
            lines = [(lid, v) for lid, v in self.open_lines.items() if lid not in self.vad_closed]
        else:
            from moonshine_voice.transcriber import Transcriber

            t = self.stream.update_transcription(Transcriber.MOONSHINE_FLAG_FORCE_UPDATE)
            lines = [(ln.line_id, (ln.text.strip(), ln.start_time, ln.start_time + ln.duration))
                     for ln in t.lines if ln.line_id not in self.vad_closed and ln.line_id not in self.completed]
        lines = [(lid, v) for lid, v in lines if v[0]]
        for lid, _ in lines:
            self.vad_closed.add(lid)
            self.open_lines.pop(lid, None)
        if lines:
            self.st.emit({"type": "Results", "text": " ".join(v[0] for _, v in lines), "is_final": True, "speech_final": True,
                          "start": round(lines[0][1][1], 3), "end": round(lines[-1][1][2], 3)})

    def finish(self) -> None:
        self.stream.stop()
        self.stream.close()


class SherpaOnlineSession:
    def __init__(self, recognizer: Any, st: SttSessionState):
        self.r = recognizer
        self.st = st
        self.s = recognizer.create_stream()
        self.seg_offset = 0.0  # stream seconds at the last reset
        self.audio: list[np.ndarray] = []  # 16 kHz audio since the last reset, for the second pass
        self.audio_s = 0.0

    def _result(self) -> tuple[str, float | None, float | None]:
        res = self.r.get_result_all(self.s)
        text = res.text.strip().lower()
        ts = list(res.timestamps)
        if ts:
            return text, self.seg_offset + ts[0], self.seg_offset + ts[-1] + 0.08
        return text, None, None

    def _second_pass(self, fallback: str) -> str:
        engine = LOADED[SECOND_PASS]  # checked at startup
        if not self.audio:
            self.st.stats["second_pass_fallbacks"] = self.st.stats.get("second_pass_fallbacks", 0) + 1
            return fallback
        t0 = time.monotonic()
        x = np.concatenate(self.audio)
        s = engine.create_stream()
        s.accept_waveform(ASR_RATE, x)
        engine.decode_stream(s)
        self.st.stats["second_pass_s"] = self.st.stats.get("second_pass_s", 0.0) + time.monotonic() - t0
        self.st.stats["second_passes"] = self.st.stats.get("second_passes", 0) + 1
        text = s.result.text.strip()
        if not text:
            self.st.stats["second_pass_fallbacks"] = self.st.stats.get("second_pass_fallbacks", 0) + 1
        return text or fallback

    def _emit_final(self) -> None:
        text, start, end = self._result()
        if text:
            if SECOND_PASS:
                text = self._second_pass(text)
            self.st.emit({"type": "Results", "text": text, "is_final": True, "speech_final": True, "start": start, "end": end})
        self.r.reset(self.s)
        self.st.last_text = ""
        self.seg_offset = self.st.received_s
        self.audio = []
        self.audio_s = 0.0

    def feed(self, x: np.ndarray, vad_endpoint: bool) -> None:
        self.s.accept_waveform(ASR_RATE, x)
        if SECOND_PASS and self.audio_s < 30:
            self.audio.append(x.copy())
            self.audio_s += len(x) / ASR_RATE
        while self.r.is_ready(self.s):
            self.r.decode_stream(self.s)
        text, start, end = self._result()
        if text and text != self.st.last_text:
            self.st.last_text = text
            self.st.emit({"type": "Results", "text": text, "is_final": False, "speech_final": False, "start": start, "end": end})
        endpoint = vad_endpoint if ENDPOINT_MODE == "vad" else self.r.is_endpoint(self.s)
        if endpoint:
            self._emit_final()

    def finish(self) -> None:
        self.s.input_finished()
        while self.r.is_ready(self.s):
            self.r.decode_stream(self.s)
        self._emit_final()


def stt_worker(engine_name: str, st: SttSessionState, inbox: "queue.Queue[bytes | None]") -> None:
    engine = LOADED[engine_name]
    sess = MoonshineSession(engine, st) if engine_name.startswith("moonshine-") else SherpaOnlineSession(engine, st)
    vad = OnsetVad(st)
    rs = StreamResampler(st.sample_rate, ASR_RATE)
    try:
        while True:
            item = inbox.get()
            if item is None:
                break
            t0 = time.monotonic()
            x = np.frombuffer(item, dtype="<i2").astype(np.float32) / 32768.0
            x = rs(x)
            if len(x) == 0:
                continue
            st.received_s += len(x) / ASR_RATE
            _, endpoint = vad.feed(x)
            sess.feed(x, endpoint)
            st.stats["frames"] += 1
            st.stats["proc_s"] += time.monotonic() - t0
        sess.finish()
    except Exception as err:  # surfaced to the client as an Error frame
        st.emit({"type": "Error", "message": f"{type(err).__name__}: {err}"})
    finally:
        st.emit({"type": "Closed", "stats": {**st.stats, "received_s": round(st.received_s, 3)}})


@app.websocket("/stt/stream")
async def stt_stream(ws: WebSocket) -> None:
    engine = ws.query_params.get("engine", "")
    raw_rate = ws.query_params.get("sample_rate", "16000")
    await ws.accept()
    if engine not in LOADED:
        await ws.close(code=4404, reason="engine not loaded")
        return
    if not raw_rate.isdigit() or int(raw_rate) not in ALLOWED_RATES:
        await ws.close(code=4400, reason="unsupported sample_rate")
        return
    sample_rate = int(raw_rate)
    loop = asyncio.get_running_loop()
    out: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    def emit(msg: dict[str, Any]) -> None:
        loop.call_soon_threadsafe(out.put_nowait, msg)

    st = SttSessionState(emit=emit, sample_rate=sample_rate)
    inbox: queue.Queue[bytes | None] = queue.Queue(maxsize=MAX_INBOX_FRAMES)
    worker = threading.Thread(target=stt_worker, args=(engine, st, inbox), daemon=True)
    worker.start()

    async def sender() -> None:
        while True:
            msg = await out.get()
            await ws.send_text(json.dumps(msg))
            if msg["type"] == "Closed":
                return

    send_task = asyncio.create_task(sender())
    started = time.monotonic()
    try:
        while time.monotonic() - started < MAX_STREAM_SECONDS:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                try:
                    inbox.put_nowait(msg["bytes"])
                except queue.Full:
                    # The worker is >10 s behind real time: the session is unusable.
                    emit({"type": "Error", "message": "speech service fell behind real time"})
                    break
            elif msg.get("text") is not None:
                try:
                    ctl = json.loads(msg["text"])
                except ValueError:
                    continue
                if isinstance(ctl, dict) and ctl.get("type") == "CloseStream":
                    break
    except WebSocketDisconnect:
        pass
    finally:
        # Always release the worker, whatever ended the loop.
        while True:
            try:
                inbox.put_nowait(None)
                break
            except queue.Full:
                inbox.get_nowait()
    try:
        await asyncio.wait_for(send_task, timeout=10)
        await ws.close()
    except Exception:  # client already gone
        send_task.cancel()


# ─── Batch STT ──────────────────────────────────────────────────────────────


def decode_to_16k(audio: bytes) -> np.ndarray:
    # Untrusted bytes: stdin only (no playlist/concat fetches of URLs or files),
    # a fixed set of containers, a decoded-length cap and a timeout. ffmpeg's
    # stderr goes to the log, not back to the caller.
    try:
        proc = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "pipe",
             "-format_whitelist", "ogg,webm,matroska,mov,mp4,m4a,wav,mp3,flac,aac",
             "-i", "pipe:0", "-t", str(MAX_BATCH_SECONDS), "-ac", "1", "-ar", str(ASR_RATE), "-f", "s16le", "pipe:1"],
            input=audio, capture_output=True, check=False, timeout=120,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=400, detail="audio took too long to decode")
    if proc.returncode != 0:
        print(f"ffmpeg decode failed: {proc.stderr.decode(errors='replace')[:500]}", file=sys.stderr)
        raise HTTPException(status_code=400, detail="could not decode audio")
    return np.frombuffer(proc.stdout, dtype="<i2").astype(np.float32) / 32768.0


@app.post("/stt/batch")
async def stt_batch(request: Request) -> JSONResponse:
    engine = request.query_params.get("engine", "")
    if engine not in LOADED:
        raise HTTPException(status_code=404, detail=f"engine {engine} not loaded")
    if int(request.headers.get("content-length") or 0) > MAX_BATCH_BYTES:
        raise HTTPException(status_code=413, detail="audio file too large")
    audio = await request.body()
    if len(audio) > MAX_BATCH_BYTES:
        raise HTTPException(status_code=413, detail="audio file too large")
    t0 = time.monotonic()

    def run() -> str:
        x = decode_to_16k(audio)
        if engine == "parakeet":
            s = LOADED[engine].create_stream()
            s.accept_waveform(ASR_RATE, x)
            LOADED[engine].decode_stream(s)
            return s.result.text.strip()
        if engine.startswith("whisper-"):
            segs = LOADED[engine].transcribe(x)
            return " ".join(seg.text.strip() for seg in segs).strip()
        if engine.startswith("moonshine-"):
            t = LOADED[engine].transcribe_without_streaming(x.tolist(), ASR_RATE)
            return " ".join(ln.text.strip() for ln in t.lines).strip()
        raise HTTPException(status_code=400, detail=f"{engine} has no batch path")

    text = await asyncio.to_thread(run)
    return JSONResponse({"text": text, "processing_s": round(time.monotonic() - t0, 3)})


# ─── Streaming TTS ──────────────────────────────────────────────────────────


_pocket_refs: dict[str, tuple[list[float], int]] = {}
# Voice names come from the request: allow only known names, never a path or URL
# (pocket-tts's get_state_for_audio_prompt accepts both).
POCKET_NATIVE_VOICES = {"alba", "marius", "javert", "jean", "fantine", "cosette", "eponine", "azelma", "anna",
                        "vera", "charles", "paul", "george", "mary", "jane", "michael", "eve"}
POCKET_SHERPA_VOICES = {"alba", "bria", "loona"}


def checked_voice(voice: str, allowed: set[str]) -> str:
    if voice not in allowed:
        raise HTTPException(status_code=400, detail=f"unknown voice {voice!r}")
    return voice


def pocket_reference(voice: str) -> tuple[list[float], int]:
    """Pocket TTS clones a voice from a reference clip (test_wavs/<voice>.wav)."""
    if voice not in _pocket_refs:
        import wave

        with wave.open(_p("sherpa-onnx-pocket-tts-int8-2026-01-26", "test_wavs", f"{voice}.wav")) as w:
            raw = w.readframes(w.getnframes())
            x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
            if w.getnchannels() > 1:
                x = x.reshape(-1, w.getnchannels()).mean(axis=1)
            _pocket_refs[voice] = (x.tolist(), w.getframerate())
    return _pocket_refs[voice]


def tts_sid(engine: str, voice: str | None) -> int:
    if voice is None or voice == "":
        return int(os.environ.get(f"{engine.upper().replace('-', '_')}_SID", "0"))
    return int(voice)


@app.post("/tts")
async def tts(request: Request) -> StreamingResponse:
    body = await request.json()
    engine = body.get("engine", "")
    text = (body.get("text") or "").strip()
    if engine not in LOADED:
        raise HTTPException(status_code=404, detail=f"engine {engine} not loaded")
    if not text:
        raise HTTPException(status_code=400, detail="empty text")
    if len(text) > MAX_TTS_CHARS:
        raise HTTPException(status_code=413, detail="text too long")
    tts_engine = LOADED[engine]
    pocket_voice = ""
    if engine == "pocket-native":
        pocket_voice = checked_voice(body.get("voice") or os.environ.get("POCKET_VOICE", "alba"), POCKET_NATIVE_VOICES)
    elif engine == "pocket":
        pocket_voice = checked_voice(body.get("voice") or os.environ.get("POCKET_VOICE", "bria"), POCKET_SHERPA_VOICES)
    native = int(tts_engine.sample_rate)
    try:
        target = int(body.get("sample_rate") or native)
        speed = min(2.0, max(0.5, float(body.get("speed") or 1.0)))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="bad sample_rate or speed")
    if target not in ALLOWED_RATES:
        raise HTTPException(status_code=400, detail="unsupported sample_rate")
    loop = asyncio.get_running_loop()
    chunks: asyncio.Queue[bytes | None] = asyncio.Queue()
    cancelled = threading.Event()
    stats: dict[str, Any] = {"t0": time.monotonic(), "first_chunk_s": None, "audio_s": 0.0}
    rs = StreamResampler(native, target)

    def to_bytes(samples: np.ndarray) -> bytes:
        return (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()

    def callback(samples: Any, progress: float) -> int:
        if cancelled.is_set():
            return 0
        arr = np.asarray(samples, dtype=np.float32)
        if stats["first_chunk_s"] is None:
            stats["first_chunk_s"] = time.monotonic() - stats["t0"]
        stats["audio_s"] += len(arr) / native
        out = rs(arr)
        if len(out):
            loop.call_soon_threadsafe(chunks.put_nowait, to_bytes(out))
        return 0 if cancelled.is_set() else 1

    def run() -> None:
        try:
            from normalize import normalize

            # On by default for every voice we would ship: the G2P voices (Kokoro,
            # Piper) need it for any number, and native Pocket garbles emails and
            # long digit strings without it. The sherpa Pocket port stays raw.
            spoken = normalize(text) if body.get("normalize", engine in ("kokoro", "piper", "pocket-native")) else text
            if engine == "pocket-native":
                with tts_engine.lock:
                    state = tts_engine.voice_state(pocket_voice)
                    gen = tts_engine.generate_audio_stream(state, spoken)
                    try:
                        for ch in gen:
                            if callback(ch.detach().cpu().numpy().reshape(-1), 0.0) == 0:
                                break
                    finally:
                        gen.close()  # stops generation on cancel
            elif engine in ("kokoro", "piper"):
                with tts_engine.lock:
                    stats["normalized"] = spoken
                    for ch in tts_engine.stream(spoken):
                        if callback(ch.samples, 0.0) == 0:
                            tts_engine.cancel_stream()
                            break
            elif engine == "pocket":
                ref, ref_rate = pocket_reference(pocket_voice)
                gc = sherpa_onnx.GenerationConfig()
                gc.reference_audio = ref
                gc.reference_sample_rate = ref_rate
                gc.speed = speed
                tts_engine.generate(spoken, gc, callback=callback)
            else:
                tts_engine.generate(spoken, sid=tts_sid(engine, body.get("voice")), speed=speed, callback=callback)
            tail = rs(np.zeros(0, dtype=np.float32), end=True)
            if len(tail) and not cancelled.is_set():
                loop.call_soon_threadsafe(chunks.put_nowait, to_bytes(tail))
        except Exception as err:
            # Log it, and make body_iter abort the response so the client sees a
            # broken stream, never a short clip that looks like a whole sentence.
            import traceback

            traceback.print_exc()
            stats["error"] = f"{type(err).__name__}: {err}"
            raise
        finally:
            stats["done_s"] = time.monotonic() - stats["t0"]
            loop.call_soon_threadsafe(chunks.put_nowait, None)

    threading.Thread(target=run, daemon=True).start()

    async def body_iter():
        try:
            while True:
                if await request.is_disconnected():
                    cancelled.set()
                    return
                item = await chunks.get()
                if item is None:
                    if stats.get("error"):
                        raise RuntimeError(f"TTS failed mid-stream: {stats['error']}")
                    return
                yield item
        finally:
            cancelled.set()

    return StreamingResponse(body_iter(), media_type="application/octet-stream", headers={"X-Sample-Rate": str(target)})
