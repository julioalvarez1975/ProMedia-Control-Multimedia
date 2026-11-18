# Arquitectura

Monorepo **pnpm** (Node ≥ 20). El hub y la web se arrancan juntos con `pnpm dev` (`scripts/dev.mjs`).

```text
apps/web          SPA Vite + React 19  — / , /control , /output
apps/hub          API Hono + WebSocket — puerto 8787
packages/shared   Tipos de sesión, temas, mensajes cliente→hub
packages/item-types   Preview, En vivo y Output por tipo de ítem
packages/media    Disco local y stub S3
packages/i18n     ES · EN · PT · FR · ZH
```

| Servicio | Puerto | Rol |
|----------|--------|-----|
| Hub | 8787 | Sesiones, assets, biblioteca, Biblia, karaoke |
| Web (Vite) | 5173–5178 | UI. REST va por proxy `/api`; el WebSocket en desarrollo apunta directo a `ws://<host>:8787` |

`PROMEDIA_MODE=lan` (default) hace que hub y Vite escuchen en `0.0.0.0`. `HUB_HOST=127.0.0.1` los deja solo en localhost.

## Ventanas

| Ruta | Quién | Qué hace |
|------|-------|----------|
| `/` | cualquiera | Home mínima con enlace a Control |
| `/control` | operador | Guion, vista previa, En vivo, biblioteca, tema |
| `/output` | proyector | Pantalla completa. Sigue el snapshot. El único mensaje que puede enviar es el reloj del reproductor |

Control crea o reanuda la sesión al conectar. **Proyectar** abre Output, intenta el segundo monitor (Window Management en Chrome) y pide pantalla completa. Eso exige un gesto del usuario; si el popup está bloqueado, el atajo `O` o el enlace «Abrir salida» hacen lo mismo.

Varios Output (otra pestaña, un TV en el navegador, un teléfono) ven el mismo estado. Output no muta el guion, el tema ni la escena.

## Sesión

La sesión vive **en memoria** del proceso del hub. Un reinicio la borra. Lo que sí persiste en disco: biblioteca, guiones guardados, logo, marca de agua y caché de karaoke (ver [datos](datos.md)).

Cada cambio incrementa `seq` y se emite como `session.updated` (o `session.snapshot` al saludar). El snapshot incluye:

- `playlist` — ítems ordenados del Guion
- `live` — ítem en vivo, slide, escena, tema, fondo, transición, `mediaClock`, agente de subtítulos, `lyricOverlay`, marca de agua, tapa de vídeo
- `code` — código corto de 4 caracteres (unión por LAN)
- `mode` — `lan` | `cloud` | `portable`

`lyricOverlay` (`{ itemId, lineIndex }` o `null`) proyecta **una línea** de un ítem de texto del Guion encima del vídeo o del fondo de escenario, sin tocar `currentItemId` ni el audio. En Control el botón **Letra** del Guion lo enciende/apaga; ←/→ avanza el renglón mientras el overlay está activo.

## Tipos de ítem

El registro está en `packages/item-types/src/registry.ts`. Cada tipo expone `Preview`, `LivePanel` y `OutputRenderer`.

| `type` | Contenido | Navegación |
|--------|-----------|------------|
| `text` | Bloque de editor (`payload.body`) + slides de proyección (frases y trozos ≤2 líneas). Canciones, avisos, import PDF/XML/txt | ← / → |
| `bible` | Pasaje ya resuelto a slides | ← / → |
| `presentation` | Import PPTX/PDF/ODP… como imágenes. Sin macros (`.pptm` / `.ppsm`) | ← / → |
| `image` | Asset de sesión, `fit` contain/cover/fill | — |
| `video` | Archivo local **o** YouTube (`sourceKind`) | transporte |
| `audio` | Archivo local (mp3, wav, m4a, …) con el mismo reloj que el vídeo | transporte |

La vista previa no es lo que se proyecta hasta **En vivo** (`live.go`). Volver a enviar el ítem que ya está en vivo lo apaga (`live.clear`) y Output queda en negro.

YouTube se embebe **solo en Output**. Preview y En vivo muestran miniatura y transporte. Si el dueño bloquea el embed, Control puede pedir al hub que baje el vídeo (`youtube-download`) y lo cambie por un archivo de sesión.

## Reloj de medios

`mediaClock` (`playing`, `positionMs`, `rate`, `updatedAt`) es la fuente de tiempo para el transporte y para el karaoke.

Output (iframe de YouTube o `<video>` / `<audio>`) informa `currentTime` con `live.mediaClock.set` cada ~250 ms. Si el hub no recibe un latido en más de 500 ms (`MEDIA_CLOCK_EXTRAPOLATION_MAX_AGE_MS`), la posición **se congela** en el último reporte en lugar de adelantarse con el reloj de pared.

Escenas Logo, Negro y Clear son overlays: no pausan el reloj.

## Tema y escena

Definidos en `packages/shared/src/themes.ts` y en el estado `live`.

- Escenas: `normal` · `logo` · `black` · `clear`
- Temas: `oscuro` · `claro` · `acento`, más overrides de color, alineación, familia y tamaño
- Fondos: color, packs en `apps/web/public/theme-backgrounds/` (Aurora, Brasas, Océano, Rejilla, Azul abstracto) o un archivo subido a la sesión
- Transiciones al cambiar el ítem en vivo: `none`, `fade` (default), `crossfade`, `blur`, `scale`, `slide`, `fly`, `spin`, `motionBlur`, `pixelate`. Duración fija `TRANSITION_DURATION_MS` = **550 ms**. `softScale` se acepta como alias viejo de `scale`

La marca de agua (esquina) es independiente de la escena Logo. La tapa de vídeo (`videoCover`) se dibuja encima del reproductor y debajo de la letra; el audio sigue.

## Karaoke

El agente corre en el hub (`apps/hub/src/subtitle-agent.ts` y módulos `subtitle-*`). Al **añadir** al Guion un vídeo, un audio o un YouTube (o al importar un guion / activar el agente), cada fila entra a una **cola en segundo plano**: no hace falta seleccionarla. El porcentaje de la fila sube sola; el resultado queda en la caché por canción. En vivo solo usa ese resultado si aún no está listo. No hay cola «Preparar Guion» ni diálogo «Corregir letra».

Orden de la **letra** (la primera que exista). El reconocedor no reemplaza el texto del cancionero:

1. Cancionero de la Biblioteca (memoria por medio/título o coincidencia difusa).
2. [LRCLIB](https://lrclib.net) si `PROMEDIA_LRCLIB` no es `0`.
3. Captions de YouTube, pista `.srt`/`.vtt`, o la transcripción de whisper.cpp.

### Procedimiento de tiempos (cada canción que se analiza)

Whisper.cpp analiza **el audio de esa grabación** antes de publicar cues. LRCLIB y el reparto uniforme aportan el gráfico de renglones; no deciden cuándo entra la voz. No saltear Whisper porque ya haya relojes LRC.

1. Bajar o abrir el audio y medir silencios (`ffmpeg silencedetect`). El silencio blanquea la frase al respirar y adelanta el renglón siguiente ~700 ms (`SILENCE_AIR_ANTICIPATION_MS`). No inventa el reloj de cada línea.
2. Transcribir con `whisper-cli` y el modelo `ggml-base.bin`:
   - Idioma: `-l` del idioma de Control (no `auto`).
   - Segmentos: `-ml 48 -sow -sns`.
   - Semilla de la letra oficial: **`--prompt`**. El flag corto `-prompt` no existe: whisper-cli imprime `unknown argument` y **sale con código 0**. Tratar eso como fallo y reintentar sin el flag; si no, se publica el gráfico uniforme sin palabras.
   - Relojes de palabra: **`-ojf`** (tokens con `offsets` y `p`). Sin eso solo hay segmentos de ~30 s y el ancla no ve la voz.
3. Inicio de la voz: `sungEntranceMs` (`subtitle-cancionero.ts`). Es el primer grupo denso (≥4 palabras con `p ≥ 0.45` en ≤8 s). Si en los 12 s anteriores hay un silencio ≥1,2 s, el ataque es el fin de ese silencio. Los tokens sueltos del intro no cuentan. El tope de 40 s de `conservativeIntroMs` **no** es la voz: es solo el arranque del reparto uniforme.
4. Ancla (`withVoiceAndBlank` en `subtitle-agent.ts`). Si Whisper no devolvió palabras pero hay captions, el ataque es el primer cue de esas captions (no el tope del 12 %). Libre Soy `053BvHDfIdI`: la voz entra a los 22 s; un match fallido no puede abrir a los 37 s.
   - Gráfico uniforme (reparto igual o LRCLIB): se desplaza **entero** para que el renglón 0 empiece en ese ataque.
   - Relojes ya medidos línea por línea (Whisper o captions): solo se mueve el **primer** renglón al ataque; el resto queda en su palabra.
   - Sin palabras de Whisper y sin captions: se conserva el gráfico. No afirmar que el tope de 40 s ni el 12 % del tema es el onset.
5. No hay ajuste manual de tiempos. ←/→ en Vista previa solo cambia el renglón visible; no reescribe `startMs` ni guarda `cueStarts`. Un `timingByMedia` viejo no se vuelve a aplicar al publicar. El ancla de Whisper queda como se midió.
6. El mismo análisis corre si no hay cancionero: las cues de Whisper se anclan al mismo onset.
7. **En vivo no recalcula.** Si el ítem ya está `ready` con cues válidas, Go Live las deja. No hay un segundo 0→100 %. Solo se descartan si el fingerprint guardado de la letra ya no coincide con la Biblioteca. Un publish parcial igual guarda ese fingerprint; no se borra.
8. **Cola de Guion.** `maybeStartKaraokeOnGuionItem(s)` encola cada A/V al cargarlo. Un drain serial (`bgQueued` / `bgStore`) calcula una canción a la vez en un agente privado: no pisa En vivo ni Vista previa. Caché en memoria → disco → Whisper. El % de cada fila viene de `setBgProgress`.
9. **Recurso del navegador.** Los ticks de progreso en segundo plano se coalescen antes del broadcast; hay yield entre canciones. Output no reaplica updates que solo cambian `itemProgress` (el proyector no pinta el Guion). Control difiere el % del Guion. Si el recurso queda comprometido: desactivar el agente cancela la cola; el cálculo pesado sigue siendo del hub, no del browser.
10. **Ancla voz ↔ letra.** Charts equal-time: `sungEntranceMs` / caption onset. Charts LRCLIB: preferir cuando Whisper oye la primera línea (`firstLyricOnsetMs`); no adelantar el LRC por un cluster de intro. Caché `ALIGNED_CACHE_VERSION` 6.

Al cambiar este procedimiento, subir `ALIGNED_CACHE_VERSION` (`subtitle-aligned-store.ts`, hoy **5**) y `ASR_CACHE_VERSION` (`subtitle-asr.ts`, hoy **3**). El hub borra al arrancar los resultados de otra versión.

WhisperX y Fast Whisper siguen retirados. Instalación: README raíz y `apps/hub/python/README.md`.

## Control: ajustes

Idioma y Acerca de viven en el diálogo **Configuración** (engranaje de la barra). Más opciones pueden sumarse ahí sin saturar la toolbar.

## Biblioteca

Mediateca local del hub (`apps/hub/src/library-store.ts`), no una nube. Categorías: `canciones`, `biblias`, `textos`, `presentaciones`, `imagenes`, `videos`, `audios`.

Añadir un ítem de biblioteca a la sesión copia los bytes que hagan falta al almacén de assets de esa sesión y emite el mismo `session.updated` que un alta por WebSocket.

## Biblia

`GET /api/v1/bible/versions` mezcla versiones remotas de dominio público (`rvr1909`, `pdt`, `kjv`, `asv`) con las traducciones importadas en disco. Un id local pisa al remoto del mismo id. El pasaje se resuelve en el hub y viaja ya partido en slides.

## i18n

`packages/i18n` exporta los JSON de `locales/`. El idioma de Control también fija el idioma objetivo del agente de subtítulos.

## Límites que el código impone

- Assets de archivo son de la sesión. Al cargar un guion guardado, imagen, vídeo o audio cuyo asset ya no existe se omiten. Texto, Biblia y YouTube sí vuelven.
- El adapter S3 (`packages/media`) escribe en disco si faltan credenciales.
- Multi-monitor y pantalla completa dependen del navegador.
- No hay canon bíblico offline completo salvo lo que el operador importe y el fallback mínimo embebido.
