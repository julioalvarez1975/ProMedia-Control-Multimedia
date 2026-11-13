# Desarrollo

Trabajá en la raíz del repo. Node **≥ 20**. El `packageManager` fijado es **pnpm 10.33.4**.

```bash
pnpm install
pnpm dev          # hub + web (scripts/dev.mjs)
pnpm dev:hub      # solo hub, tras build de packages
pnpm dev:web
pnpm typecheck
pnpm test         # tests del hub (sin ASR local pesado en CI)
pnpm build
```

Atajos de doble clic en la raíz: `start-mac.command` / `Abrir-ProMedia.command`, `start-windows.bat`, `start-linux.sh`. Usan `.promedia-dev.lock`: la segunda instancia no mata la primera.

Una sola instancia. Si el puerto está tomado:

```bash
lsof -nP -iTCP:8787 -sTCP:LISTEN
lsof -nP -iTCP:5173 -sTCP:LISTEN
curl -s http://localhost:8787/health
```

Variables: copiá `.env.example`. Las de karaoke, GAM y bind están comentadas ahí y resumidas en el README raíz.

## Paquetes

`pnpm-workspace.yaml` incluye `apps/*` y `packages/*`. `build:packages` compila, en orden, `@promedia/shared`, `@promedia/i18n`, `@promedia/media` y `@promedia/item-types`. Hub y web consumen el `dist/` de esos paquetes, no el fuente.

## Tests

`pnpm --filter @promedia/hub test` corre `apps/hub/scripts/run-tests.mjs`. En CI (`--ci`) se omiten los smokes que necesitan modelos locales.

Smoke de sesión contra un hub ya levantado:

```bash
pnpm --filter @promedia/hub start
node scripts/smoke-hub-ws.mjs
```

Otros scripts en `scripts/`: `smoke-quelea-import.mjs`, `smoke-bible-import.mjs`, `import-bibles.mjs`, `verify-subtitle-asr.mjs`. Ensayo de sala: [scripts/qa-church-event.md](../scripts/qa-church-event.md).

## CI

`.github/workflows/ci.yml` en `main` y en pull requests: `pnpm install --frozen-lockfile`, `pnpm run typecheck`, tests del hub con `--ci`, `pnpm run build`. Node 22.

## Docker

```bash
docker compose -f docker/compose.yml up --build
```

Imagen `docker/Dockerfile` (Node 22, context = raíz). Publica el hub en **8787** con volumen `promedia-data`. El compose no sirve la SPA: en LAN el camino habitual sigue siendo `pnpm dev`. `MEDIA_ADAPTER=s3` más `S3_*` es el stub; si faltan datos, cae a disco.

## Portable

```bash
pnpm build
./portable/pack.sh
```

Deja `portable/dist/{hub,web,data,start.sh}`. Detalle en [portable/README.md](../portable/README.md).

## Dónde tocar qué

| Cambio | Archivo |
|--------|---------|
| Forma de un mensaje o de un ítem | `packages/shared/src/index.ts` (y temas en `themes.ts`) |
| Cómo se dibuja un tipo | `packages/item-types/src/<tipo>/` y `registry.ts` |
| Ruta HTTP nueva | `apps/hub/src/routes.ts` |
| Regla de sesión / broadcast | `apps/hub/src/session-store.ts`, `ws-hub.ts` |
| Karaoke | `apps/hub/src/subtitle-*.ts` |
| Pantalla de Control u Output | `apps/web/src/pages/`, `components/` |
| Cadenas de UI | `packages/i18n/locales/*.json` |
