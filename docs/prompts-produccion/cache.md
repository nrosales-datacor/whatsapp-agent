# Caché HTTP y compresión: index del panel, landing con validadores y gzip

> **Punto del checklist:** set up caching · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P1 antes de 5 clientes
> **Tipo:** mixto · **Depende de:** dominio-y-ssl, seo-aeo · **Esfuerzo:** 0,5–1 día
> **Archivos principales:** `src/platform/http/staticPanel.ts`, `src/platform/http/landing.ts`, `src/platform/http/router.ts`, `DEPLOY.md`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
Lo que ya está bien (no rehacer):
- Assets hasheados de Vite: `serveStaticPanel` (`src/platform/http/staticPanel.ts:116-120`) → `public, max-age=31536000, immutable`. Fuentes (`:124-129`) e íconos PWA igual; `sw.js` con `no-cache` y manifest `max-age=3600`.
- API JSON: el router fija `no-store` (`src/platform/http/router.ts:506`); `/health`, webhook de WhatsApp y de Stripe también `no-store`.
- Landing en memoria en producción (`pageCache`/`assetCache` en `landing.ts`).

Lo que falta:
- **El `index.html` del panel sale sin `cache-control`**: fallback SPA de `serveStaticPanel` (`staticPanel.ts:170`, `res.writeHead(200, { "content-type": "text/html; charset=utf-8" })`). Sin cabecera el navegador aplica caché heurística: tras un deploy puede seguir usando un index viejo que apunta a `/panel/assets/*` que ya no existen → pantalla en blanco. Debe ser `no-cache` (o `no-store`).
- **Landing sin validadores**: `serveHtml` (`landing.ts:86-93`) manda `no-cache` sin `ETag` ni `Last-Modified`, así que cada visita revalida y **siempre** baja el HTML completo (no hay 304). `grep -rn etag src` da 0.
- **Assets de la landing sin versión**: `/landing/*` y `/favicon.svg` con `public, max-age=86400` (`landing.ts:133`) y nombres fijos (`estilos.css`, `og.png`): un cambio de CSS tarda hasta 24 h en verse y puede mezclar HTML nuevo con CSS viejo.
- `robots.txt` (`landing.ts:122-127`) sin `cache-control`.
- **Sin compresión**: Node no comprime (`grep gzip src` = 0) y el Caddyfile de `DEPLOY.md` (§ "Caso A", `reverse_proxy localhost:3001`) no tiene `encode`. El bundle JS del panel, `estilos.css` (34 KB) y la API JSON viajan sin gzip/zstd. En el caso nginx tampoco hay `gzip on` documentado.

## Objetivo
Que ningún deploy deje clientes con un panel roto por caché, que la landing responda 304 cuando no cambió, y que todo el texto viaje comprimido.

## Alcance
- `cache-control: no-cache` en el index del panel (fallback SPA) y en `robots.txt`/`sitemap.xml` (`sitemap.xml` lo crea `seo-aeo`, ya mergeado).
- `ETag` (hash del contenido, calculado una vez y cacheado) + manejo de `If-None-Match` → 304 en las páginas de la landing, el index del panel y los assets de `/landing/*`.
- Versionado de assets de la landing: `?v=<hash corto>` agregado al servir el HTML (reemplazo en `readPage`), y entonces `max-age=31536000, immutable` para `/landing/*` con query de versión.
- Compresión en el proxy: `encode zstd gzip` en el Caddyfile y `gzip on; gzip_types …` en el bloque nginx, tanto en las plantillas de `deploy/` (las crea `dominio-y-ssl`) como en `DEPLOY.md`. No comprimir en Node.
- Tests de cabeceras (patrón de `test/security/securityHeaders.test.ts`).

## Fuera de alcance
- CDN delante del droplet → decisión de infraestructura, ver `dominio-y-ssl`.
- Caché de datos en el servidor (consultas, Redis): fuera del checklist, ítem aparte si hace falta.
- Peso de imágenes y fuentes → `optimizar-imagenes`.

## Pasos sugeridos
1. Agregá un helper chico (sin dependencias) `etagOf(buf)` con `createHash("sha1")` y uno `notModified(req, res, etag)`; usalo en `serveHtml`, los assets de la landing y el fallback SPA (`readIndex`).
2. Fijá `no-cache` en el fallback SPA; test: `GET /panel/clientes` trae `cache-control: no-cache` y `etag`; con `If-None-Match` igual → 304 sin cuerpo.
3. Versionado: en `readPage` (que ya reemplaza el marcador de base de `seo-aeo`: sumá tu reemplazo sin romper el suyo), reemplazá `href="/landing/estilos.css"` y similares por `…?v=<hash>`; `readAsset` ignora la query; cabecera immutable solo si viene `v`.
4. Ojo con la CSP de la landing: `pageCsp` se calcula sobre el HTML servido; el reemplazo no toca `<script>` inline, pero verificá que los hashes no cambien (test existente).
5. `DEPLOY.md`: agregá `encode zstd gzip` al Caddyfile y el bloque gzip a nginx; documentá cómo verificarlo con `curl -H 'Accept-Encoding: gzip' -I`.

## Decisiones que el agente NO toma solo
- Aplicar el cambio del Caddyfile/nginx en el droplet de producción (lo hace el usuario o con su confirmación explícita).

## Criterios de aceptación
- [ ] `curl -I localhost:3000/panel/` → `cache-control: no-cache` y `etag`; repetir con `If-None-Match` → 304 (test nuevo).
- [ ] `curl -I localhost:3000/` → `etag`; 304 con `If-None-Match` (test nuevo).
- [ ] El HTML de `/` referencia `/landing/estilos.css?v=…` y ese asset sale `immutable` (test nuevo).
- [ ] `DEPLOY.md` documenta `encode` en Caddy y gzip en nginx; verificado en staging con `content-encoding` (paso humano).
- [ ] `npm run typecheck` y `npm test` en verde.
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización").

## Reglas para este trabajo
- Rama propia `prod/cache` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta). Esto se hace con `node:crypto`, sin paquetes.
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist de pasos humanos pendientes (editar el Caddyfile/nginx del droplet y recargar, verificar `content-encoding` en staging).
