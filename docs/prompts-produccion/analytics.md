# Analytics web: visitas, clics a la demo y embudo del alta (sin cookies)

> **Punto del checklist:** create analytics · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P1 antes de 5 clientes
> **Tipo:** código · **Depende de:** rate-limiting, privacidad-y-terminos · **Esfuerzo:** 1–2 días
> **Archivos principales:** `landing/index.html`, `src/platform/http/landing.ts`, `src/platform/net/securityHeaders.ts`, `src/platform/observability/dailyUsage.ts`, `src/admin/metrics.ts`, `src/signup.ts`, `web/src/modules/auth/SignupPage.tsx`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
Lo que ya existe es **analytics de producto**, no web:
- I5 guarda métricas de uso por negocio y día en `daily_usage` (citas, pagos, logins, usuarios activos): `src/platform/observability/dailyUsage.ts` (`dailyUsageSeries`), y el superadmin las ve en Métricas (`src/admin/metrics.ts`, `UsageRangeQuery`, activación por negocio). El alta deja `business_signed_up` en el audit (`signUp`, `src/signup.ts:136`).

Lo que falta (la parte de crecimiento):
- **Cero medición en la landing**: `grep -rni "plausible\|gtag\|posthog\|umami\|analytics" landing/ src/ web/src` = 0. No se sabe cuántas personas entran, desde dónde (referrer/UTM) ni cuántas tocan los CTA.
- **Los CTA salen a `wa.me` sin rastro**: "Ver demo", "Probá la demo en vivo", "Hablar con ventas" (`landing/index.html:45,67,446,447,484`) son enlaces directos a `https://wa.me/50683658231?...`; el clic no se registra en ningún lado.
- **Embudo del alta sin medir**: `/panel/signup` (`web/src/app/App.tsx:76`, `SignupPage`) no registra vistas ni abandonos; solo se cuenta el alta completada (audit) y la verificación de correo. No hay forma de ver vista → envío → correo verificado → primer login → activación.
- La CSP de la landing (`landingCsp`, `src/platform/net/securityHeaders.ts`) solo permite `connect-src 'self'` y scripts propios por hash: cualquier proveedor externo exige tocar la CSP; uno propio no.
- No se setean cookies en la landing (por eso hoy no hace falta banner de cookies): una solución con cookies o fingerprinting cambiaría eso.

## Objetivo
Poder responder cada semana: visitas a la landing por fuente, clics a la demo/ventas, vistas del alta, altas completadas y verificadas, y negocios activados, sin cookies ni datos personales.

## Alcance (opción por defecto: propia, sin terceros, si el usuario la aprueba)
- Endpoint público con el router declarativo, igual que el alta: `route({ method: "POST", path: "/public/events", auth: "public", body: … })` (patrón de `/auth/signup` en `src/signup.ts`, `signupRoutes`), o sea bajo `/api/panel/` (`PANEL_API_PREFIX`, `src/platform/http/router.ts:59`). No inventes un `/api/events` suelto: `src/app.ts` responde 404 a todo `/api/*` que no sea `/api/panel/*` (rama "Cualquier otra ruta bajo /api", ~`app.ts:118`). El router exige Origin del mismo host en POST (CSRF, `router.ts:394-396`): `sendBeacon` same-origin lo manda, verificalo en el test. Usá `navigator.sendBeacon`, que acepte solo una lista cerrada de eventos (`landing_view`, `cta_demo_click`, `cta_sales_click`, `signup_view`, `signup_submit`) + `path`, `referrer` reducido a dominio y `utm_source/medium/campaign` validados con Zod. Sin IP guardada, sin user-agent completo, sin id de visitante.
- Tabla agregada por día y evento/fuente (contadores con upsert), migración Drizzle nueva; rate limit por IP con el limitador genérico que dejó `rate-limiting` (no crees otro).
- Script mínimo inline en la landing (hash CSP automático vía `inlineScriptHashes`) que manda `landing_view` y engancha los clics a `wa.me` antes de abrir el enlace.
- `SignupPage` manda `signup_view` / `signup_submit`; el alta completada y la verificación salen del audit existente.
- Una línea en `landing/privacidad.html` que describa la medición (agregada, sin cookies, sin IP). `privacidad-y-terminos` ya está mergeado y no la incluye: es de este prompt.
- Vista "Crecimiento" en Métricas del superadmin (`src/admin/metrics.ts` + panel admin): serie diaria y embudo; export CSV como los reportes de I5.

## Fuera de alcance
- Banner de cookies: hoy no aplica; si se elige un proveedor con cookies, frená y consultá al usuario (sería un ítem nuevo).
- Métricas técnicas, latencias y errores → `monitoreo-de-performance`, `error-tracking`.
- SEO y Search Console → `seo-aeo`.

## Pasos sugeridos
1. Confirmá con el usuario propio vs. proveedor. Si es proveedor (Plausible/Umami cloud/Cloudflare Web Analytics), el trabajo se reduce a un `<script>` + CSP (`script-src`/`connect-src` del dominio del proveedor) + texto en la privacidad; no hagas `npm install`.
2. Si es propio: esquema + migración (probada en PGlite), servicio con upsert, ruta `auth: "public"` con Zod y rate limit, test de que rechaza eventos fuera de la lista, de que un POST sin Origin da 403 `forbidden_origin` y de que no guarda IP.
3. Script de la landing con `sendBeacon`; verificá que la CSP sigue sin `'unsafe-inline'` (`test/security/securityHeaders.test.ts`).
4. Eventos del `SignupPage` (y su mock en `web/src/lib/mockApi.ts`).
5. Vista de superadmin + test de la consulta del embudo.

## Decisiones que el agente NO toma solo
- ¿Analytics propio (sin costo, sin terceros) o un proveedor (Plausible ~9 USD/mes, Umami, Cloudflare gratis)? ¿Se acepta cualquier cosa que ponga cookies (exigiría banner)?
- ¿Qué fuentes/UTM se van a usar en las campañas para que la vista las agrupe?
- ¿Se mide también uso dentro del panel (pantallas visitadas) o alcanza con `daily_usage`?

## Criterios de aceptación
- [ ] Abrir `/` en dev y tocar "Ver demo" suma `landing_view` y `cta_demo_click` en la tabla del día (test de integración sobre PGlite).
- [ ] El endpoint rechaza eventos fuera de la lista (400) y aplica rate limit (429); no persiste IP ni user-agent (test).
- [ ] La landing no setea cookies (`set-cookie` ausente, test) y la CSP sigue sin `'unsafe-inline'`.
- [ ] El superadmin ve el embudo vista → alta → verificada → activada por rango de fechas.
- [ ] `npm run typecheck` y `npm test` en verde (y en `web/`).
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización").

## Reglas para este trabajo
- Rama propia `prod/analytics` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist de pasos humanos pendientes (aplicar la migración en producción, armar los links con UTM de las campañas, revisar la vista después de una semana).
