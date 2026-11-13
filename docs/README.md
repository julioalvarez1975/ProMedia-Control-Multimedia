# Documentación de ProMedia

ProMedia proyecta contenido de culto o evento: una ventana **Control** (operador) y una ventana **Output** (proyector). El estado en vivo vive en el hub y se reparte por WebSocket.

El [README de la raíz](../README.md) es la guía de arranque y de uso en sala. Esta carpeta es la referencia del código.

| Documento | Para qué |
|-----------|----------|
| [Arquitectura](arquitectura.md) | Piezas del monorepo, flujo Control → Output, tipos de ítem |
| [API y protocolo](api.md) | REST `/api/v1`, mensajes WebSocket, autenticación |
| [Datos en disco](datos.md) | Biblioteca, guiones, subtítulos, branding (todo bajo `data/`, gitignored) |
| [Desarrollo](desarrollo.md) | Scripts, tests, CI, Docker y empaquetado portable |
| [Cambios recientes](cambios.md) | Qué se modificó en este lote (letra overlay, editor, settings, karaoke) |

Código de referencia del protocolo: `packages/shared/src/index.ts`. Rutas HTTP: `apps/hub/src/routes.ts`. Socket: `apps/hub/src/ws-hub.ts`.
