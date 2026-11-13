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

El agente corre en el hub (`apps/hub/src/subtitle-agent.ts` y módulos `subtitle-*`). Con el agente activo se dispara al **añadir** al Guion un vídeo, un audio o un YouTube, y también al poner ese ítem En vivo si aún no está listo. No hay cola «Preparar Guion» ni diálogo «Corregir letra».

Orden de la **letra** (la primera que exista):

1. Cancionero de la Biblioteca (memoria por medio/título o coincidencia difusa). Esa letra es la que se proyecta; el reconocedor de voz no la reemplaza.
2. [LRCLIB](https://lrclib.net) si `PROMEDIA_LRCLIB` no es `0`.
3. Captions de YouTube, pista `.srt`/`.vtt`, o transcripción (faster-whisper o whisper.cpp).

Orden de los **tiempos**: Fast Whisper (≥99 % de renglones), relojes LRC de LRCLIB + texto del cancionero, subtítulos oficiales o sidecars, reparto uniforme. WhisperX (wav2vec2) fue retirado.

Los silencios solo blanquean la pantalla entre frases. El detalle de instalación está en el README raíz y en `apps/hub/python/README.md`.

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
