# Evals del agente: correrlas de verdad y ampliar la cobertura

> **Punto del checklist:** write evals · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P0 antes del primer cliente que pague
> **Tipo:** mixto · **Depende de:** nada · **Esfuerzo:** 1-1,5 días (+ costo de tokens de las corridas)
> **Archivos principales:** `eval/runEval.ts`, `eval/assertions.ts`, `eval/transcripts/*.json`, `test/unit/evalHarness.test.ts`, `TESTING.md`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
- El arnés existe y está bien armado: `eval/runEval.ts` (`main`, `runCase`, `prepare`) corre el `AgentRunner` REAL (`createAgentRunner` de `src/modules/whatsapp/agent/runner.ts`) contra OpenAI sobre el negocio demo de `seedDev` en un PGlite efímero. Soporta `EVAL_CASE`, `EVAL_REPEAT`, `EVAL_VERBOSE` y `EVAL_DRY_RUN`. Script: `npm run eval` (`package.json`).
- Las aserciones (`eval/assertions.ts`: `evaluate`, `loadCases`, `Expectation`) son deterministas y están cubiertas por `test/unit/evalHarness.test.ts`, que sí corre en `npm test`.
- Hay **13 casos** en `eval/transcripts/` (saludo, precio inventado, precio de catálogo, ofrecer horarios, agendar, mis citas, reprogramar, cancelar, fuera de alcance, alergia → traspaso, hora inventada, ubicación, pide humano).
- **Nunca se corrieron con OpenAI real**: el ROADMAP lo dice textual en I2 ("Falta: correr los evals con OpenAI real"). No hay ningún resultado guardado ni línea base de tasa de acierto.
- Lo que los 13 casos YA cubren (no duplicar): historial previo con confirmación y acción (`05-books`, `07-reschedule`, `08-cancel` traen `history` y terminan en "sí" → tool), canal de varias sucursales (`12-asks-location` usa `"channel": "all"`), registro vos (`01-greeting` con `notContains: ["usted"]`).
- Cobertura que falta:
  - Un solo negocio: `prepare` llama a `seedDev` (`scripts/seedDev.ts` ~l. 93 y 103, `industry: "aesthetics"` fijo) y un solo registro; nada de `tu`/`usted`, ni inglés, ni otra terminología de rubro (el prompt cambia con `ctx.terminology` y `REGISTER_PHRASE` en `buildSystemPrompt`, `src/modules/whatsapp/agent/prompt.ts` l. 21-25). Hay plantillas `dental`, `nails` y `generic` en `src/modules/business/templates/` (`loadIndustryTemplate`, `src/modules/business/templates.ts` ~l. 170).
  - Ningún caso de crecimiento (I6): `record_quote`, `upsell_offer` → `add_service_to_appointment` / `decline_upsell` (reglas en `growthRules`, `prompt.ts` ~l. 85-99). `runCase` (`eval/runEval.ts` ~l. 103-130) ni siquiera pasa `growth` al runner.
  - Ningún caso NEGATIVO de confirmación: que sin un "sí" explícito NO se llame `book_appointment` (regla "CONFIRMAR ANTES DE ACTUAR", `prompt.ts` l. 124).
  - Ningún caso de nota de voz (`[audio] …`) ni de mensaje tras intervención humana (`byHuman`, nota `HUMAN_NOTE` en `history.ts` l. 67): `EvalCase.history` (`eval/assertions.ts` ~l. 54-66) no admite `byHuman`.
  - Inyección de prompt: la cubre el prompt `prompt-injection` (no la dupliques acá).
- **`TESTING.md` describe un arnés que ya no existe** (l. ~111-142 y ~284/297): habla de `correrAgente`, `eval/correrEval.ts`, `eval/aserciones.ts`, `fixtureEval.ts`, `eval/transcripciones/` (14 casos del tenant Selyon), `EVAL_REPETICIONES`/`EVAL_CASO` y de borrar `GOOGLE_*`. Lo real es `eval/runEval.ts`, `eval/assertions.ts`, `eval/transcripts/` (13 casos sobre `seedDev`) y `EVAL_REPEAT`/`EVAL_CASE`/`EVAL_VERBOSE`/`EVAL_DRY_RUN`.
- `EVAL_REPEAT` existe pero no hay umbral: `main` sale con código 1 ante cualquier caso rojo o inestable, sin noción de "tasa mínima aceptable".

## Objetivo
Que exista una corrida real y reproducible de las evals con el modelo de producción (`OPENAI_MODEL`, default `gpt-4o-mini`), con una línea base de tasa de acierto por caso guardada en el repo, y que la suite cubra los flujos que de verdad usa un negocio que paga.

## Alcance
- Ampliar `eval/transcripts/` a ≥ 25 casos: registro `tu` y `usted`, cliente que escribe en inglés, otro rubro (otra plantilla de `loadIndustryTemplate`), confirmación negativa (propone y sin "sí" no agenda), nota de voz, mensaje posterior a uno escrito por una persona del equipo, cotización (`record_quote`) y upsell aceptado/rechazado.
- Extender `EvalCase` / `prepare` / `runCase` para elegir plantilla, registro, `growth` y `byHuman` en el historial por caso (sin romper los 13 actuales; `seedDev` hoy no recibe la plantilla: agregarle una opción o sembrar aparte en `prepare`). Mantener `test/unit/evalHarness.test.ts` validando que los casos solo nombran tools y servicios reales de la plantilla elegida.
- Umbral: `EVAL_MIN_PASS_RATE` (p. ej. 0,9 con `EVAL_REPEAT=3`) y salida con resumen legible + JSON (`eval/results/<fecha>-<modelo>.json`, sin datos personales).
- Correr la suite con OpenAI real **una vez autorizado por el usuario**, guardar la línea base (`eval/baseline.json`) y documentar en `TESTING.md` cuándo correrlas (antes de cambiar prompt, modelo o tools).

## Fuera de alcance
- Casos de inyección y extracción del prompt → `prompt-injection`.
- Correr las evals en CI / gate automático ante cambios del prompt → `tests-de-regresion`.
- Tope de tokens y overflow de contexto → `limites-de-tokens`.

## Pasos sugeridos
1. Leer `eval/runEval.ts` y `eval/assertions.ts`; agregar a `EvalCase` los campos opcionales `template`, `register`, `growth`.
2. Escribir los casos nuevos en JSON; correr `EVAL_DRY_RUN=1 npm run eval` para validar el arnés sin tokens.
3. Agregar el umbral y el volcado JSON de resultados (con `.gitignore` para `eval/results/` salvo la línea base).
4. Pedir confirmación, correr `EVAL_REPEAT=3 npm run eval` con la key de desarrollo, revisar los rojos: si es el prompt, arreglarlo en `prompt.ts` (con su test en `test/unit/agentPrompt.test.ts`); si es el caso, ajustarlo y explicarlo en `description`.
5. Guardar `eval/baseline.json` y REESCRIBIR la sección de evals de `TESTING.md` (y el árbol/scripts de l. ~284/297) para que describa el arnés real.

## Decisiones que el agente NO toma solo
- Autorización para gastar tokens de OpenAI con la key de desarrollo (y cuál key usar: nunca la de producción) y presupuesto aproximado por corrida.
- Tasa mínima aceptable por caso (¿90 %? ¿100 % para "no inventa precios"?).
- Qué rubros/plantillas, además de estética, son prioritarios para el primer cliente.

## Criterios de aceptación
- [ ] `eval/transcripts/` tiene ≥ 25 casos, incluidos los grupos listados en Alcance.
- [ ] `EVAL_DRY_RUN=1 npm run eval` termina en 0 y `test/unit/evalHarness.test.ts` cubre los campos nuevos.
- [ ] Hay al menos una corrida real con `EVAL_REPEAT=3` y su resultado está en `eval/baseline.json` (modelo, fecha, tasa por caso).
- [ ] `TESTING.md` ya no nombra `correrEval`, `aserciones`, `transcripciones`, `fixtureEval` ni `EVAL_REPETICIONES` (`grep -nE "correrEval|aserciones|transcripciones|fixtureEval|EVAL_REPETICIONES" TESTING.md` vacío) y explica cuándo y cómo correrlas y cómo leer el umbral.
- [ ] `npm run typecheck` y `npm test` en verde.
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, quitar el "Falta: correr los evals" de I2 si quedó hecho, fecha de "Última actualización").

## Reglas para este trabajo
- Rama propia `prod/evals` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó (salida del dry run y de la corrida real, tasa por caso), y checklist de pasos humanos pendientes.
