# Topes de gasto de la plataforma y alertas de facturación

> **Punto del checklist:** set spend caps and billing alerts · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P0 antes del primer cliente que pague
> **Tipo:** mixto · **Depende de:** alertas (canal verificado), limites-de-tokens (costo por turno acotado) · **Esfuerzo:** 1 día + 1-2 h de configuración en proveedores
> **Archivos principales:** `src/plans.ts`, `src/modules/billing/catalog.ts`, `src/modules/whatsapp/pipeline.ts`, `src/modules/whatsapp/usage.ts`, `src/modules/whatsapp/limits.ts`, `src/modules/whatsapp/agent/cost.ts`, `DEPLOY.md`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
Lo que existe (tope **por negocio**, funciona de punta a punta):
- Límites del plan en `src/modules/billing/catalog.ts` (`PlanLimits.aiConversations`, `aiLlmUsd`; defaults por env `PLAN_BASIC_AI_LLM_USD`=15, `PLAN_PRO_AI_LLM_USD`=40). `aiLimitsFromPlan()` en `src/plans.ts` los traduce a micro-USD para el pipeline.
- Costo estimado por turno en `src/modules/whatsapp/agent/cost.ts` (tabla `MODEL_PRICING`, re-tarifable por env `OPENAI_PRICE_*`) y Whisper por minuto; acumulado en `ai_usage_monthly.estimated_cost_usd_micros` por `incrementAiUsage()` (`usage.ts`).
- `applyMonthlyCaps()` en `pipeline.ts` (~l. 338) corta el agente al llegar al tope, pasa a humano, avisa al cliente y al dueño y dispara `alertPlatform` (`whatsapp_ai_spend_cap` / `whatsapp_conversation_cap`, cooldown 24 h).

Lo que falta:
- **Sin tope global de la plataforma:** nada suma el gasto de LLM de todos los negocios del mes contra un techo (p. ej. `PLATFORM_MONTHLY_LLM_USD`). Con N negocios en Pro, el peor caso es N × 40 USD sin que nada frene ni avise antes.
- **Sin aviso previo:** no hay alerta al 80 % del tope (ni por negocio ni global); el primer aviso llega cuando el bot ya dejó de responder.
- **Whisper se paga antes del tope mensual:** en `handleTurn` del pipeline la transcripción (`deps.transcribe`, ~l. 588) corre antes de `applyMonthlyCaps(turn, limits)` (~l. 609); solo `applyClientBrakes()` (~l. 576) va antes. Un negocio sobre el tope sigue gastando en audios.
- **Sin umbral de aviso en `capStatus()`** (`limits.ts` ~l. 66): solo devuelve `conversationsExceeded`/`spendExceeded`.
- **Gasto de Meta sin visibilidad ni tope:** las campañas (`src/modules/campaigns/dispatch.ts`) no tienen cupo mensual de envíos por plan; recordatorios, rescate y seguimientos tampoco. Si las plantillas se cobran a la WABA de Selyon (y no a la del negocio), es gasto sin techo (pista V2-14 de la auditoría vieja: verificar el modelo vigente).
- **Alertas de facturación en proveedores no documentadas:** `DEPLOY.md` no menciona presupuesto/hard limit del proyecto de OpenAI, spend cap de Supabase, alerta de facturación del droplet/DigitalOcean, ni Meta/Stripe. `grep -i "budget\|spend\|presupuesto" DEPLOY.md` no devuelve nada relevante.
- **El costo estimado puede desviarse del real:** no hay conciliación con el uso de OpenAI. Si el modelo no está en `MODEL_PRICING`, `cost.ts` (~l. 63-68) cae al precio de `FALLBACK_MODEL` y solo hace `log.warn("agent_model_without_pricing")` una vez por proceso: sin alerta, el tope puede quedar muy por debajo del gasto real.
- **Los turnos fallidos no suman al tope:** `incrementAiUsage()` en `runAgentTurn()` (`pipeline.ts` ~l. 434) solo corre si el agente devolvió resultado; los intentos que fallan o vencen por timeout (reintentos en `callModel()` de `runner.ts` ~l. 186-196) no se registran (pista V2-05).

## Objetivo
Que ningún mes cierre con una factura de proveedor que nadie vio venir: techo global en código, avisos tempranos y límites duros configurados en cada proveedor.

## Alcance
- Tope global: `PLATFORM_MONTHLY_LLM_USD` (env); al superarlo, `alertPlatform` critical y comportamiento según decisión (cortar el agente en todos o solo alertar). Lectura de la suma con una consulta de sistema (no por negocio); cachear unos minutos para no pegarle a la base en cada turno.
- Aviso al 80 % (configurable) por negocio y global, una vez por mes (cooldown hasta fin de mes).
- Mover el chequeo del tope mensual **antes** de la transcripción de audio.
- Escalar el `log.warn("agent_model_without_pricing")` existente a `alertPlatform` (warning) y advertencia en el arranque si el modelo no está en `MODEL_PRICING` y no hay `OPENAI_PRICE_*`.
- Registrar un costo estimado mínimo (tokens de entrada del prompt) cuando el turno falla o vence por timeout, para que el tope vea esos intentos (coordinar con `limites-de-tokens`).
- Cupo mensual de envíos de plantillas (campañas) por plan en `PlanLimits`, si se decide que hace falta.
- Nueva sección en `DEPLOY.md`: «Topes y alertas de facturación» con pasos para OpenAI (budget + hard limit del proyecto, key de proyecto), Supabase (spend cap), DigitalOcean (billing alert), Meta (límite/método de pago de la WABA), Stripe (n/a de gasto, alertas de disputas), Sentry/Resend (planes free y qué pasa al pasarse).

## Fuera de alcance
- `max_completion_tokens`, truncar entradas, tope de audio por tamaño: `limites-de-tokens`.
- Proveedor alterno si OpenAI corta: `fallback-del-modelo`.
- Canal y detectores generales de alertas: `alertas`.

## Pasos sugeridos
1. Leer `catalog.ts`, `plans.ts`, `limits.ts` (`capStatus`), `usage.ts` (`readMonthlyAiUsage`, `aiCostMicrosBetween`), `cost.ts` y `handleTurn`/`applyMonthlyCaps` del pipeline.
2. Agregar `sumPlatformAiCostMicros(db, month)` en `usage.ts` (contexto de sistema, respetando RLS/`withSystem`).
3. Extender `capStatus` con umbral de aviso; tests de límites (79 %, 80 %, 100 %).
4. Reordenar el pipeline (tope antes de Whisper) con test: negocio sobre el tope + nota de voz → `transcribe` no se llama.
5. Docs y `.env.example`.

## Decisiones que el agente NO toma solo
- Monto del techo global mensual y si al pasarlo se **corta** el agente o solo se alerta.
- ¿Quién paga las plantillas de Meta (WABA del negocio vs. de Selyon)? ¿Hace falta cupo de campañas por plan?
- Montos de budget/hard limit en OpenAI, spend cap en Supabase y alerta en DigitalOcean (los configura el usuario en cada consola).

## Criterios de aceptación
- [ ] Test: con la suma global ≥ techo, el siguiente turno de cualquier negocio dispara `platform_llm_spend_cap` (y corta o no según la decisión).
- [ ] Test: al cruzar el 80 % sale una sola alerta de aviso en el mes.
- [ ] Test: negocio sobre el tope + audio → no se transcribe.
- [ ] `DEPLOY.md` tiene la sección de facturación con un paso por proveedor.
- [ ] `npm run typecheck` y `npm test` en verde.
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización").

## Reglas para este trabajo
- Rama propia `prod/topes-de-gasto` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario: las consolas de facturación las configura el usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura; WhatsApp no importa billing) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist humano: budget y hard limit en OpenAI, spend cap en Supabase, billing alert en DigitalOcean, revisar facturación de Meta, valores de `PLATFORM_MONTHLY_LLM_USD` en el droplet.
