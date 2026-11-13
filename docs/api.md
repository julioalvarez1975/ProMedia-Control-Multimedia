# API y protocolo

Base: `http://<host>:8787`. La SPA en desarrollo llama REST como `/api` (proxy de Vite) y el socket como `ws://<host-de-la-página>:8787`.

Todas las rutas de abajo cuelgan de **`/api/v1`**, salvo `/health` y `/`.

## Salud

`GET /health` → JSON con `ok`, `service` (`promedia-hub`), `mode`, `listenHost`, `lanAddresses`, `startup` y `mediaAdapter`.

`GET /` describe el servicio y recuerda que las sesiones son en memoria.

## Autenticación

No hay usuarios. Hay tres secretos de sesión:

| Credencial | Dónde sale | Qué permite |
|------------|------------|-------------|
| `accessToken` | `POST /sessions` (solo lo ve Control) | Dueño. Puede actuar como control |
| `wsTicket` | Alta o `POST /sessions/join`. Viaja como `credential` en el query del WS y como `Authorization: Bearer` | El rol grabado en el ticket (`control` u `output`) |
| `code` | 4 caracteres, visible en Control | Unirse. **Nunca** autoriza mutaciones de control |

Query habituales: `credential`, `accessToken` o `token`, `code`, `sessionId`. Header alternativo del token: `X-ProMedia-Access-Token`.

`authorizeSessionAccess` (`apps/hub/src/auth.ts`): el código corto no cumple `requireRole: "control"`. El token de acceso sí.

`authorizeHubOperator`: biblioteca y parseo de PDF. Acepta un ticket de **control** vivo o el `accessToken` de cualquier sesión abierta.

Unirse por código está limitado a 20 intentos por minuto e IP (`rate_limited`, 429). En `PROMEDIA_MODE=cloud`, unirse como control exige token (`control_requires_token`). En `lan` y `portable` el teléfono puede entrar a Control con el código.

## Sesiones

### `POST /sessions`

Cuerpo opcional `{ "mode": "lan" | "cloud" | "portable" }`. Si falta, usa `PROMEDIA_MODE` o `lan`.

`201` con `sessionId`, `code`, `accessToken`, `role: "control"`, `wsTicket`, `joinUrl`, `wsUrl`, `snapshot`.

### `POST /sessions/join`

Exactamente uno de `code` o `accessToken`, y `role` opcional (default `output`).

`200` con `sessionId`, `code`, `role`, `wsTicket`, `wsUrl`, `snapshot`. Errores: `invalid_json`, `invalid_credentials` (401), `rate_limited`, `control_requires_token`.

### `GET /sessions/:sessionId`

Requiere credencial de esa sesión. `{ snapshot }`.

## Assets de sesión

Tope de subida: **512 MB**.

| Método | Ruta | Rol | Cuerpo / respuesta |
|--------|------|-----|--------------------|
| POST | `/sessions/:sessionId/assets` | control | multipart `file` → `{ asset }` 201 |
| GET | `/sessions/:sessionId/assets/:assetId` | control u output | bytes (`Content-Type` del asset) |
| POST | `/sessions/:sessionId/youtube-download` | control | `{ videoId }` → asset mp4 local |
| POST | `/sessions/:sessionId/library/:libraryItemId/add` | control | copia el ítem al Guion y hace broadcast |
| POST | `/sessions/:sessionId/library/:libraryItemId/copy-image` | control | `{ assetId }` para usar la imagen como tapa |

MIME de imagen: jpeg, png, webp, gif, svg. Vídeo: mp4, webm, quicktime. Audio: mpeg, mp4/m4a, aac, wav, flac, ogg, opus, webm. Lista en `packages/media/src/types.ts`.

## Branding

Persisten en `data/branding/` entre sesiones.

| Método | Ruta | Notas |
|--------|------|-------|
| GET | `/branding/logo` | `sessionId` + credencial. 404 si no hay logo propio |
| POST | `/branding/logo` | control, multipart `file`. Pasa la escena a `logo` y avisa a todas las sesiones |
| GET | `/branding/watermark` | igual que el logo |
| POST | `/branding/watermark` | control. Imagen, gif/webp/apng o vídeo corto. Enciende la marca |

## Guiones guardados

Archivo `data/playlists.json` (o `PLAYLISTS_PATH`).

| Método | Ruta | Notas |
|--------|------|-------|
| GET | `/playlists` | lista sin el cuerpo de los ítems (`itemCount`) |
| GET | `/playlists/:id` | guion completo |
| PATCH | `/playlists/:id` | `{ name }` — operador |
| DELETE | `/playlists/:id` | |
| POST | `/sessions/:sessionId/playlists` | `{ name, id? }` guarda el Guion actual |
| POST | `/sessions/:sessionId/playlists/:playlistId/load` | **reemplaza** el Guion (copia del hub); reasigna ids |
| POST | `/sessions/:sessionId/playlists/import` | `{ name?, items }` desde un archivo del dispositivo: **suma** al Guion (no borra lo que ya hay) |

En ambos casos `skipped` cuenta ítems de archivo cuyo asset no está en esta sesión. El import de archivo también responde `added`. El hub emite `session.updated`.

## Biblia

| Método | Ruta | Query |
|--------|------|-------|
| GET | `/bible/versions` | — |
| GET | `/bible/books` | — |
| GET | `/bible/passage` | referencia o libro + capítulo + rango, y `version` |

La respuesta del pasaje incluye `slides` listos para un ítem `bible`.

## Biblioteca

Prefijo `/library/*`: hace falta operador (ticket de control o access token).

| Método | Ruta | Cuerpo |
|--------|------|--------|
| GET | `/library/items` | query `category`, `q` |
| GET | `/library/items/:id` | |
| DELETE | `/library/items/:id` | |
| GET | `/library/items/:id/original` | archivo original |
| GET | `/library/items/:id/slides/:slideId` | diapositiva renderizada |
| POST | `/library/songs` | `LibrarySongPayload` |
| PUT | `/library/songs/:id` | igual |
| POST | `/library/songs/import` | multipart `.qsp` o `.xml` de Quelea |
| POST | `/library/songs/import-folder` | solo `data/library/songs/import/` |
| POST | `/library/text` | `{ title?, text }` |
| POST | `/library/bible` | `BiblePayload` |
| POST | `/library/upload` | multipart `file`, `title?`, `category?` (`biblias` fuerza esa categoría) |
| POST | `/library/bibles/import-folder` | solo `data/library/bibles/import/` |

Reimportar un Quelea con el mismo título y autor **actualiza**, no duplica. La respuesta trae `imported`, `updated`, `skipped` y los conteos.

## Otros

`POST /parse/document` — operador, multipart PDF. Devuelve páginas/párrafos para armar un ítem de texto. No toca la sesión.

## WebSocket

`GET /api/v1/ws?sessionId=&role=control|output&credential=<wsTicket>`

Al conectar, el hub manda `session.snapshot`. Cada mensaje del hub tiene:

```json
{ "type": "...", "seq": 12, "sessionId": "...", "ts": "ISO-8601", "payload": {} }
```

Tipos de salida: `session.snapshot`, `session.updated`, `error` (`payload.code`, `payload.message`).

### Cliente → hub

Definidos como `ClientToHubMessage` en `@promedia/shared`. Output solo puede enviar `client.hello`, `client.resync` y `live.mediaClock.set`. El resto exige rol `control` (`forbidden` / «output cannot mutate session»).

| `type` | `payload` |
|--------|-----------|
| `client.hello` | opcional. Respuesta: snapshot solo a ese socket |
| `client.resync` | `{ lastSeq }` |
| `session.touch` | `{ note? }` |
| `playlist.itemAdd` | `{ item }` — si es A/V o YouTube y el agente está activo, arranca karaoke para esa fila |
| `playlist.itemUpdate` | `{ id, patch }` (`payload` y/o `order`) |
| `playlist.itemRemove` | `{ id }` — si era el `lyricOverlay`, lo apaga |
| `playlist.reorder` | `{ orderedIds }` |
| `live.go` | `{ itemId }` |
| `live.clear` | — apaga la proyección (el overlay de letra manual sigue si el ítem sigue en el Guion) |
| `live.setSlide` | `{ index }` |
| `live.mediaClock.set` | `{ playing, positionMs? }` — también lo envía Output |
| `live.subtitleAgent.set` | `enabled`, `targetLang`, `fontSize`, `leadMs` (−3 s…0), `itemId?` |
| `live.subtitleAgent.nudge` | `{ delta: -1 \| 1, positionMs?, itemId? }` |
| `live.subtitleAgent.saveLyrics` | `{ itemId? }` guarda la letra de LRCLIB como sugerida |
| `live.setLyricOverlay` | `{ itemId: string \| null, lineIndex? }` — una línea del cancionero sobre vídeo/fondo **sin** cambiar `currentItemId` ni el reloj; `null` oculta |
| `live.setVideoCover` | `{ assetId?, active?, background? }` |
| `live.setSceneMode` | `{ sceneMode }` |
| `live.setWatermark` | `{ enabled }` |
| `live.setTheme` | `themeId?`, `themeOverrides?`, `themeBackground?`, `transitionEffect?` |

Los cambios aceptados se retransmiten a Control y a todos los Output de esa sesión.

Ya no existen `live.subtitleAgent.prepare` («Preparar Guion») ni `live.subtitleAgent.teach` («Corregir letra»). El karaoke se prepara al añadir A/V al Guion o al activar el agente; la letra se resuelve por memoria/título/LRCLIB.
