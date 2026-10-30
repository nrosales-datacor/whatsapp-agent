# SEO y AEO de la landing: sitemap, robots, datos estructurados y canónicas absolutas

> **Punto del checklist:** validate SEO and AEO (sitemap, robots.txt, structured data) · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P1 antes de 5 clientes
> **Tipo:** mixto · **Depende de:** dominio-y-ssl · **Esfuerzo:** 1 día (más el texto nuevo si se reposiciona la landing)
> **Archivos principales:** `src/platform/http/landing.ts`, `landing/index.html`, `landing/privacidad.html`, `landing/terminos.html`, `landing/contrato.html`, `src/platform/http/publicUrl.ts`, `test/security/securityHeaders.test.ts`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
- La landing la sirve `serveLanding` en `src/platform/http/landing.ts:118` (rutas en `PAGES`, `:106`). Es HTML estático de `landing/`.
- **robots.txt existe pero está incompleto**: `serveLanding` (`landing.ts:122-127`) responde `User-agent: * / Allow: / / Disallow: /panel`. No tiene línea `Sitemap:` y el `Disallow: /panel` también bloquea `/panel/signup` (la página del alta self-service, `web/src/app/App.tsx:76`), que es justo la que conviene indexar si el alta se abre.
- **No hay sitemap**: ninguna ruta `/sitemap.xml` en `PAGES` ni en `serveLanding`.
- **No hay datos estructurados**: `grep ld+json landing/` da 0. La landing tiene un FAQ con `<details>` (`landing/index.html:407-440`, sección `.faq`), candidato directo a `FAQPage`; falta también `Organization`/`SoftwareApplication` (AEO: lo que leen los buscadores con IA).
- **Canónica y OG relativas**: `landing/index.html:10` `<link rel="canonical" href="/">` y `:15` `og:image` `/landing/og.png`. Las canónicas deben ser absolutas. Las páginas legales (`privacidad.html`, `terminos.html`, `contrato.html`) no tienen canónica ni `og:*`; solo `description` y favicon.
- `/privacidad` y `/privacidad.html` (y lo mismo terminos/contrato) sirven el mismo HTML en dos URLs sin canónica: contenido duplicado.
- **La landing no habla del producto actual**: `landing/index.html:5-7` dice que el producto en vivo es "Recepcionista IA" ("agentes de IA que atienden…"), mientras la plataforma ya es "Selyon CRM" (`src/platform/brand.ts:8`, gestión multi-sucursal con WhatsApp IA como módulo, ver `PLAN-GESTION.md` §8). Título, description y H1 no contienen "CRM", "agenda", "sucursales" ni "ventas". Tampoco enlaza al alta self-service.
- La base pública ya existe como env: `publicBaseUrl()` en `src/platform/http/publicUrl.ts:14` (`PUBLIC_BASE_URL`).
- CSP de la landing: `landingCsp` + `inlineScriptHashes` (`src/platform/net/securityHeaders.ts`). Un `<script type="application/ld+json">` inline queda hasheado por `inlineScriptHashes`, así que no rompe la CSP (no se ejecuta igual).

## Objetivo
Que buscadores y motores de respuesta (Google, Bing, ChatGPT/Perplexity) indexen las páginas públicas correctas con URLs canónicas absolutas, un sitemap válido y datos estructurados que describan a Selyon y su FAQ.

## Alcance
- `/sitemap.xml` generado en `serveLanding` con `/`, `/privacidad`, `/terminos`, `/contrato` (y `/panel/signup` solo si `SIGNUP_ENABLED`), con URLs absolutas desde `publicBaseUrl()`.
- `robots.txt` con `Sitemap: <base>/sitemap.xml`, `Disallow: /panel/` y `Allow: /panel/signup` cuando el alta está abierta; `Disallow: /api/`.
- Si `APP_ENV=staging` (variable que agregó `staging`), mantener el `noindex` y un robots que bloquee todo.
- Reemplazo de un marcador (p. ej. `%%BASE_URL%%`; este prompt es dueño del mecanismo, `og-y-favicon` y `cache` lo reutilizan) en el HTML servido por la base pública, para canónicas y `og:url`/`og:image` absolutas (cacheado igual que hoy en `readPage`).
- Canónica en las 4 páginas; redirect 301 de `/x.html` → `/x` (o canónica a `/x`).
- JSON-LD: `Organization` (nombre, url, logo) + `SoftwareApplication` (categoría BusinessApplication, oferta con precio solo si el usuario lo aprueba) en `/`, y `FAQPage` generado del FAQ existente (mismo texto, no inventar).
- Si el usuario lo aprueba: título/description/H1 alineados a "Selyon CRM".

## Fuera de alcance
- Imagen OG, favicon e íconos → `og-y-favicon`.
- Cabeceras de caché del sitemap/robots más allá de un `max-age` razonable → `cache`.
- Dominio y certificado → `dominio-y-ssl`. Medición de tráfico → `analytics`.
- Rediseño visual de la landing.

## Pasos sugeridos
1. Leé `serveLanding` y `readPage`; agregá `/sitemap.xml` y el `robots.txt` nuevo usando `publicBaseUrl()` (en dev cae a localhost, está bien).
2. Implementá el reemplazo del marcador de base en `readPage` (antes de calcular la CSP; los hashes no cambian si el marcador no está dentro de `<script>` ejecutable — el JSON-LD sí lleva la base: verificá que `pageCsp` se calcule sobre el HTML ya reemplazado).
3. Agregá JSON-LD y canónicas a los 4 HTML. Validá el JSON-LD parseándolo en un test.
4. Tests nuevos en `test/` (patrón de `test/security/securityHeaders.test.ts`): `GET /sitemap.xml` (XML válido, URLs absolutas, signup solo con la env), `GET /robots.txt` (línea Sitemap), canónica absoluta en `/`, JSON-LD parseable y con `FAQPage`.
5. Si se aprobó el reposicionamiento, ajustá `<title>`, description y H1 (texto que dé el usuario o aprobado por él).

## Decisiones que el agente NO toma solo
- ¿La landing se reposiciona como "Selyon CRM" (gestión + WhatsApp IA) o sigue vendiendo "Recepcionista IA"? ¿Quién aprueba el texto nuevo?
- ¿Dominio canónico definitivo de la landing (¿`selyon.app` o `app.selyon.app`?) y si landing y panel viven en el mismo host.
- ¿Se indexa `/panel/signup` (alta abierta al público) y se publica el precio en el JSON-LD?
- ¿`/contrato` (borrador) debe indexarse o llevar `noindex` hasta que pase por el abogado?

## Criterios de aceptación
- [ ] `curl -s localhost:3000/sitemap.xml` devuelve XML válido con URLs absolutas; `curl -s localhost:3000/robots.txt` incluye `Sitemap:`.
- [ ] El HTML de `/` tiene canónica, `og:url` y `og:image` absolutas y JSON-LD `Organization` + `FAQPage` parseable (test nuevo).
- [ ] `/privacidad.html` redirige o canoniza a `/privacidad` (test nuevo).
- [ ] La CSP de la landing sigue sin `'unsafe-inline'` (`test/security/securityHeaders.test.ts` en verde).
- [ ] Rich Results Test / validator.schema.org sin errores (paso humano, sobre staging).
- [ ] `npm run typecheck` y `npm test` en verde.
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización").

## Reglas para este trabajo
- Rama propia `prod/seo-aeo` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta). Esto no necesita dependencias.
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist de pasos humanos pendientes (registrar el sitemap en Google Search Console y Bing Webmaster, validar el JSON-LD en staging).
