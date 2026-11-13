# Sidecars Python del agente karaoke

## Fast Whisper (ASR)

Transcribe audio local cuando hace falta generar o alinear letra. El venv
sigue viviendo en `data/models/whisperx-venv/` (nombre histórico).

```bash
python3.12 -m venv data/models/whisperx-venv
data/models/whisperx-venv/bin/pip install -U pip
data/models/whisperx-venv/bin/pip install -r apps/hub/python/requirements-whisperx.txt
```

Script: `faster_whisper_asr.py` (JSON por stdin/stdout).

Variables útiles:

- `SUBTITLE_WHISPERX_PYTHON` — intérprete del venv (nombre histórico)
- `SUBTITLE_FASTER_WHISPER_MODEL` — default `base`
- `SUBTITLE_FASTER_WHISPER_COMPUTE` — default `int8`
- `SUBTITLE_FASTER_WHISPER_TIMEOUT_MS`

## WhisperX (eliminado)

La alineación forzada wav2vec2 (`whisperx_align.py`) se retiró: en culto
empaquetaba la letra en la intro. El karaoke usa **LRCLIB** (relojes LRC) y
**Fast Whisper** solo si acierta ≥99 % de renglones.
