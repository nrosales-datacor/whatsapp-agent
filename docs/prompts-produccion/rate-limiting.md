# Rate limit general de la API (más allá de las credenciales)

> **Punto del checklist:** add rate limiting · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P1 antes de 5 clientes
> **Tipo:** mixto · **Depende de:** dominio-y-ssl (plantillas de proxy en `deploy/`) · **Esfuerzo:** 1,5–2 días
> **Archivos principales:** `src/platform/auth/loginRateLimit.ts`, `src/platform/http/router.ts`, `src/platform/http/routeTypes.ts`, `src/app.ts`, `src/platform/net/clientIp.ts`, `src/modules/whatsapp/inbox.ts`, `DEPLOY.md`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
Lo que YA está (no rehacer):
- Rate limit de credenciales en memoria, tres capas (por IP, lockout progresivo por par IP+clave, freno global por usuario con IPs conocidas): `checkLoginLimit` en `src/platform/auth/loginRateLimit.ts:99`, mapas `byIp/byPair/byUserGlobal` (`:68-71`). Se aplica ANTES de scrypt vía `guardCredentialAttempt` (`src/modules/team/identity.ts`, ámbitos `login|forgot|password|totp|invitation|signup|verify`) y en `adminLogin` (`src/admin/session.ts`). Tests: `test/security/auth.test.ts` ("rate limit por IP…", "lockout por par…", "freno global…"), `test/reliability/identityEmail.test.ts` (anti-bombardeo de `forgot`), `test/reliability/signup.test.ts` ("tope por IP").
- IP real con `TRUST_PROXY` (`getClientIp`, `src/platform/net/clientIp.ts`; DEPLOY.md §23).
- Tope de cuerpo por ruta (`maxBodyBytes`, `src/platform/http/routeTypes.ts:136`) y freno de turnos del bot por cliente de WhatsApp (`applyClientBrakes`, `src/modules/whatsapp/pipeline.ts:294`, aviso `clientRateLimited`).
- Un solo proceso (`ecosystem.config.cjs`, app `selyon-crm`, `ROLE: "all"`), así que el estado en memoria es coherente hoy.

Lo que falta:
1. **Ningún límite para rutas autenticadas.** Un usuario (o una sesión robada / script de un cliente) puede martillar `GET /clients/export.csv`, `GET /reports/*`, `POST /clients/import`, `GET /appointments` o `/availability` sin freno; todas pegan a Postgres en el mismo event loop que atiende los webhooks de todos los negocios.
2. **Rutas públicas sin presupuesto por IP fuera de credenciales:** `/ping`, `GET /auth/invitations/:token`, `/auth/signup/config`, `/health`, y los webhooks (`WHATSAPP_WEBHOOK_PATH` y `STRIPE_WEBHOOK_PATH` en `src/app.ts`) antes de validar la firma (la verificación HMAC sí corre sobre el cuerpo completo).
3. **Sin límite en el proxy:** DEPLOY.md §8 (Caddy/nginx) no configura `limit_req` ni equivalente.
4. El estado se pierde en cada `pm2 reload` (aceptable) y no escala a varias instancias web (documentarlo).
5. **Reabrir una conversación manda plantillas COBRADAS sin freno:** `reopenConversation` (`src/modules/whatsapp/inbox.ts:292`) solo rechaza si la ventana de 24 h está abierta, y la ventana la abre el CLIENTE al escribir, no la plantilla enviada. 50 clics en "Reabrir" (`POST /whatsapp/conversations/:id/reopen`, `src/modules/whatsapp/routes.ts:212`) = 50 plantillas al mismo número, cada una facturada por Meta y contada en `incrementAiUsage`. (Pista V2-49, vigente.)
6. **IPv6 sin agrupar:** `checkLoginLimit` usa la IP tal cual (`getClientIp` solo normaliza `::ffff:` en `clientIp.ts:37`); con un /64 propio un atacante rota direcciones y esquiva el límite por IP de credenciales.

## Objetivo
Que ningún actor (anónimo o autenticado) pueda degradar el servicio para los demás negocios con un volumen alto de requests, con respuestas 429 claras y sin romper el uso normal del panel ni los webhooks de Meta/Stripe.

## Alcance
- Limitador genérico en memoria en `src/platform/http/` (token bucket o ventana deslizante, sin dependencias) reutilizable, con purga periódica como `loginRateLimit.ts`. Este prompt es su dueño único: `analytics` lo reutiliza, y el presupuesto por IP de rutas `public` cubre también el endpoint de errores del panel si `error-tracking` lo creó.
- En el router: presupuesto por sesión (`userId`+`businessId`) para `auth: "user"` y por IP para `public`; campo opcional `rateLimit` en `RouteSpecBase` (`routeTypes.ts`) para rutas caras (export CSV, import, reportes, availability) con un cupo menor. 429 con `Retry-After` y el mismo formato JSON que `tooManyAttempts` (`src/platform/http/errors.ts`).
- Límite por IP holgado para `/health` y los webhooks en `src/app.ts` (sin cortar a Meta: umbral alto y medido).
- Candado de reapertura: a lo sumo 1 plantilla de reapertura por conversación cada N horas (persistido en la base, no en memoria: mirar el último mensaje saliente `reopenTemplateSent` de esa conversación), 429/409 con código propio si se repite.
- Clave del límite por IP: agrupar IPv6 por /64 (en `loginRateLimit.ts` y en el limitador nuevo).
- Defaults por env con nombres documentados en `.env.example` (`ci:env` en verde).
- Bloque opcional de `limit_req` (nginx) / `rate_limit` (Caddy) como segunda capa, en las plantillas de `deploy/` que dejó `dominio-y-ssl` y en DEPLOY.md.

## Fuera de alcance
- Topes de gasto de OpenAI / costo por negocio → `topes-de-gasto` y `limites-de-tokens`.
- Rate limit distribuido (Redis) para varias instancias web: solo documentar cuándo hace falta.
- Inventario de auth por ruta → `auth-en-endpoints`.

## Pasos sugeridos
1. Leé `loginRateLimit.ts` y el pipeline de `createRouter` (`router.ts`) para ubicar el chequeo después de resolver la sesión y antes del handler.
2. Implementá el limitador + tests unitarios (ventana, purga, `Retry-After`).
3. Enganchalo en el router (por sesión / por IP) y marcá con `rateLimit` las rutas caras de `clients`, `reports`, `scheduling`.
4. Límite holgado en `src/app.ts` para `/health` y webhooks.
5. Test de integración: N+1 requests a `GET /clients/export.csv` con la misma sesión → 429; otra sesión del mismo negocio no se ve afectada; el E2E del panel sigue en verde (umbrales generosos).
6. Docs: `.env.example`, DEPLOY.md.

## Decisiones que el agente NO toma solo
- Umbrales por defecto (propuesta: 300 req/min por sesión, 20/min para export/import/reportes, 60/min por IP en públicas). El usuario confirma.
- Ventana del candado de reapertura (propuesta: 1 cada 24 h por conversación).
- Si se configura el límite en el proxy del droplet (requiere tocar producción).

## Criterios de aceptación
- [ ] Tests nuevos: 429 por sesión en una ruta cara, aislamiento entre sesiones, 429 por IP en una ruta pública, webhooks no cortados bajo el umbral.
- [ ] Test: dos `POST /whatsapp/conversations/:id/reopen` seguidos → la segunda NO llama a `api.sendTemplate` (doble de la API) y responde error.
- [ ] Test: dos IPv6 del mismo /64 comparten el contador de login.
- [ ] Respuesta 429 con `Retry-After` y `code: "too_many_requests"` (o el código existente) en JSON.
- [ ] `npm run typecheck`, `npm test`, `npm run ci:env` y `npm run test:e2e` en verde (y en web/ si toca el panel).
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización").

## Reglas para este trabajo
- Rama propia `prod/rate-limiting` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist de pasos humanos pendientes (umbrales finales, bloque del proxy en el droplet).
