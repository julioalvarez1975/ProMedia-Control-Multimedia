# Cambios recientes (sincronizados)

Resumen de las modificaciones locales documentadas y subidas juntos con esta carpeta `docs/`.

## Documentación

- Carpeta `docs/` (arquitectura, API, datos, desarrollo) y enlace desde el README raíz.
- Inventario de librerías/plugins en el README (web, hub, paquetes propios, sistema karaoke).

## Letra manual sobre vídeo (`lyricOverlay`)

- Nuevo estado `live.lyricOverlay` y mensaje WS `live.setLyricOverlay`.
- Botón **Letra** en el Guion (ítems de texto): muestra el primer renglón sobre el vídeo/fondo **sin cortar el audio**; ←/→ cambia de renglón; otro clic oculta.
- UI: `ManualLyricOverlay`, cableado en Control y Output; limpia el overlay si se borra el ítem del Guion.

## Editor de canciones / texto

- `payload.body` guarda el bloque exacto del editor (incluye líneas en blanco).
- Los slides siguen siendo la proyección (frases + trozos ≤6 líneas) y **no** se reescriben al editor como frases nuevas.
- Helpers: `editorBlockFromTextPayload`, `slidesToEditorBlock`, `manualLyricLines`. Tests en `apps/hub/scripts/test-phrases.mts`.

## Toolbar y ajustes

- Diálogo **Configuración** (`SettingsDialog`): idioma y Acerca de.
- Quitados de la barra: selector de idioma suelto, «Preparar Guion» y el flujo «Corregir letra» / teach.

## Karaoke (simplificación)

- Eliminados `live.subtitleAgent.prepare`, `prepareSubtitleAgent`, `maybeAutoPrepare` y `teachSubtitleCancionero`.
- El agente prepara al añadir A/V al Guion o al usarlo en vivo; la letra sigue memoria → título → LRCLIB → captions/ASR.

## Otros

- Transiciones documentadas a 550 ms (lista completa en README / arquitectura).
- `viewport-fit=cover` en `apps/web/index.html`.
- i18n ES/EN/PT/FR/ZH alineado con Letra / Configuración y sin strings de Preparar/Teach.
- Cargar guion desde archivo del dispositivo **suma** al Guion; la copia del hub puede reemplazar (ya documentado en API).

## Fixes de proyección (post-sync)

- Slides de canción: **2 renglones** por defecto; línea en blanco = corte de frase. Sin blancos, `ensureSongPhraseBreaks` inserta el corte cada dos líneas al pasar Biblioteca → Guion.
- Import Quelea: conserva cortes (`.` / vacíos) y separa secciones con línea en blanco.
- Botón **Letra**: overlay también en Vista previa cuando la fila está seleccionada; ←/→ avanza por frase (no renglón suelto); limpia `cueIndex` karaoke trabado.
- Flechas: si hay A/V en vivo con karaoke, ←/→ lo mueven aunque esté seleccionado un texto.

## Karaoke voz↔letra (nov 2026)

- **En vivo** ya no reinicia un cálculo al 100 % (keep-ready + cache por ítem).
- **WhisperX y Fast Whisper eliminados** (código, sidecars Python, venv `data/models/whisperx-venv`, checks de arranque).
- Auth dual Biblioteca tras reinicio del hub; caché karaoke se limpia al preparar cada canción.

## Procedimiento: Whisper ancla el inicio de la voz (15 nov 2026)

La letra proyectada sigue siendo la del cancionero (o LRCLIB / captions). El **cuándo** del primer renglón lo mide whisper.cpp en el audio de esa canción. El procedimiento vigente está en [Arquitectura](arquitectura.md) (sección Karaoke). Estas son las modificaciones, para no revertirlas:

1. **`subtitle-whisper-cpp.ts` — flag de prompt.** Se pasó de `-prompt` a `--prompt`. En el `whisper-cli` de Homebrew `-prompt` es un argumento desconocido y el proceso igual termina con código 0, sin JSON. El hub lo tomaba como transcripción vacía y publicaba el reparto uniforme (primer renglón clavado en 40 s). Si la salida dice `unknown argument`, se reintenta sin el flag aunque el código de salida sea 0.
2. **`subtitle-whisper-cpp.ts` — relojes de palabra.** Se pide `-ojf` y `parseWhisperCppResult` guarda los tokens (`text`, `startMs`, `p`) en `words`. Sin tokens el ancla no puede ver la voz.
3. **`subtitle-cancionero.ts` — `sungEntranceMs`.** Onset = primer grupo denso de palabras, corrido al silencio largo inmediatamente anterior. Caso medido: Vasijas Rotas (`yt:A-osCPE-x68`), la voz de «Mi alma estaba…» entra ~25,5 s (`entrance=25522`); el tope de 40 s de `conservativeIntroMs` quedaba ~15 s tarde. Test en `scripts/smoke-cancionero-match.mts`.
4. **`subtitle-agent.ts` — análisis de cada canción.** `fetchCancioneroTimingCues` corre **antes** de publicar, también cuando hay LRC de LRCLIB. El log es `whisper voice scan words=… entrance=…ms`.
5. **`subtitle-agent.ts` — ancla.** Gráfico uniforme o LRCLIB: se desplaza entero hasta el onset. Relojes por línea: solo el renglón 0. No se aplica `timingByMedia` ni el nudge ←/→ reescribe relojes: el onset de Whisper no se pisa. ←/→ solo cambia el renglón visible.
6. **`subtitle-agent.ts` — sin cancionero.** Las cues de Whisper de ese camino también se anclan con `sungEntranceMs`.
7. **Cachés.** `ASR_CACHE_VERSION` **3** (guarda `words`). `ALIGNED_CACHE_VERSION` **5**. Al arrancar, el hub purga lo que no sea la versión actual.
8. **Captions sin palabras de Whisper.** Si el alineado falla, el gráfico uniforme se corre al primer cue cantado de las captions (`firstSpeechOnsetMs`), no al 12 % del tema. Libre Soy (`053BvHDfIdI`): voz a los 22,03 s; el cálculo anterior abría a los 36,96 s.
9. **En vivo.** Go Live con cues `ready` del mismo ítem no vuelve a analizar. El porcentaje no reinicia. Un publish aunque sea parcial guarda el hash de la letra; faltar ese hash no cuenta como «cancionero modificado».
10. **Lo que no hay que reintroducir.** No usar `-prompt`. No tratar el tope de 40 s ni el 12 % como «cuando empieza la voz» si ya hay un cue cantado. No saltear Whisper porque LRCLIB ya tenga relojes. No dejar que un silencio corto del intro sea el primer renglón. No volver a aplicar `applyRememberedCueStarts` ni a guardar relojes con ←/→. No relanzar el análisis en Go Live si el ítem ya está `ready`.
11. **Cálculo al cargar el Guion (15 nov 2026).** Al agregar YouTube/audio (WS, import de archivo, Biblioteca → Guion, o al encender el agente) cada tema se encola solo. No hay que tocar el renglón para que suba el %. La cola es en segundo plano (`bgStore`): una canción a la vez, caché por ítem, sin borrar el En vivo. No volver al prefetch que saltaba si otra canción proyectaba ni al job en primer plano que robaba el `itemId` al agregar.
12. **Protección del navegador (cola Guion).** Whisper corre en el hub; el riesgo de colgar Control/Output es el diluvio de `session.updated`. Mitigación: coalescer % en segundo plano (~450 ms, ~900 ms si hay ≥6 en cola), pausa entre canciones (~280 ms), un solo broadcast al importar, Output ignora ruido de `itemProgress`, Control pinta el Guion con `useDeferredValue`. Si el navegador igual se pone pesado: apagar el agente karaoke (cancela la cola), o proyectar y dejar que termine en segundo plano; no hace falta tocar cada fila.
13. **LRCLIB no se adelanta por intro de Whisper (15 nov 2026).** Digno Y Santo (`YExhjAP8zPU`): cluster ASR a 26.65s tiró el LRC (31.95s) −5.3s. Anclar con `firstLyricOnsetMs` / `resolveKaraokeVoiceAnchorMs`; si el entrance queda mucho antes del LRC sin oír la primera línea, se dejan los relojes LRCLIB. Caché alineada v6. Equal-time (Libre Soy / Vasijas) sigue anclando al onset libremente.
