# Alertas que cubran los modos de falla reales («bot mudo»)

> **Punto del checklist:** add alerting · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P0 antes del primer cliente que pague
> **Tipo:** mixto · **Depende de:** nada (se complementa con monitoreo-de-performance y uptime) · **Esfuerzo:** 1 día de código + 1 h de configuración
> **Archivos principales:** `src/platform/observability/alerts.ts`, `src/modules/whatsapp/pipeline.ts`, `src/platform/queue/stats.ts`, `src/server.ts`, `DEPLOY.md` §22, `.env.example`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
El canal existe y es bueno: `alertPlatform()` en `src/platform/observability/alerts.ts` sale siempre por log JSON (`platform_alert`), por Sentry si hay `SENTRY_DSN` y por un webhook Slack/Discord si hay `ALERTS_WEBHOOK_URL`, con cooldown por (tipo, negocio) y `forgetAlert()` al resolverse. Tiene tests (`test/unit/alerts*`).

Detectores que hoy llaman a `alertPlatform`:
- Token de Meta rechazado: `src/modules/whatsapp/channels.ts` (~l. 201, `TOKEN_ALERT`, critical, cooldown 6 h).
- Webhooks crudos pendientes: `src/modules/whatsapp/rawWebhooks.ts` (~l. 145, `whatsapp_raw_webhooks_pending`).
- Tope mensual del plan: `applyMonthlyCaps()` en `src/modules/whatsapp/pipeline.ts` (~l. 344).
- Correo sin configurar / auth del proveedor: `src/platform/email/email.ts` (~l. 106 y 142).
- DLQ por negocio: `trackDeadJob()` en `src/platform/queue/stats.ts` (5 dead en 10 min), llamado desde `src/platform/queue/worker.ts`.
- SLO de latencia: `checkLatencySlo()` en `src/platform/observability/metrics.ts` — **nunca dispara en producción**: `recordLatency()` no se llama desde ningún módulo (solo desde `test/unit/metrics.test.ts`).

Lo que falta (los modos de falla que dejan a todos los negocios sin servicio y nadie se entera):
- **OpenAI caído / sin saldo / key revocada:** `runAgentTurn()` en `pipeline.ts` (~l. 427) solo hace `log.error("whatsapp_agent_failed")`, manda `generalError` al cliente y avisa al dueño. Sin `alertPlatform` ni `captureError`. Ídem `whatsapp_reply_send_failed` (~l. 462) para fallos de envío a Meta que no son de token. Ojo: el DLQ tampoco lo ve — `shouldRetry()` (`pipeline.ts` ~l. 129) solo relanza si NO es el último intento; en el último el error transitorio cae al mismo `log.error`, el job termina «bien» y `trackDeadJob()` nunca cuenta. El runner (`createAgentRunner` en `agent/runner.ts` ~l. 203-207) solo reporta `openai_after_action`.
- **Token de Meta solo cubre 401/190:** `graph.ts` (`TOKEN_INVALID_CODE = 190`, ~l. 28) marca `tokenInvalid` únicamente con 401/190; cuenta bloqueada, 403, 368, 131031, etc. no alertan (pista V2-53) — deben entrar por la alerta de tasa de envíos fallidos.
- **Cola atascada / backlog:** no hay detector de jobs `pending` viejos ni de worker sin reclamar (`countJobs()` en `src/platform/queue/admin.ts` existe pero no se vigila).
- **Sin mensajes entrantes:** el vigilante viejo (`src/observabilidad/vigilancia.ts`) no se portó; `DEPLOY.md` §22 (~l. 860-880) todavía lo describe junto con `ALERTAS_*`, `SALUD_DETALLE_TOKEN` y `/salud`, que ya no existen (hoy son `ALERTS_*`, `HEALTH_DETAIL_TOKEN`, `/health`).
- **Canales opcionales en producción:** `src/server.ts` (~l. 99) solo imprime `Alertas a la plataforma: log`; con `NODE_ENV=production` y sin Sentry ni webhook nadie recibe nada. `productionConfigWarnings()` (`src/platform/config/requiredSecrets.ts` ~l. 35) no avisa de esto (solo `PUBLIC_BASE_URL` y superadmin): es el lugar natural para la advertencia.

## Objetivo
Que cualquier falla que deje a uno o todos los negocios sin respuesta llegue a un humano de la plataforma en minutos, por un canal que se verificó.

## Alcance
- Alerta `llm_unavailable` (critical) por **tasa** de fallos del agente: N fallos en una ventana (global y por negocio), contando también el error transitorio del último intento. El `captureError` de esos `catch` ya lo agregó `error-tracking`: no lo dupliques. Reusar el patrón ventana+umbral de `trackDeadJob()` (`queue/stats.ts` ~l. 72). `AlertType` es `string` (`alerts.ts` ~l. 35): definir los tipos nuevos como constantes exportadas para que los tests no dependan de literales.
- Alerta `whatsapp_send_failing` (critical) por tasa de `whatsapp_reply_send_failed` que no sean de token.
- Detector periódico (leader loop, como `startMetricsReport`) de cola: jobs `pending` con `run_at` más viejo que X min → `queue_backlog`; `running` vencidos sin reaper → `queue_stuck`.
- Detector «sin entrantes» por negocio con canal conectado y tráfico histórico (umbral configurable, horario del negocio), opcional por env.
- Arranque: con `NODE_ENV=production` y `configuredAlertChannels()` = solo `log`, sumar el aviso a `productionConfigWarnings()` + `log.error` (no tumbar el proceso; decisión abajo).
- Reescribir `DEPLOY.md` §22 con los nombres nuevos y un paso «mandar una alerta de prueba» (script `scripts/sendTestAlert.ts` que llama `alertPlatform` con `type: "test_alert"`).
- Variables nuevas en `.env.example` (el CI corre `scripts/ci/checkEnvExample.mjs`).

## Fuera de alcance
- Activar el SLO de latencia (`recordLatency`): `monitoreo-de-performance`.
- Monitor externo de `/health`: `uptime`. Configurar Sentry, su UI y el `captureError` de `runAgentTurn`: `error-tracking`.
- Alertas de facturación de proveedores: `topes-de-gasto`. Fallback de modelo: `fallback-del-modelo`.
- Statuses de entrega de Meta (`failed`/`delivered`) — si se quiere, ítem aparte.

## Pasos sugeridos
1. Leer `alerts.ts`, `queue/stats.ts`, `metrics.ts` y sus tests para seguir el estilo.
2. Extraer un helper `rateAlert({type, key, threshold, windowMs})` en `src/platform/observability/` (sin deps; este prompt es su dueño: `fallback-del-modelo` y `topes-de-gasto` lo reutilizan) y usarlo en el pipeline (whatsapp importa platform, no al revés: respetar el test de fronteras).
3. Agregar el detector de cola en `src/platform/queue/` con `startLeaderLoop`, registrado desde `server.ts` bajo `RUNS_BACKGROUND`.
4. Detector de entrantes en `src/modules/whatsapp/` registrado vía `startModuleSchedulers`.
5. Tests unitarios con PGlite y reloj inyectado (umbral, cooldown, `forgetAlert` al recuperarse).
6. Docs + `.env.example` + script de alerta de prueba.

## Decisiones que el agente NO toma solo
- ¿Canal de alertas: Slack, Discord, correo, Telegram? ¿Quién lo recibe (y de noche)?
- ¿Producción sin canal de alertas debe **negarse a arrancar** o solo advertir?
- Umbrales iniciales (fallos de LLM por ventana, minutos de backlog, horas sin entrantes).

## Criterios de aceptación
- [ ] Test: N fallos simulados del agente → una sola alerta `llm_unavailable` (cooldown respetado); también cuando el error es transitorio en el último intento (`ctx.isLastAttempt`).
- [ ] Test: job `pending` vencido > umbral → `queue_backlog`; al vaciarse, `forgetAlert`.
- [ ] Test: fallos de envío no-token → `whatsapp_send_failing`.
- [ ] `npx tsx scripts/sendTestAlert.ts` con un webhook local de prueba produce el POST `{text, content}`.
- [ ] `DEPLOY.md` §22 sin referencias a `vigilancia.ts`, `ALERTAS_*`, `/salud`.
- [ ] `npm run typecheck` y `npm test` en verde.
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización").

## Reglas para este trabajo
- Rama propia `prod/alertas` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas (ni la URL real del webhook).
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist de pasos humanos pendientes (crear el webhook del canal, ponerlo en el `.env` del droplet, correr la alerta de prueba allá).
