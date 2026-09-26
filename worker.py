"""dsh-plugin-dictation transcription worker.

A long-lived child of the harness. The host half (index.js) starts it on the
first dictation and keeps it, so the Whisper model is loaded ONCE rather than on
every phrase -- the difference between ~1 s and ~6 s per dictation.

Protocol: one JSON object per line on stdin, one JSON object per line on stdout.
    in : {"id": "...", "audio": "C:\\path\\clip.webm", "model": "small"}
    out: {"id": "...", "ok": true, "text": "...", "seconds": 0.8, "device": "cpu"}
         {"id": "...", "ok": false, "error": "..."}
A {"ready": true, ...} line is printed once at startup. Anything that is not
protocol goes to stderr, never stdout.

Engine: faster-whisper (CTranslate2). It decodes webm/opus itself through PyAV,
so no ffmpeg is needed on PATH. Runs in its own venv (~/.dsh/dictation-venv),
so it never disturbs any other Python on the machine.

Device: CPU int8 by default -- fast enough for dictation with `small`, and it
cannot collide with anything using the GPU. Set DSH_DICTATION_DEVICE=cuda to try
the GPU; any failure there falls back to CPU instead of breaking dictation.
"""

import json
import os
import sys
import time

DEFAULT_MODEL = "small"
_models = {}


def log(msg):
    print(f"[dictation-worker] {msg}", file=sys.stderr, flush=True)


def load(model_name):
    """Load (and cache) one model, preferring the configured device."""
    if model_name in _models:
        return _models[model_name]
    from faster_whisper import WhisperModel

    want = os.environ.get("DSH_DICTATION_DEVICE", "cpu").lower()
    attempts = [("cuda", "float16")] if want == "cuda" else []
    attempts.append(("cpu", "int8"))
    last = None
    for device, compute in attempts:
        try:
            t0 = time.time()
            model = WhisperModel(model_name, device=device, compute_type=compute)
            log(f"loaded {model_name} on {device}/{compute} in {time.time() - t0:.1f}s")
            _models[model_name] = (model, device)
            return _models[model_name]
        except Exception as exc:  # noqa: BLE001 -- fall through to the next device
            last = exc
            log(f"{model_name} on {device} failed: {exc}")
    raise RuntimeError(f"could not load model {model_name}: {last}")


def transcribe(audio_path, model_name):
    model, device = load(model_name)
    t0 = time.time()
    try:
        # vad_filter drops silence up front: Whisper hallucinates ("You", "Thank
        # you.") on empty audio, which is exactly the failure the Mac hit.
        segments, info = model.transcribe(audio_path, beam_size=5, vad_filter=True)
        text = " ".join(s.text.strip() for s in segments).strip()
    except Exception as exc:  # noqa: BLE001
        # A GPU model can LOAD and still fail at inference (seen on Windows when
        # cublas64_12.dll is missing). Switch to CPU for good and retry once,
        # rather than failing every dictation from here on.
        if device != "cuda":
            raise
        log(f"cuda inference failed ({exc}); switching to CPU")
        os.environ["DSH_DICTATION_DEVICE"] = "cpu"
        _models.pop(model_name, None)
        return transcribe(audio_path, model_name)
    return {
        "text": text,
        "seconds": round(time.time() - t0, 2),
        "device": device,
        "language": getattr(info, "language", None),
        "audio_seconds": round(getattr(info, "duration", 0.0) or 0.0, 2),
    }


def main():
    # Line-buffered UTF-8 both ways; Windows defaults to a legacy code page.
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    print(json.dumps({"ready": True, "pid": os.getpid()}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            result = transcribe(req["audio"], req.get("model") or DEFAULT_MODEL)
            print(json.dumps({"id": req_id, "ok": True, **result}), flush=True)
        except Exception as exc:  # noqa: BLE001 -- one bad clip must not kill the worker
            log(f"request failed: {exc}")
            print(json.dumps({"id": req_id, "ok": False, "error": str(exc)}), flush=True)
    # stdin closed: the harness went away. Exit rather than linger.


if __name__ == "__main__":
    main()
