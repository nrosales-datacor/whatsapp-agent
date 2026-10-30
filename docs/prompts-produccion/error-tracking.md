# Error tracking completo (backend, panel y verificado)

> **Punto del checklist:** add error tracking · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P0 antes del primer cliente que pague
> **Tipo:** mixto · **Depende de:** secretos-fuera-del-repo (el DSN va al `.env` del servidor) · **Esfuerzo:** 4-6 h + 1 h de configuración
> **Archivos principales:** `src/platform/observability/sentry.ts`, `src/server.ts`, `src/modules/whatsapp/pipeline.ts`, `web/src/main.tsx`, `DEPLOY.md` §16, `.env.example`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
Backend — bien encaminado:
- `@sentry/node` 10.54.0 (versión exacta en `package.json`). `initSentry()` en `src/platform/observability/sentry.ts` se llama al tope de `src/server.ts` (~l. 24) antes de escuchar; registra `uncaughtException`/`unhandledRejection`.
- `captureError()` se usa en el router para 500 (`src/platform/http/router.ts`, ~l. 487), en `withSafetyNet` (`src/platform/net/http.ts`), en el runner del agente (`reportError` en `src/modules/whatsapp/agent/runner.ts` ~l. 90), webhooks (WhatsApp y Stripe), suscripciones, recordatorios, cotizaciones, follow-ups, y en cada `alertPlatform`.
- Sin `SENTRY_DSN` todo es no-op y el arranque solo loguea `Sentry: no configurado` (`server.ts` ~l. 98).

Huecos:
- **Errores del pipeline sin reportar:** `runAgentTurn()` en `src/modules/whatsapp/pipeline.ts` hace solo `log.error("whatsapp_agent_failed")` (~l. 427) y `log.error("whatsapp_reply_send_failed")` (~l. 462), sin `captureError`. Si OpenAI tira una excepción no transitoria (key revocada, sin saldo, 400 por contexto), o una transitoria en el último intento (`shouldRetry()` ~l. 129 deja de relanzar), Sentry no se entera. El runner solo reporta cuando ya guardó algo (`reportError(..., { stage: "openai_after_action" })`, `runner.ts` ~l. 207).
- **Error HTTP de última instancia sin sanear:** `reportHttpError()` en `src/server.ts` (~l. 77) hace `console.error` del error completo antes de `captureError`.
- **Sin `release` ni `serverName`:** `Sentry.init` (`initSentry()`, `sentry.ts` ~l. 21-28, solo `dsn`, `environment` y `tracesSampleRate: 0`) no fija `release` (commit) ni filtra datos personales con `beforeSend`; `extra` puede llevar campos sin pasar por `sanitizeLogFields()` (`src/platform/observability/privacy.ts`).
- **Panel React sin tracking:** grep en `web/src` no encuentra Sentry, `ErrorBoundary`, `window.onerror` ni `unhandledrejection`. Un error de render deja la pantalla en blanco y nadie se entera.
- **Producción sin DSN es silencioso:** nada impide arrancar en `NODE_ENV=production` sin `SENTRY_DSN`, y `productionConfigWarnings()` (`src/platform/config/requiredSecrets.ts` ~l. 35) no lo incluye (solo `PUBLIC_BASE_URL` y superadmin).
- **No verificado en producción:** ROADMAP E14 sigue 🔴; `DEPLOY.md` §19.3/§16 refieren a `scripts/verificarProduccion.ts` (l. 719) y `pm2 logs whatsapp-bot` (l. 592-594), que no existen en este árbol: `scripts/` no tiene ese archivo y la app de PM2 hoy se llama `selyon-crm` (`ecosystem.config.cjs` ~l. 17).

## Objetivo
Que todo error no esperado del backend y del panel llegue a Sentry con contexto útil (release, negocio, ruta) y sin datos personales, y que se haya probado una vez en producción.

## Alcance
- `captureError` en los dos `catch` de `runAgentTurn()` (con `businessId`, sin teléfono ni texto).
- `Sentry.init`: `release` desde env (`SENTRY_RELEASE`, env de la que este prompt es dueño y que `logging` reutiliza; que el deploy de `.github/workflows/ci-cd.yml` fija con el SHA), `beforeSend` que pase `extra`/`contexts` por `sanitizeLogFields`, `sendDefaultPii: false` explícito.
- Panel: `AppErrorBoundary` (`web/src/app/AppErrorBoundary.tsx`, este prompt es su dueño) envolviendo la raíz en `main.tsx`, con una pantalla mínima (texto es-CR) + reporte. El boundary por sección, el reseteo por ruta y las páginas 404/500 → `estados-de-error-y-carga`, que extiende este componente. Elegir entre `@sentry/react` (cumpliendo la política de dependencias) o un endpoint propio `POST /api/panel/client-errors` (Zod, tamaño máximo) que reenvía con `captureError`; el cupo por IP/sesión lo pone el limitador general de `rate-limiting` (se mergea después y cubre todas las rutas del router). Decisión abajo.
- Arranque en producción sin DSN → entrada en `productionConfigWarnings()` + `log.error("sentry_missing_in_production")` (advertencia fuerte).
- Script `scripts/sentryTestEvent.ts` que manda un evento de prueba y hace `flushSentry()`.
- Actualizar `DEPLOY.md` §16 (nombres de proceso actuales, evento de prueba, reglas de alerta en Sentry).

## Fuera de alcance
- Canales y detectores de alertas a la plataforma: `alertas`.
- Tracing/performance de Sentry: `monitoreo-de-performance`.
- Pantallas de error/carga del panel (UX) y boundary por sección: `estados-de-error-y-carga`.
- Sacar el `console.error` crudo de `reportHttpError()`: `logging` (migra todos los `console.*`).
- Script de verificación de producción en general: `smoke-tests`.

## Pasos sugeridos
1. Leer `sentry.ts`, `privacy.ts`, `router.ts` (`sendFailure`), `pipeline.ts` (`runAgentTurn`) y `web/src/main.tsx`/router del panel.
2. Backend: `beforeSend` + `release`, test unitario de que un `extra` con teléfono sale enmascarado (mockear el transporte con `Sentry.init({ transport })` o probar la función de saneo aislada).
3. Pipeline: `captureError` y test con agente fake que lanza.
4. Panel: `AppErrorBoundary` en la raíz; si hay endpoint propio, declararlo en el router con `auth` adecuado y test de tamaño máximo.
5. CI: pasar `SENTRY_RELEASE=${{ github.sha }}` al deploy.

## Decisiones que el agente NO toma solo
- ¿Cuenta/plan de Sentry (free alcanza al inicio)? ¿Un proyecto o dos (backend/panel)?
- ¿`@sentry/react` como dependencia nueva o endpoint propio sin dependencia?
- ¿Producción sin DSN debe negarse a arrancar?

## Criterios de aceptación
- [ ] Test: un agente fake que lanza `Error` no transitorio → `captureError` invocado una vez con `businessId` y sin teléfono.
- [ ] Test: el saneo de `beforeSend` enmascara teléfonos y recorta textos.
- [ ] Panel: un componente que lanza en render muestra la pantalla de error y genera un reporte (test de Vitest/E2E en `web/`).
- [ ] `npx tsx scripts/sentryTestEvent.ts` sin DSN termina con mensaje claro (no-op).
- [ ] `npm run typecheck` y `npm test` en verde (y en `web/`).
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización"; mover E14 si corresponde).

## Reglas para este trabajo
- Rama propia `prod/error-tracking` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet, Sentry) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas (el DSN tampoco).
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist humano: crear proyecto(s) en Sentry, poner `SENTRY_DSN` en el droplet, correr el evento de prueba allá, configurar la regla «nuevo issue → email/Slack».
