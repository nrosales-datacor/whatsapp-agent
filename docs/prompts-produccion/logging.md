# Logging estructurado en todo el backend + access log

> **Punto del checklist:** add logging · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P1 antes de 5 clientes
> **Tipo:** mixto · **Depende de:** error-tracking (reusa su env de release) · **Esfuerzo:** 4-6 h
> **Archivos principales:** `src/platform/observability/log.ts`, `src/platform/http/router.ts`, `src/app.ts`, `src/server.ts`, `src/platform/net/scheduler.ts`, `src/platform/storage/supabaseStorage.ts`, `DEPLOY.md` §6b

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
Lo que ya está bien:
- `log.info/warn/error` en `src/platform/observability/log.ts`: una línea JSON por evento a stdout, sin dependencias, con `sanitizeLogFields()` (`privacy.ts`) que enmascara teléfonos y reduce textos a su largo. ~117 usos en `src/`.
- El router (`panelApi` en `src/platform/http/router.ts`, ~l. 503) crea `requestId`, lo devuelve en `x-request-id` y lo ata a `ctx.log` (`boundLogger`). Los 500 se loguean con el detalle y el cliente recibe un mensaje genérico.
- `DEPLOY.md` §6b documenta `pm2-logrotate@3.0.0` con retención corta.

Lo que falta:
- **29 llamadas `console.*` en 7 archivos** (sin contar `log.ts`, que es el sink, ni comentarios en `sentry.ts`/`privacy.ts`) siguen fuera del formato: `src/server.ts` (13: arranque, apagado, `reportHttpError()` ~l. 78 con el error crudo), `src/platform/observability/metrics.ts` (4, reporte `[metrics] …` ~l. 127-145), `src/platform/auth/sessionToken.ts` (3), `src/platform/crypto/secrets.ts` (3), `src/platform/net/scheduler.ts` (2, ~l. 56-60, ticks), `src/platform/storage/supabaseStorage.ts` (2, ~l. 109 y 116, incluye el `path` del archivo), `src/platform/net/clientIp.ts` (2). No pasan por el saneo ni se pueden filtrar por campo. ROADMAP F14 y H12 lo marcan pendiente.
- **Sin access log:** ninguna línea por request con método, ruta, status y duración — ni en `panelApi` ni en el handler raíz de `src/app.ts` (webhook de WhatsApp, Stripe, `/health`, estáticos). Ante un reclamo («no me cargó el panel a las 10») no hay rastro.
- **Sin nivel configurable:** no hay `LOG_LEVEL`; `info` siempre sale (los ticks del scheduler llenan el log).
- **Sin campos de servicio:** las líneas no llevan `role` (web/worker) ni `release`, necesarios con `ROLE=web` + `ROLE=worker` (DEPLOY §21).
- `DEPLOY.md` sigue diciendo `pm2 logs whatsapp-bot` / «Agente escuchando…» (§6 ~l. 120, §12 ~l. 279, mantenimiento ~l. 988), nombres viejos: la app de PM2 hoy es `selyon-crm` (`ecosystem.config.cjs` ~l. 17) y el arranque imprime `… escuchando en http://localhost:…` (`server.ts` ~l. 96).

## Objetivo
Que el 100 % de lo que imprime el backend sea JSON saneado y que cada request deje una línea buscable por `requestId`, negocio, ruta y status.

## Alcance
- Migrar los `console.*` de `src/` a `log.*` (en `metrics.ts`, pasá el tick a `log.*` tal cual: el rediseño a `metrics_snapshot` es de `monitoreo-de-performance`; el `console.error` de `reportHttpError()` es de este prompt) (excepto los mensajes de ayuda de `secrets.ts` que se imprimen antes de que exista el logger si así conviene: justificar cada excepción con un comentario).
- Access log: en `panelApi` (`log.info("http_request", {requestId, route, status, durationMs, businessId?, userId?})`) y un wrapper equivalente en `createAppHandler`/`createWorkerHandler` de `src/app.ts` para las rutas fuera de la API (sin query string: puede llevar tokens, p. ej. `/health?token=`). `/health` y estáticos con muestreo o a nivel `debug`.
- `LOG_LEVEL` (`debug|info|warn|error`, default `info`) en `log.ts` + `.env.example`.
- Campos base en cada línea: `role`, `release` (la env `SENTRY_RELEASE` que dejó `error-tracking` con el SHA del deploy; no crees otra).
- Un test de arquitectura simple: grep de `console.` en `src/` fuera de una lista permitida falla el test.
- Actualizar `DEPLOY.md` (§6b y comandos `pm2 logs` con los nombres del `ecosystem.config.cjs` actual) con ejemplos de `jq` para filtrar por `requestId`/`businessId`.

## Fuera de alcance
- Métricas y latencias agregadas: `monitoreo-de-performance`.
- Envío a un colector externo (Better Stack, Loki, Datadog): decisión abajo; si se elige, ítem aparte.
- Alertas sobre los logs: `alertas`. Reporte a Sentry: `error-tracking`.

## Pasos sugeridos
1. `grep -rn "console\." src` y clasificar cada uso.
2. Extender `log.ts` con nivel y campos base; mantener cero dependencias.
3. Access log en `router.ts` (medir en `panelApi` alrededor de `dispatch`/`sendFailure`) y en `src/app.ts`.
4. Test `test/unit/log.test.ts`: nivel filtra, campos base presentes, query string nunca aparece.
5. Test de arquitectura `console.` (junto al de fronteras entre módulos).
6. Docs.

## Decisiones que el agente NO toma solo
- ¿Mandar los logs a un servicio externo (cuál, costo, residencia de datos) o quedarse con `pm2` + logrotate en el droplet?
- Retención de logs deseada (días).

## Criterios de aceptación
- [ ] `grep -rn "console\." src` solo devuelve la lista permitida documentada en el test.
- [ ] Test: un request a `/api/panel/me` deja una línea `http_request` con `status`, `durationMs` y `requestId` igual al header `x-request-id`.
- [ ] Test: `/health?detail=1&token=X` nunca loguea el token.
- [ ] `LOG_LEVEL=warn` suprime `info` (test).
- [ ] `npm run typecheck` y `npm test` en verde.
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización"; marcar lo de F14/H12 que se cierre).

## Reglas para este trabajo
- Rama propia `prod/logging` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta). No hace falta ninguna para esto.
- Sin secretos ni datos personales en código, docs, logs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist humano (confirmar `pm2-logrotate` instalado en el droplet, ajustar `LOG_LEVEL` allá).
