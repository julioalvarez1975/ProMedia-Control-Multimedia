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
