#!/usr/bin/env python3
"""
Forced-align cancionero lyric lines onto audio with WhisperX (wav2vec2 CTC).

Does NOT invent text — only places the provided lines on the timeline.
Reads one JSON object from stdin; writes one JSON object to stdout.

Input:
  {
    "audioPath": "/path/to/audio.wav",
    "lines": ["linea 1", "linea 2", ...],
    "language": "es",
    "durationMs": 240000,   # optional; probed from audio if missing
    "device": "cpu",         # optional: cpu | cuda | mps
    "modelName": null       # optional HF id for align model
  }

Output (ok):
  {
    "ok": true,
    "language": "es",
    "backend": "whisperx",
    "alignModel": "...",
    "cues": [{"id":"wx_0","startMs":1234,"endMs":4567,"text":"linea 1"}, ...]
  }
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from typing import Any


# Prefer commercially friendlier Spanish XLSR over VoxPopuli CC-BY-NC defaults.
ALIGN_MODEL_BY_LANG: dict[str, str] = {
    "es": "jonatasgrosman/wav2vec2-large-xlsr-53-spanish",
    "en": "WAV2VEC2_ASR_BASE_960H",
    "pt": "jonatasgrosman/wav2vec2-large-xlsr-53-portuguese",
}


def _fail(msg: str, code: int = 1) -> None:
    sys.stdout.write(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
    sys.stdout.flush()
    raise SystemExit(code)


def _pick_device(requested: str | None) -> str:
    req = (requested or os.environ.get("SUBTITLE_WHISPERX_DEVICE") or "auto").strip().lower()
    try:
        import torch
    except Exception:
        return "cpu"
    if req in ("cpu", "cuda", "mps"):
        if req == "cuda" and not torch.cuda.is_available():
            return "cpu"
        if req == "mps" and not getattr(torch.backends, "mps", None):
            return "cpu"
        if req == "mps" and not torch.backends.mps.is_available():
            return "cpu"
        return req
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        # WhisperX align on MPS is flaky; prefer CPU for forced align.
        return "cpu"
    return "cpu"


def _audio_duration_sec(audio_path: str) -> float:
    # Prefer soundfile / wave; fall back to whisperx load length.
    try:
        import soundfile as sf

        info = sf.info(audio_path)
        if info.duration and info.duration > 0:
            return float(info.duration)
    except Exception:
        pass
    try:
        import whisperx

        audio = whisperx.load_audio(audio_path)
        # whisperx loads at 16 kHz
        return float(len(audio)) / 16000.0
    except Exception as err:
        _fail(f"audio_probe_failed: {err}")
        return 0.0


def _seed_segments(
    lines: list[str],
    duration_sec: float,
    onset_hints_ms: list[float] | None = None,
) -> list[dict[str, Any]]:
    """Rough windows across the full track so align covers the whole song.

    Prefer real speech-onset hints (ffmpeg silencedetect) when provided — equal
    slices alone pack badly on worship intros and long tracks.
    """
    n = len(lines)
    if n == 0:
        return []

    onsets: list[float] = []
    if onset_hints_ms:
        onsets = sorted(
            {
                max(0.0, float(ms) / 1000.0)
                for ms in onset_hints_ms
                if isinstance(ms, (int, float)) and float(ms) > 40
            }
        )

    # Build one window per line from onsets (spread across the song).
    if len(onsets) >= max(2, min(n, 4)):
        # Pick n onsets spanning the list.
        picked: list[float] = []
        if len(onsets) <= n:
            picked = list(onsets)
            while len(picked) < n:
                prev = picked[-1] if picked else max(4.0, duration_sec * 0.08)
                picked.append(min(duration_sec - 1.0, prev + max(2.0, duration_sec / max(n, 1))))
        else:
            for i in range(n):
                idx = int(round(i * (len(onsets) - 1) / max(1, n - 1)))
                picked.append(onsets[idx])
        segs: list[dict[str, Any]] = []
        for i, text in enumerate(lines):
            center = picked[i]
            prev = picked[i - 1] if i > 0 else max(0.0, center - 4.0)
            nxt = picked[i + 1] if i + 1 < n else min(duration_sec, center + 6.0)
            start = max(0.0, min(center - 0.8, (prev + center) / 2.0))
            end = min(duration_sec, max(center + 1.6, (center + nxt) / 2.0))
            if end <= start + 0.4:
                end = min(duration_sec, start + 2.0)
            segs.append({"text": text, "start": float(start), "end": float(end)})
        return segs

    # Fallback: equal slices after a conservative intro.
    intro = min(40.0, max(4.0, duration_sec * 0.10))
    outro = min(20.0, max(2.0, duration_sec * 0.04))
    if intro + outro >= duration_sec * 0.85:
        intro = duration_sec * 0.06
        outro = duration_sec * 0.03
    usable = max(duration_sec - intro - outro, n * 1.5)
    slice_sec = usable / n
    pad = min(1.25, slice_sec * 0.35)
    segs = []
    for i, text in enumerate(lines):
        start = max(0.0, intro + i * slice_sec - (pad if i > 0 else 0.0))
        end = min(
            duration_sec,
            intro + (i + 1) * slice_sec + (pad if i < n - 1 else 0.0),
        )
        if end <= start + 0.35:
            end = min(duration_sec, start + max(1.2, slice_sec))
        segs.append({"text": text, "start": float(start), "end": float(end)})
    return segs


def _cues_from_aligned(
    lines: list[str],
    aligned_segments: list[dict[str, Any]],
    duration_ms: int,
) -> list[dict[str, Any]]:
    cues: list[dict[str, Any]] = []
    for i, text in enumerate(lines):
        seg = aligned_segments[i] if i < len(aligned_segments) else None
        start_s: float | None = None
        end_s: float | None = None
        if isinstance(seg, dict):
            words = seg.get("words") or []
            timed_words = [
                w
                for w in words
                if isinstance(w, dict)
                and isinstance(w.get("start"), (int, float))
                and isinstance(w.get("end"), (int, float))
            ]
            if timed_words:
                start_s = float(timed_words[0]["start"])
                end_s = float(timed_words[-1]["end"])
            else:
                if isinstance(seg.get("start"), (int, float)):
                    start_s = float(seg["start"])
                if isinstance(seg.get("end"), (int, float)):
                    end_s = float(seg["end"])
        if start_s is None:
            # Keep monotonic fallback from previous cue.
            prev = cues[-1]["endMs"] / 1000.0 if cues else max(0.0, (duration_ms / 1000.0) * 0.1)
            start_s = prev + 0.15
        if end_s is None or end_s <= start_s:
            end_s = start_s + 1.6
        start_ms = max(0, int(round(start_s * 1000)))
        end_ms = max(start_ms + 500, int(round(end_s * 1000)))
        if cues:
            start_ms = max(start_ms, cues[-1]["startMs"] + 700)
            end_ms = max(end_ms, start_ms + 500)
        cues.append(
            {
                "id": f"wx_{i}",
                "startMs": start_ms,
                "endMs": end_ms,
                "text": text,
            }
        )

    # Hold each phrase through its last word; yield only when the next line starts.
    for i in range(len(cues) - 1):
        next_start = cues[i + 1]["startMs"]
        end = max(cues[i]["endMs"], cues[i]["startMs"] + 500)
        if next_start - end < 900:
            end = next_start
        else:
            end = min(end, next_start)
        cues[i]["endMs"] = max(cues[i]["startMs"] + 500, end)
    if cues and duration_ms > 0:
        cues[-1]["endMs"] = min(
            max(cues[-1]["endMs"], cues[-1]["startMs"] + 500),
            duration_ms,
        )
    return cues


def main() -> None:
    raw = sys.stdin.read()
    if not raw.strip():
        _fail("empty_stdin")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as err:
        _fail(f"invalid_json: {err}")

    audio_path = str(payload.get("audioPath") or "").strip()
    lines_in = payload.get("lines") or []
    if not audio_path:
        _fail("audioPath_required")
    if not os.path.isfile(audio_path):
        _fail(f"audio_missing: {audio_path}")
    lines = [str(x).strip() for x in lines_in if str(x).strip()]
    if not lines:
        _fail("lines_required")

    language = str(payload.get("language") or "es").strip().lower() or "es"
    if "-" in language:
        language = language.split("-", 1)[0]

    duration_ms_in = payload.get("durationMs")
    duration_ms = (
        int(duration_ms_in)
        if isinstance(duration_ms_in, (int, float)) and duration_ms_in > 0
        else 0
    )

    try:
        import whisperx
    except Exception as err:
        _fail(f"whisperx_missing: {err}")

    device = _pick_device(
        str(payload.get("device")).strip() if payload.get("device") else None
    )
    duration_sec = _audio_duration_sec(audio_path)
    if duration_ms <= 0:
        duration_ms = int(round(duration_sec * 1000))
    else:
        duration_sec = max(duration_sec, duration_ms / 1000.0)

    model_name = payload.get("modelName")
    if not model_name:
        model_name = os.environ.get("SUBTITLE_WHISPERX_ALIGN_MODEL") or ALIGN_MODEL_BY_LANG.get(
            language
        )

    onset_hints_raw = payload.get("onsetHintsMs") or []
    onset_hints: list[float] = []
    if isinstance(onset_hints_raw, list):
        for v in onset_hints_raw:
            if isinstance(v, (int, float)) and float(v) >= 0:
                onset_hints.append(float(v))

    try:
        audio = whisperx.load_audio(audio_path)
        load_kwargs: dict[str, Any] = {"language_code": language, "device": device}
        if model_name:
            load_kwargs["model_name"] = model_name
        align_model, metadata = whisperx.load_align_model(**load_kwargs)
        seed = _seed_segments(lines, duration_sec, onset_hints)
        aligned = whisperx.align(
            seed,
            align_model,
            metadata,
            audio,
            device,
            return_char_alignments=False,
        )
        segments = aligned.get("segments") if isinstance(aligned, dict) else None
        if not isinstance(segments, list) or not segments:
            _fail("align_empty")
        cues = _cues_from_aligned(lines, segments, duration_ms)
    except SystemExit:
        raise
    except Exception as err:
        _fail(f"align_failed: {err}\n{traceback.format_exc()[-800:]}")

    out = {
        "ok": True,
        "language": language,
        "backend": "whisperx",
        "alignModel": model_name or language,
        "device": device,
        "durationMs": duration_ms,
        "cues": cues,
    }
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
