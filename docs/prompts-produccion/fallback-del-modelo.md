# Plan B cuando OpenAI no responde

> **Punto del checklist:** add a fallback for when the model API goes down · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P1 antes de 5 clientes
> **Tipo:** código · **Depende de:** alertas, limites-de-tokens · **Esfuerzo:** 1 día
> **Archivos principales:** `src/modules/whatsapp/agent/runner.ts`, `src/modules/whatsapp/agent/config.ts`, `src/modules/whatsapp/pipeline.ts`, `src/platform/net/transient.ts`, `test/reliability/agent.test.ts`, `test/reliability/whatsappPipeline.test.ts`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
Lo que YA existe (no rehacer):
- Timeout por llamada (`openAiTimeoutMs`, `OPENAI_TIMEOUT_MS`, 20 s) y cliente con `maxRetries: 0` (`defaultClient`, `runner.ts`).
- Reintento dentro del turno ante error transitorio o timeout (`callModel` en `createAgentRunner`, `AGENT_OPENAI_RETRIES`, default 1).
- Sin nada guardado, el error se relanza y la cola reintenta el job con backoff (`shouldRetry` en `pipeline.ts`, `isTransientError`); con una cita ya guardada responde la confirmación fija (`fallbackResult(null)`), cubierto por tests "si OpenAI falla DESPUÉS de agendar" y "sin nada guardado… se relanza".
- En el último intento, `runAgentTurn` (`pipeline.ts`) manda el texto fijo `generalError` y notifica al equipo (push).

Lo que falta:
1. **Sin modelo/proveedor alternativo**: `agentModel()` (`config.ts`) devuelve un solo modelo; no hay `OPENAI_FALLBACK_MODEL` ni segundo cliente. Un 404/400 de modelo retirado o un incidente de un modelo puntual tumba a todos los negocios.
2. **Sin circuit breaker**: durante una caída, cada mensaje entrante paga 2 × 20 s de timeout más los reintentos de la cola, ocupando workers de todos los negocios. Nada recuerda "OpenAI está caído hace 2 min".
3. **Sin degradación útil**: tras el último intento el cliente recibe `generalError` y la conversación sigue en modo `bot`; el siguiente mensaje repite todo el ciclo. No se pasa a una persona ni se ofrece una respuesta determinista (dirección, horario, "te escribimos en cuanto podamos").
4. Errores no transitorios (401 key revocada, 429 `insufficient_quota`, 404 modelo): `isTransientError` (`src/platform/net/transient.ts` l. 24-38) ya los marca como NO transitorios (no se reintentan), pero `runAgentTurn` (`pipeline.ts` ~l. 425-430) los trata igual que cualquier otro: `generalError` + log genérico `whatsapp_agent_failed`, sin evento propio ni aviso a la plataforma.
5. **Timeout agotado no se clasifica como transitorio en el pipeline**: `callModel` (`runner.ts` ~l. 186-197) reconoce `TimeoutError`/`AbortError` para su reintento interno, pero al agotarlo relanza ese error y `isTransientError` no lo reconoce (solo `APIConnectionError`/`APIError` con status o la marca `transient`; un abort del `AbortSignal.timeout` llega como `TimeoutError` o `APIUserAbortError` sin status). Resultado probable: `shouldRetry` (`pipeline.ts` l. 129-131) da false y en el PRIMER intento del job se manda `generalError` en vez de dejar que la cola reintente. El test "runner: cada llamada tiene timeout (y el timeout cuenta como transitorio)" (`test/reliability/agent.test.ts` ~l. 444) solo prueba el reintento DENTRO del turno. Confirmalo con un test antes de arreglarlo.

## Objetivo
Que una caída o degradación de OpenAI no deje a los clientes finales sin respuesta útil ni bloquee la cola, y que el bot se recupere solo cuando el servicio vuelve.

## Alcance
- `OPENAI_FALLBACK_MODEL` opcional (documentado en `.env.example`; el guardrail `npm run ci:env` lo exige): si el modelo principal falla con error de modelo/servidor tras sus reintentos, un intento con el alternativo. El costo se calcula con el modelo realmente usado (`computeCostMicros`).
- Circuit breaker en proceso (módulo puro en `src/modules/whatsapp/agent/`, p. ej. `breaker.ts`): N fallos seguidos en ventana → abierto por X s (configurables por env) → semiabierto con una prueba. Abierto = no se llama a OpenAI.
- Con el breaker abierto o en el último intento: respuesta degradada determinista (texto fijo nuevo en `texts.ts`, con override por negocio como los demás) + pasar la conversación a modo humano (`handOff`, el mismo camino que ya usa `limites-de-tokens` para el desborde de contexto) para que el equipo la vea en la bandeja, una sola vez por conversación.
- Que el timeout agotado del turno salga del runner como transitorio (envolverlo con `cause` o la marca `transient: true`), con test en `whatsappPipeline.test.ts`: el job se relanza y no manda `generalError` si le quedan intentos.
- Clasificar 401/403/`insufficient_quota`/404 de modelo como "no disponible" (no transitorio, abre el breaker de inmediato) y loguearlo con un evento estable (`agent_llm_unavailable`). Alimentar con esos fallos el detector `llm_unavailable` que dejó `alertas` (helper `rateAlert`), sin crear otro canal ni otra alerta.
- Tests con el doble de OpenAI que ya usa `test/reliability/agent.test.ts`.

## Fuera de alcance
- Detector y canal de alertas, y `captureError` del pipeline → `alertas` / `error-tracking` (ya mergeados: solo alimentarlos).
- Segundo proveedor (Anthropic, Azure OpenAI): solo si el usuario lo decide; si no, anotarlo en el ROADMAP.
- Topes de gasto por negocio → `topes-de-gasto`.

## Pasos sugeridos
1. Tests primero: (a) principal cae → responde el alternativo; (b) 5 fallos → breaker abierto → el turno siguiente no llama al doble y responde el texto degradado + handoff; (c) pasado el enfriamiento, una prueba exitosa lo cierra; (d) 401 abre el breaker sin reintentar.
2. Implementar `breaker.ts` (estado en memoria, reloj inyectable) y el fallback en `callModel`.
3. Ajustar `runAgentTurn` en `pipeline.ts` para el modo degradado sin duplicar efectos (respetar `turn.effects`).
4. Documentar las env nuevas en `.env.example` y `DEPLOY.md`.

## Decisiones que el agente NO toma solo
- Qué modelo alternativo usar y si se acepta su costo/calidad (¿`gpt-4.1-mini`? ¿otro proveedor?).
- Si en modo degradado se pasa siempre a una persona o solo se responde el texto fijo (impacta la carga del equipo del negocio).
- Umbrales del breaker (fallos, ventana, enfriamiento).

## Criterios de aceptación
- [ ] Tests nuevos en `test/reliability/agent.test.ts` / `whatsappPipeline.test.ts` para los 4 escenarios de Pasos sugeridos y para el timeout agotado (el job se relanza), en verde.
- [ ] Con el breaker abierto, un turno no hace ninguna llamada al cliente de OpenAI (verificado con el doble).
- [ ] `.env.example` documenta las variables nuevas y `npm run ci:env` pasa.
- [ ] `npm run typecheck` y `npm test` en verde.
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización").

## Reglas para este trabajo
- Rama propia `prod/fallback-del-modelo` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist de pasos humanos pendientes (p. ej. definir `OPENAI_FALLBACK_MODEL` en el droplet).
