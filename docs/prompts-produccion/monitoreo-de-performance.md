# Monitoreo de performance que mida de verdad

> **Punto del checklist:** include performance monitoring · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P1 antes de 5 clientes
> **Tipo:** código · **Depende de:** logging (el access log del router es la fuente de la latencia HTTP) · **Esfuerzo:** 1 día
> **Archivos principales:** `src/platform/observability/metrics.ts`, `src/modules/whatsapp/pipeline.ts`, `src/platform/queue/stats.ts`, `src/platform/http/router.ts`, `src/admin/routes.ts`, `DEPLOY.md` §18

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
- `src/platform/observability/metrics.ts` acumula por negocio eventos (`recordEvent`) y latencias (`recordLatency`), calcula p95 y alerta por SLO (`checkLatencySlo`, `METRICS_SLO_LATENCY_P95_MS`). `startMetricsReport()` se arranca en `src/server.ts` (~l. 105) y vuelca a `console.log` cada `METRICS_INTERVAL_MIN`.
- **`recordLatency()` no se llama desde ningún código de producción** (grep: solo `test/unit/metrics.test.ts`). `recordEvent()` solo desde `ingestWhatsAppMessage` en `src/modules/whatsapp/ingest.ts` (~l. 168). Resultado: el reporte nunca tiene latencias y el SLO de latencia es letra muerta.
- `runAgentTurn()` en `src/modules/whatsapp/pipeline.ts` no mide la duración del turno del agente ni de las llamadas a OpenAI (`src/modules/whatsapp/agent/runner.ts`).
- Cola: `recordJobEvent()` en `src/platform/queue/stats.ts` guarda duración por tipo de job en memoria; `getQueueStats()` (`stats.ts` ~l. 53, reexportado en `src/platform/queue/index.ts` ~l. 27) **solo lo leen los tests** (`test/reliability/queueWorker.test.ts`, `test/unit/queue.test.ts`): ninguna ruta ni loop lo expone o loguea. `countJobs()` (`src/platform/queue/admin.ts` ~l. 141) da la profundidad por tipo/estado.
- HTTP: el router (`panelApi` en `src/platform/http/router.ts`, ~l. 503) genera `requestId` pero no registra status ni duración por request; no hay latencia por ruta.
- Sentry: `initSentry()` en `src/platform/observability/sentry.ts` con `tracesSampleRate: 0` (sin tracing).
- Todo se pierde en cada restart: no hay serie persistida de latencias. `daily_usage` (`src/platform/observability/dailyUsage.ts`) guarda solo métricas de producto.
- El tick de `startMetricsReport()` (`metrics.ts` ~l. 117-145) imprime con `console.log` en `5f976e1`; `logging` (ya mergeado) lo pasa a `log.*` sin rediseñarlo.
- `DEPLOY.md` §18 (~l. 627-640) está desactualizado: habla de `METRICAS_INTERVALO_MIN`, `grep metricas` y un formato `[metricas] … cola pendiente` que ya no existe (hoy `[metrics] tenant=…`).

## Objetivo
Poder responder con datos «¿el bot de este negocio va lento?», «¿qué ruta del panel está lenta?» y «¿la cola da abasto?», y que el SLO de latencia alerte de verdad.

## Alcance
- Medir el turno del agente en `runAgentTurn()` (desde la recepción del mensaje hasta enviar la respuesta) y llamar `recordLatency(businessId, ms)`; loguear además `agent_turn_ms` y `openai_ms` en el evento `whatsapp_reply_sent`.
- Agregado en memoria p50/p95 por ruta alimentado desde el access log que dejó `logging` en `panelApi` (no agregues otro log por request), volcado en el mismo tick de `startMetricsReport`.
- Volcar `getQueueStats()` + profundidad (`countJobs()`) en el tick, como log estructurado (`log.info("metrics_snapshot", …)`), no `console.log` libre.
- Ruta superadmin `GET /admin/ops` (auth `superadmin`, Zod) que devuelve la foto actual (latencias por negocio, cola, rutas lentas) — para mirar sin SSH.
- Opcional, a decidir: `tracesSampleRate` bajo (p. ej. 0.05) vía env `SENTRY_TRACES_SAMPLE_RATE`.
- Actualizar `DEPLOY.md` §18.

## Fuera de alcance
- Alertas nuevas (LLM caído, backlog): `alertas`.
- Migrar los `console.*` restantes: `logging`.
- Prometheus/Grafana o métricas persistidas en tablas: queda como decisión (ver abajo).
- Performance del frontend (Web Vitals): `redes-lentas` / `analytics`.

## Pasos sugeridos
1. Leer `metrics.ts`, `queue/stats.ts`, `router.ts` (`panelApi`, `dispatch`, `sendFailure`) y `pipeline.ts` (`runAgentTurn`, `handleTurn`).
2. Instrumentar el turno con `performance.now()`; inyectar el reloj para test.
3. Agregar en `metrics.ts` un `recordRouteLatency(route, ms)` con ventana deslizante acotada (mismo patrón `MAX_LATENCY_SAMPLES`).
4. Reescribir el tick a un único `log.info("metrics_snapshot", {...})` por negocio/ruta/tipo de job.
5. Ruta `/admin/ops` en `src/admin/routes.ts`; tipar la respuesta.
6. Tests: el pipeline con un agente fake lento cruza el SLO y dispara la alerta; el router registra la duración; `/admin/ops` exige superadmin.

## Decisiones que el agente NO toma solo
- ¿Activar tracing de Sentry (consume cuota del plan de Sentry)? ¿Con qué sample rate?
- ¿Persistir métricas (tabla con retención) o alcanza con snapshot en logs + `/admin/ops`?
- Umbral del SLO de latencia del turno (hoy 15 s por default).

## Criterios de aceptación
- [ ] Test de pipeline: un turno con agente fake de 20 s deja muestra en `recordLatency` y, con ≥5 muestras, `_countSloAlertsForTests()` > 0.
- [ ] Test: el agregado por ruta registra la duración de un request (el access log en sí ya lo testea `logging`).
- [ ] `GET /api/panel/admin/ops` responde 401/403 sin superadmin y JSON con latencias y cola con superadmin.
- [ ] Grep: `recordLatency(` aparece en código de `src/` fuera de `metrics.ts`.
- [ ] `DEPLOY.md` §18 usa `METRICS_INTERVAL_MIN` y el formato real.
- [ ] `npm run typecheck` y `npm test` en verde (y en web/ si se agrega vista en el panel).
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización").

## Reglas para este trabajo
- Rama propia `prod/monitoreo-de-performance` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist de pasos humanos pendientes (p. ej. revisar el primer `metrics_snapshot` en el droplet).
