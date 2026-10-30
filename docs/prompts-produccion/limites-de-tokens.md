# Topes de tokens y desborde de contexto del agente

> **Punto del checklist:** handle token limits and context overflow · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P0 antes del primer cliente que pague
> **Tipo:** código · **Depende de:** nada · **Esfuerzo:** 1 día
> **Archivos principales:** `src/modules/whatsapp/agent/runner.ts`, `src/modules/whatsapp/agent/prompt.ts`, `src/modules/whatsapp/agent/history.ts`, `src/modules/whatsapp/settings.ts`, `src/modules/whatsapp/pipeline.ts`, `src/modules/whatsapp/media.ts`, `src/modules/whatsapp/graph.ts`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
Lo que YA está acotado (no rehacer):
- Historial: `trimHistory` (`history.ts`) con `AGENT_HISTORY_MAX_MESSAGES` (20) y `AGENT_HISTORY_MAX_DAYS` (30), hasta 10 mensajes nuevos, y cada mensaje cortado a `MAX_HISTORY_MESSAGE_CHARS` (2000) en `historyToMessages`.
- Texto entrante cortado a `MAX_TEXT = 4096` (`payload.ts`); respuesta saliente cortada a 4000 (`clipReply`, `runner.ts`).
- Configuración del negocio con topes Zod (`settings.ts` ~l. 35-38): instrucciones 4000, KB 12 000, FAQ 12 000 caracteres.
- Pasos por turno (`AGENT_MAX_STEPS`, 5) y horarios listados (`MAX_LISTED_TIMES = 16`, `tools.ts`).
- Medios: `WHATSAPP_MEDIA_MAX_BYTES` 16 MB (`graph.ts` ~l. 25), chequeado con `file_size` ANTES de descargar y otra vez sobre el buffer (`graph.ts` ~l. 268-281). Ese mecanismo es el que hay que reusar para un tope propio de audio.

Lo que falta:
1. **Sin `max_completion_tokens`**: `body()` en `createAgentRunner` (`runner.ts` ~l. 175) no fija tope de salida. Una respuesta larga cuesta y alarga la latencia hasta el timeout.
2. **`finish_reason` ignorado**: el bucle (`runner.ts` ~l. 214-223) usa `message.content` sin mirar `finish_reason === "length"`; con modelos de razonamiento (`supportsTemperature` ya contempla `gpt-5`/`o*`) un corte deja `content` vacío y el cliente recibe `notUnderstood`.
3. **Overflow de contexto no manejado**: un 400 `context_length_exceeded` no es transitorio → `runAgentTurn` (`pipeline.ts`) manda `generalError` en cada mensaje y el bot de ese negocio queda caído sin aviso específico.
4. **Prompt de sistema sin presupuesto total**: `buildSystemPrompt` (`prompt.ts`) concatena sucursales, servicios (con `description`), equipo, instrucciones, KB y FAQ; solo estos tres últimos tienen tope. No se mide el prompt al guardar la configuración ni al cargar catálogo/equipo. Además el bucle reenvía todo en cada paso (×5).
5. **Audio sin tope de duración**: `whisperTranscriber` (`media.ts`) transcribe cualquier audio ≤ 16 MB (horas de opus); la transcripción se guarda entera (`pipeline.ts` ~l. 601, `[audio] ${transcript}`) y el costo de Whisper se paga antes de saber si sirve.

## Objetivo
Que ninguna combinación de configuración del negocio, historial o entrada del cliente pueda exceder la ventana del modelo ni generar respuestas o transcripciones sin tope, y que si igual pasa, el turno se degrade de forma controlada.

## Alcance
- `AGENT_MAX_OUTPUT_TOKENS` (default ~600; env documentada en `.env.example`) → `max_completion_tokens` en `body()`; para modelos de razonamiento dejar margen (configurable aparte o multiplicador).
- Manejar `finish_reason === "length"`: si hay texto, enviarlo recortado a la última oración; si no, reintentar una vez con instrucción "respondé más corto" o caer al texto fijo; loguear `agent_output_truncated`.
- Presupuesto del prompt: función `estimatePromptChars(ctx)` (o tokens aproximados por caracteres) y tope `AGENT_MAX_SYSTEM_PROMPT_CHARS` (~32 000). (a) Al guardar ai-settings (`settings.ts`, ruta `/whatsapp/settings` en `settingsRoutes.ts` ~l. 32-38) rechazar con 422 y mensaje claro si el prompt resultante lo pasa. (b) En el turno, si igual lo pasa (catálogo creció), recortar en orden: descripciones de servicios → FAQ → KB, y loguear.
- Capturar `context_length_exceeded`: reintentar una vez con historial a la mitad; si vuelve a fallar, handoff y log `agent_context_overflow`.
- Audio: tope de duración/tamaño (`WHATSAPP_AUDIO_MAX_BYTES` aplicado en la descarga de `graph.ts` igual que `MEDIA_MAX_BYTES`, solo para audio; y `AGENT_AUDIO_MAX_SEC` contra `durationSec` que ya devuelve `whisperTranscriber`, `media.ts` ~l. 75-82: si lo pasa, no se manda al agente) y truncado de la transcripción guardada a 4096.
- Tests: unitarios del presupuesto (`test/unit/agentPrompt.test.ts`), del runner con `finish_reason: "length"` y con error 400 de contexto (doble de OpenAI en `test/reliability/agent.test.ts`), del 422 en `test/reliability/settingsApi.test.ts` o `aiSettings.test.ts`.

## Fuera de alcance
- Topes de gasto mensuales por plan y freno antes de Whisper → `topes-de-gasto`.
- Fallback a otro modelo cuando OpenAI cae → `fallback-del-modelo`.

## Pasos sugeridos
1. Tests rojos para los 5 huecos; luego implementar en `runner.ts`, `prompt.ts`, `settings.ts`, `pipeline.ts`/`media.ts`.
2. Mostrar el error 422 en el panel (WhatsApp IA › Configuración) con el mensaje del backend, sin cambiar la forma de `/api/panel/*`.
3. Documentar las env nuevas en `.env.example` (`npm run ci:env`).

## Decisiones que el agente NO toma solo
- Valor de `max_completion_tokens` y tope del prompt (trade-off calidad/costo).
- Duración máxima de nota de voz aceptada (¿2 min? ¿5 min?) y el texto que recibe el cliente si la pasa.

## Criterios de aceptación
- [ ] Todo request al modelo lleva `max_completion_tokens` (test sobre el body capturado por el doble).
- [ ] `finish_reason: "length"` y `context_length_exceeded` tienen tests y no terminan en `generalError` repetido.
- [ ] Guardar una configuración cuyo prompt supera el tope devuelve 422 (test).
- [ ] Un audio por encima del tope no se transcribe (test en `whatsappPipeline.test.ts`).
- [ ] `npm run typecheck` y `npm test` en verde (y en `web/` si toca el panel).
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización").

## Reglas para este trabajo
- Rama propia `prod/limites-de-tokens` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta). No hace falta un tokenizador: aproximá por caracteres.
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist de pasos humanos pendientes.
