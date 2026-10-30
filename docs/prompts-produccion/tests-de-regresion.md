# Regresión del comportamiento del agente (prompt, modelo y tools)

> **Punto del checklist:** add regression tests · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P1 antes de 5 clientes
> **Tipo:** mixto · **Depende de:** evals, prompt-injection · **Esfuerzo:** 1 día
> **Archivos principales:** `.github/workflows/evals.yml` (nuevo), `.github/workflows/ci-cd.yml` (solo lectura), `eval/runEval.ts`, `test/unit/agentPrompt.test.ts`, `test/reliability/agent.test.ts`, `src/modules/whatsapp/agent/prompt.ts`, `src/modules/whatsapp/agent/tools.ts`, `TESTING.md`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
Lo que YA existe y corre en CI (no rehacer):
- `npm test` (job `verify` de `.github/workflows/ci-cd.yml`) incluye pruebas deterministas del agente con un doble de OpenAI: `test/reliability/agent.test.ts` (tools estrictas, ciclo agendar/reprogramar/cancelar, aislamiento por cliente, errores internos que no llegan al modelo, timeout, reintento, pasos agotados, historial con fechas) y `test/unit/agentPrompt.test.ts` (prompt estable, orden de mensajes, registro, reglas de crecimiento), más `test/unit/evalHarness.test.ts` y `test/unit/agentHistoryCost.test.ts`.
- La parte determinista (código alrededor del modelo) está bien cubierta.

Lo que falta (regresión del COMPORTAMIENTO):
1. **Las evals no corren nunca en CI**: `npm run eval` no aparece en `ci-cd.yml` (ni job manual ni programado). OJO: en `ci-cd.yml` el trigger `workflow_dispatch` (~l. 8-17, input `sha`) está reservado al **rollback de producción** (job `rollback`, ~l. 240-245, `if: github.event_name == 'workflow_dispatch'`, con SSH al droplet); `verify` y `e2e` se saltan en ese trigger. Un cambio en `buildSystemPrompt`, en las descripciones de tools (`toolDefinitionsFor`, `tools.ts`) o en `OPENAI_MODEL` llega a producción sin que nadie mida si el agente empeoró.
2. **Sin línea base para comparar**: `eval/runEval.ts` (`main`) solo imprime ✅/⚠️/❌; no compara contra una corrida anterior (la línea base la crea el prompt `evals`).
3. **Sin instantánea del prompt**: un cambio accidental del texto del prompt o del esquema de las tools no se ve en el diff de los tests (solo se chequean fragmentos con regex). Tampoco hay test de que el prefijo cacheable no cambió de forma inadvertida.
4. **Sin regla de "bug → caso"**: no está documentado en `TESTING.md` que todo fallo del agente visto en producción (bandeja) se convierte en un caso de `eval/transcripts/` o en un test determinista.

## Objetivo
Que cualquier cambio en el prompt, las tools o el modelo quede visible en el diff y se valide contra la línea base de evals antes de llegar a producción, sin gastar tokens en cada push.

## Alcance
- Instantánea determinista (snapshot hecho a mano con `node:test`, sin dependencias nuevas): `test/unit/agentPromptSnapshot.test.ts` que renderiza `buildSystemPrompt` con un `AgentContext` fijo y `toolDefinitionsFor(...)` y lo compara con archivos en `test/fixtures/agent/`; script `UPDATE_SNAPSHOTS=1` para regenerarlos. Así el diff del PR muestra el cambio de prompt/tools.
- Comparación con línea base en `eval/runEval.ts`: `EVAL_BASELINE=eval/baseline.json` → falla si un caso cae por debajo de su tasa de la línea base menos una tolerancia.
- Workflow APARTE `.github/workflows/evals.yml` (NUNCA un job con `workflow_dispatch` dentro de `ci-cd.yml`: dispararlo correría el rollback de producción): `workflow_dispatch` y, opcional, cuando el PR toca `src/modules/whatsapp/agent/**` o `eval/**` (filtro `paths`); usa un secreto `OPENAI_API_KEY_EVALS` de desarrollo; si el secreto no existe, el job se salta con aviso (no falla los PRs de forks). Nunca bloquea el deploy de producción salvo que el usuario lo pida.
- `TESTING.md`: sección "Regresión del agente" con la regla bug → caso, cómo actualizar instantáneas y línea base.

## Fuera de alcance
- Escribir/ampliar los casos de eval y crear la línea base → `evals`.
- Casos de inyección → `prompt-injection`.
- Pipeline de CI/CD general → `ci-cd`.

## Pasos sugeridos
1. Snapshot del prompt y de las tools + script de actualización; verificar que falla si se cambia una palabra del prompt.
2. `EVAL_BASELINE` en `runEval.ts` con su lógica pura en `eval/assertions.ts` (testeada en `evalHarness.test.ts`).
3. `.github/workflows/evals.yml` con `paths`, `permissions: contents: read` y salto sin secreto (acciones fijadas por SHA, las mismas de `ci-cd.yml` l. 26-27); validar la sintaxis (p. ej. corriendo el job en dry run con `EVAL_DRY_RUN=1` si no hay secreto).
4. Documentar en `TESTING.md`.

## Decisiones que el agente NO toma solo
- Crear el secreto `OPENAI_API_KEY_EVALS` en GitHub (lo hace el usuario) y el presupuesto mensual de tokens para evals en CI.
- Si el job de evals bloquea el merge de PRs que tocan el agente o solo informa.
- Frecuencia de una corrida programada (semanal) para detectar cambios silenciosos del modelo.

## Criterios de aceptación
- [ ] `test/unit/agentPromptSnapshot.test.ts` corre en `npm test` y falla si cambia el prompt o el esquema de una tool sin regenerar la instantánea.
- [ ] `EVAL_BASELINE` probado con datos falsos en `test/unit/evalHarness.test.ts`.
- [ ] `.github/workflows/evals.yml` existe, se salta sin secreto y `ci-cd.yml` NO cambió sus triggers (`git diff prod/readiness -- .github/workflows/ci-cd.yml` vacío): ni `verify`/`e2e`/`deploy` ni `rollback` se ven afectados.
- [ ] `TESTING.md` documenta la regla bug → caso.
- [ ] `npm run typecheck` y `npm test` en verde.
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización").

## Reglas para este trabajo
- Rama propia `prod/tests-de-regresion` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta). Las acciones nuevas del workflow van fijadas por SHA como las existentes.
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist de pasos humanos pendientes (crear el secreto en GitHub, primera corrida manual del job).
