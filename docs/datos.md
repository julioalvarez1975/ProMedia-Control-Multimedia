# Datos en disco

`/data` está en `.gitignore`. El primer arranque del hub crea la biblioteca y las carpetas de subtítulos; no hace falta `mkdir` a mano.

La raíz se resuelve desde el código del hub (tres niveles arriba de `apps/hub/src` o `dist`), no desde el cwd. Overrides: `LIBRARY_ROOT`, `PLAYLISTS_PATH`, `MEDIA_ROOT`, `SUBTITLE_DATA_ROOT`, `SUBTITLE_MODELS_ROOT`.

```text
data/
  library/
    index.json
    files/                  bytes de imágenes, vídeos, audios, presentaciones, canon.json
    bibles/import/          XML, XMM o PDF para importar (copyright: solo local)
    songs/import/           .qsp / .xml de Quelea
  playlists.json            guiones con nombre
  branding/
    logo.bin + logo.meta.json
    watermark.bin + watermark.meta.json
  subtitles/
    cache/                  transcripciones ASR
    aligned/                letra ya alineada, por canción
    wav/                    audio extraído
    youtube-cache/
    sidecars/               .srt / .vtt nombrados como el archivo o como {assetId}
  models/
    whisper/                ggml-base.bin (whisper.cpp)
    whisperx-venv/          Python 3.12 + faster-whisper (nombre histórico)
```

En Docker el volumen es `/data` dentro del contenedor (`MEDIA_ROOT=/data/media`, `PLAYLISTS_PATH=/data/playlists.json`).

## Qué sobrevive a un reinicio

| Dato | ¿En disco? |
|------|------------|
| Guion de la sesión abierta, En vivo, tema, reloj | No. Hay que recargar Control o abrir un guion guardado |
| Guiones con nombre | Sí (`playlists.json`) |
| Cancionero, Biblias, textos, presentaciones, medios de biblioteca | Sí |
| Logo y marca de agua del templo | Sí |
| Assets subidos solo a la sesión | Dependen del adapter (`MEDIA_ROOT`). El puntero vive en la sesión en memoria: al morir el proceso, el Guion que los usaba ya no está |
| Caché de karaoke | Sí, en `data/subtitles/`. Al cambiar la versión del procedimiento el hub purga cálculos viejos al arrancar |
| Memoria «esta pista es esta canción» | Sí, junto al cancionero (`cancionero-memory`) |

## Qué no se commitea

Packs Quelea, traducciones con copyright (RV1960, NVI, NTV, …), modelos Whisper, wavs y cachés. El operador los coloca en su máquina. Las letras que vengan de LRCLIB no entran solas a la Biblioteca: hay que guardarlas a propósito (`live.subtitleAgent.saveLyrics` o el editor de canciones).

## Sidecars de letra

Para un archivo `MiCancion.mp4`, el hub busca antes de transcribir:

- `data/subtitles/sidecars/MiCancion.srt` o `.vtt`
- `data/subtitles/sidecars/{assetId}.vtt`
- softsubs embebidos (ffmpeg / ffprobe)
