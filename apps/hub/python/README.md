# WhisperX karaoke align

ProMedia karaoke uses **WhisperX forced alignment**: the Biblioteca / cancionero
letter is fixed; WhisperX only places each line on the audio timeline
(wav2vec2 CTC). Spanish defaults to
`jonatasgrosman/wav2vec2-large-xlsr-53-spanish` (not the VoxPopuli CC-BY-NC
model).

## Install (once)

Python **3.11 or 3.12** recommended:

```bash
# from repo root
python3.12 -m venv data/models/whisperx-venv
data/models/whisperx-venv/bin/pip install -U pip
data/models/whisperx-venv/bin/pip install -r apps/hub/python/requirements-whisperx.txt
```

Optional env:

- `SUBTITLE_WHISPERX_PYTHON` — path to the venv python
- `SUBTITLE_WHISPERX_DEVICE` — `cpu` | `cuda` | `mps` | `auto`
- `SUBTITLE_WHISPERX_ALIGN_MODEL` — override HuggingFace / torchaudio model id
- `SUBTITLE_WHISPERX_TIMEOUT_MS` — default 600000

If WhisperX is missing, the hub falls back to silence / whisper.cpp align.
