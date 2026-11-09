#!/usr/bin/env python3
"""
faster-whisper (CTranslate2) transcription sidecar for the karaoke agent.

Reads ONE JSON object from stdin:
  { "audioPath": str, "model": "base", "computeType": "int8",
    "language": "es" | null, "translate": bool, "prompt": str | null,
    "device": "cpu" | "auto" }
Writes ONE JSON object to stdout:
  { "ok": true, "cues": [{id,startMs,endMs,text}], "language": str,
    "model": str, "device": str, "computeType": str, "durationMs": int,
    "elapsedMs": int }
or { "ok": false, "error": str }. Logs/progress go to stderr only.

Install: same venv as WhisperX (data/models/whisperx-venv) — faster-whisper is
already a dependency of whisperx, nothing extra to install.
"""
from __future__ import annotations

import json
import sys
import time
import traceback


def main() -> int:
    try:
        req = json.loads(sys.stdin.read() or "{}")
        audio = req["audioPath"]
        model_name = req.get("model") or "base"
        compute = req.get("computeType") or "int8"
        device = req.get("device") or "cpu"
        if device == "auto":
            device = "cpu"  # CTranslate2 has no Metal backend; CPU int8 is fastest on Mac
        language = req.get("language") or None
        if language == "auto":
            language = None

        from faster_whisper import WhisperModel  # noqa: WPS433

        # Decode the 16 kHz mono WAV ourselves: faster-whisper's own decoder uses
        # PyAV, whose version in the shared WhisperX venv can be incompatible.
        import wave  # noqa: WPS433

        import numpy as np  # noqa: WPS433

        with wave.open(audio, "rb") as wf:
            rate, width, channels = wf.getframerate(), wf.getsampwidth(), wf.getnchannels()
            raw = wf.readframes(wf.getnframes())
        if rate != 16000 or width != 2:
            raise ValueError(f"expected 16 kHz 16-bit WAV, got {rate} Hz / {width * 8}-bit")
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        if channels > 1:
            samples = samples.reshape(-1, channels).mean(axis=1)

        t0 = time.time()
        model = WhisperModel(model_name, device=device, compute_type=compute)
        segments, info = model.transcribe(
            samples,
            language=language,
            task="translate" if req.get("translate") else "transcribe",
            initial_prompt=req.get("prompt") or None,
            beam_size=int(req.get("beamSize") or 1),
            vad_filter=False,
            condition_on_previous_text=False,
        )
        cues = []
        for i, seg in enumerate(segments):
            text = (seg.text or "").strip()
            if not text:
                continue
            cues.append(
                {
                    "id": f"fw_{i}",
                    "startMs": int(round(seg.start * 1000)),
                    "endMs": int(round(seg.end * 1000)),
                    "text": text,
                }
            )
        out = {
            "ok": True,
            "cues": cues,
            "language": info.language,
            "model": model_name,
            "device": device,
            "computeType": compute,
            "durationMs": int(round(info.duration * 1000)),
            "elapsedMs": int(round((time.time() - t0) * 1000)),
        }
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        out = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
