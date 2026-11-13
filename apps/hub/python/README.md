# Sidecars Python (histórico)

Fast Whisper y WhisperX **ya no se usan** en el agente karaoke.

- **Tiempos:** LRCLIB (LRC) + texto del cancionero / Biblioteca  
- **ASR de último recurso:** `whisper.cpp` (`whisper-cli`) cuando no hay letra ni subtítulos  
- El venv `data/models/whisperx-venv` puede borrarse; no es necesario para ProMedia  

Scripts retirados: `faster_whisper_asr.py`, `whisperx_align.py`.
