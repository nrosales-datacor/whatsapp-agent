# TESTING.md — Pruebas de Selyon CRM

> **Qué es:** la suite real (carpetas, qué cubre cada una, comandos y cuánto tarda). Mantenerlo vivo igual que
> `ROADMAP.md`: un test nuevo que abre una carpeta, un proyecto de Playwright o un comando va acá en el mismo PR.
>
> **Última actualización:** 2026-10-31 (reescrito a la suite real: lógica pura del panel en `test/unit`, conteos y
> tiempos medidos; ángulo 4, evals: arnés real con 35 casos, umbral y tope de gasto, falta la primera corrida con OpenAI; prompt `tests-unitarios` de `docs/prompts-produccion/`)

---

## Resumen

| Comando | Qué corre | Dónde corre |
|---|---|---|
| `npm test` | `node:test` vía `tsx --test` sobre `test/unit`, `test/security`, `test/reliability` y `test/architecture`. La base es un Postgres **efímero en el proceso** (PGlite + las migraciones reales de `./drizzle`): sin `DATABASE_URL`, sin Docker, sin red. | CI, job `verify` (paso "Tests (unit, security, reliability; PGlite en el proceso)") |
| `npm run typecheck` / `npm run typecheck --prefix web` | `tsc --noEmit` del backend (incluye `test/**` y `eval/**`) y del panel (app + service worker). | CI, job `verify` |
| `npm run db:check` | Drift entre los `schema.ts` y `./drizzle` (`scripts/checkMigrations.ts`, ángulo 7). | CI, job `verify` |
| `npm run test:e2e` | Build del panel + Playwright, proyectos `server` y `panel-mock` (ángulos 6 y 9). | CI, job `e2e` (`npx playwright test`) |
| `npm run eval` | Evals del agente contra OpenAI real (ángulo 4). **No** corre en CI. | A mano |
| `npm run ci:versions`, `ci:env`, `ci:secrets`, `ci:audit` | Guardrails de versiones exactas, `.env.example`, secretos commiteados y auditoría de dependencias (los tres primeros tienen tests en `test/security` y `test/unit`). | CI, job `verify` (antes de instalar) |

**Tamaño y tiempo de `npm test`** (medido el 2026-10-31 en el contenedor de desarrollo, Node 22, con otros procesos
compitiendo por la CPU; en una máquina libre es bastante menos):

| Carpeta | Archivos | Tests | Base |
|---|---|---|---|
| `test/unit` | 44 | 315 | sin base (lógica pura; algunos con dobles de `fetch`) |
| `test/security` | 26 | 210 | casi todos PGlite con el rol de la app (`app_runtime`, sin BYPASSRLS) |
| `test/reliability` | 34 | 262 | PGlite |
| `test/architecture` | 1 | 3 | lee los imports de `src/` con el preprocesador de TypeScript |
| **Total** | **105** | **790** (`test(` en los archivos) → **798** según el runner | ~9 min (530 s) con la máquina tranquila; 18 min con load average 25–30 |

Los conteos por carpeta salen de contar `test(` en los archivos; el total y el tiempo, del resumen de `npm test`
(`# tests`, `# duration_ms`): el runner cuenta 8 más porque algunos tests se generan en bucles. Antes de los tests
de la lógica del panel (2026-10-31) eran 744. Ojo con dos cosas del contenedor de desarrollo (Node 22; el repo pide 24):

- Los 2 tests de timeout de `test/unit/emailResend.test.ts` salen como `cancelled` siempre, y los 4 últimos de
  `test/reliability/agent.test.ts` ("runner: cada llamada tiene timeout…" y los que siguen) a veces: un
  `AbortSignal.timeout` no mantiene vivo el event loop y el proceso del archivo termina antes. No son regresiones.
- Con la máquina cargada, un archivo pesado puede pasar el `--test-timeout=120000` (es por archivo): se ve como
  `not ok … test/security/<archivo>.test.ts` con `testTimeoutFailure`. Se confirma corriéndolo solo.

Playwright: **91** tests (`server`: 7 en `test/e2e/smoke.spec.ts`; `panel-mock`: 84 en `test/e2e/*panel.spec.ts`).

**Decisión de herramienta:** **`node:test`** (runner nativo de Node) + `node:assert/strict`, corrido con `tsx`. Cero
dependencias nuevas → cumple la política supply-chain del `CLAUDE.md` sin trámite. Para el panel en el navegador,
**Playwright** (`@playwright/test@1.60.0`). Evals del agente: script propio con `tsx`. El panel (`web/`) **no tiene
runner propio** (ni vitest ni jest): su lógica pura se prueba desde `test/unit` importando `../../web/src/...`.

---

## Estructura

```
test/
  unit/          # lógica pura del backend y del panel (sin base): ángulo 1
  security/      # auth, RLS, permisos por rol y plan por HTTP, inventario de rutas, secretos: ángulos 2 y 8
  reliability/   # servicios y SQL reales sobre PGlite: cola, recordatorios, webhook, agente con OpenAI mockeado: ángulos 3 y 5
  architecture/  # moduleBoundaries.test.ts: fronteras entre módulos (PLAN-GESTION.md §2)
  e2e/           # Playwright: smoke.spec.ts (server real) y *panel.spec.ts (panel contra la API simulada)
    seededServer.ts  #   server real del proyecto `server`: PGlite nuevo + migraciones + scripts/seedDev.ts
  helpers/       # pgliteDb.ts (Postgres efímero), panelClient.ts (cliente HTTP con cookies y Origin), *Fixtures.ts, queue.ts
eval/            # evals del agente contra OpenAI real (ángulo 4, NO en CI)
scripts/
  checkMigrations.ts  # guardrail de drift (ángulo 7)
  ci/                 # guardrails de CI (checkSecrets, checkExactVersions, checkEnvExample, checkAudit) y smoke.sh
playwright.config.ts  # proyectos `server` y `panel-mock`, workers: 1
```

---

## Los ángulos

Un ✅ significa "implementado y corriendo en CI (o documentado como manual)".

### 1. ✅ Suite unitaria de lógica pura (`test/unit`)

Sin base ni red. Cuando la lógica estaba mezclada con I/O se extrajo una función pura y se prueba esa (mismo
comportamiento en producción).

**Backend** (`src/`): disponibilidad y horario semanal (`availability`, `weeklyHours`), plan de recordatorios
(`reminderPlan`), estados y reglas de clientes (`clientStatus`, `clientRules`, `clientPhone`, `clientsCsv`),
catálogo de planes y overrides de `extra_modules` (`billingPlans`), plantillas de rubro (`industryTemplates`),
contexto y prompt del agente (`businessContext`, `agentPrompt`, `agentHistoryCost`, `growthCommands`), WhatsApp
(`whatsapp`), cola y concurrencia (`queue`, `concurrency`, `scheduler`, `transient`, `shutdown`), correo
(`email`, `emailJob`, `emailResend`, `emailTemplates`), router y validación (`router`, `validation`, `panelApi`),
montos (`currency`), reportes CSV y métricas (`reportsCsv`, `metrics`), almacenamiento, URLs públicas, logs,
alertas, backups, pool de la base, auditoría de dependencias (`checkAudit`) y el arnés de evals (`evalHarness`).

**Panel** (`web/src/`, lógica pura sin DOM): se importa directo desde `test/unit` y la chequea el typecheck raíz.

| Módulo del panel | Qué se prueba | Archivo |
|---|---|---|
| `app/navigation.ts` | matriz rol × plan (Básico, Pro, Pro sin agente, Básico con Campañas) de `accessFor` / `navItemsFor`: qué sección se ve, cuál va con candado (upsell) y cuál se oculta; páginas de Configuración por rol y plan; `homePathFor` (el profesional cae en `/agenda`); `terminologyOf` y rótulos por rubro | `panelNavigation.test.ts` |
| `lib/api.ts` | `apiRequest` con `fetch` simulado: 200 `{ ok: true }`, 204, 4xx con sobre y errores por campo, 502 con HTML de proxy, `fallbackCode` por status, red caída → `network_error`, 401 `unauthorized` → `onUnauthorized` (otro 401 no), `business_paused` desde cualquier ruta menos `/auth/me` y `/billing/*`, `setTransport`; `apiDownload` con error; `filenameFromDisposition` | `panelApiClient.test.ts` (`panelApi.test.ts` es el del server) |
| `lib/branding.ts` | `contrastRatio` (WCAG); `accentFor` deja ≥ 4,5:1 en tema claro y oscuro para una grilla de 216 colores + casos difíciles; `safeLogoUrl` rechaza `javascript:`, `data:`, otros esquemas y rutas que el navegador lee como otro host (`//`, `/\`, `/<tab>/`); `initials`, `documentTitle`; `PRODUCT_NAME` espejo del backend | `branding.test.ts` |
| `lib/plans.ts` | `usageText`, `atLimit` (tope, sin tope, cero), `trialDaysLeft` (redondeo, vencida, offsets), `trialEndsText`, `monthLabel`, `pausesAtText`; `MODULES`/`PLAN_MODULES` espejo del catálogo del backend | `plans.test.ts` |
| `modules/{clients,reports,sales,scheduling,whatsapp}/format.ts` | teléfonos y `phoneMatches`, `compactCents` (signo, bordes de escala), `deltaText`, `formatRate`, `formatMinutes`, `parsePercent`, `shiftDate`, `dayRange` (incluido un cambio de horario), fechas en la zona del negocio, bandeja relativa a hoy | `panelFormat.test.ts` |
| `lib/money.ts` | montos en céntimos, gemelo de `src/platform/money/currency.ts` | `currency.test.ts`, `panelSettings.test.ts` |
| `modules/settings/{hoursDraft,zonedTime}.ts` | borrador del editor de horario (mismas reglas que el backend) y fechas en la zona del negocio | `panelSettings.test.ts` |
| `modules/scheduling/agendaLayout.ts` | columnas de la agenda, ventanas de trabajo, semana | `agendaLayout.test.ts` |

**Para que el panel se pueda importar en Node:** ningún módulo que testea `test/unit` lee `import.meta.env` al
cargarse (bajo `tsx` no existe). El modo mock vive en `web/src/lib/mockMode.ts` y `main.tsx` inyecta el transporte
del mock con `setTransport`; `lib/api.ts` usa `fetch` por defecto. Lo que solo necesita un tipo de un `.tsx`
lo toma de un `.ts` (p. ej. `ui/iconIds.ts`), porque el typecheck raíz no compila JSX. Lo que toca el DOM
(`applyBranding`, `saveBlob`, componentes) queda para Playwright.

### 2. ✅ Aislamiento multi-tenant (`test/security`)

**Una fuga acá es un incidente, no un bug cosmético.** La base de los tests corre con el rol de la app
(`app_runtime`, **sin BYPASSRLS**), como en producción, así que una consulta fuera de `withTenant`/`withSystem`
falla en el test:

- `rls.test.ts`: toda tabla (en los `schema.ts` y en la base) tiene RLS, política y GRANT para `app_runtime`; un rol
  sin BYPASSRLS (como `anon` de la Data API de Supabase) no ve filas aunque tenga GRANT.
- `rlsEnforced.test.ts`: cada función de la plataforma que toca Postgres se ejerce con el rol de la app: sin contexto
  no ve nada, y con el de un negocio no lee ni escribe lo de otro.
- Por HTTP con la app real (`createAppHandler`): `clients`, `crmClients`, `scheduling`, `sales`, `reports`,
  `settingsAccess`, `aiSettingsAccess`, `whatsappInbox`, `growthAccess`, `billingAccess`: dos negocios, y lo de uno
  no se ve ni se toca desde el otro; permisos por rol y por sucursal; corte Básico vs. Pro.
- `routeInventory.test.ts`: congela **quién** puede llamar **cada** ruta de `src/routes.ts`; una ruta nueva sin
  entrada en la tabla rompe el test.
- `test/reliability/queueRls.test.ts`: la cola respeta el negocio que encoló.

### 3. ✅ End-to-end del webhook de WhatsApp (`test/reliability`, sin red)

Graph, OpenAI, Storage y Web Push son dobles (`test/helpers/whatsappFixtures.ts`) que anotan lo que se les pidió.

- `whatsappWebhook.test.ts`: verificación de Meta, firma (sin firma o ajena → 401), tope del cuerpo (413), ruteo e
  idempotencia (un reintento de Meta no duplica), números sin canal y payloads ilegibles a `raw_webhooks`, negocio pausado.
- `whatsappPipeline.test.ts`: job `whatsapp.inbound` con la cola real: el agente responde (texto y botones), ráfagas
  (agrupar, ceder ante foto o acción directa), `BAJA`, confirmar/cancelar desde el recordatorio, modo humano y su vencimiento.
- `agent.test.ts`: el agente contra el esquema real y el demo de `seed:dev` con OpenAI mockeado (tools, agenda,
  escalada).
- `whatsappReminders.test.ts`, `whatsappPlanLimits.test.ts`, `growth.test.ts`: recordatorios por WhatsApp, topes del
  plan y crecimiento (cotización, upsell) de punta a punta.

### 4. 🟡 Evals del agente (LLM — arnés listo; falta la primera corrida real y la línea base)

Es el ángulo de **calidad/valor**: ningún unit test dice si el agente cotiza bien, elige el
servicio correcto, respeta el horario o escala en vez de improvisar. `npm run eval` corre el
`AgentRunner` **real** (`createAgentRunner`, `src/modules/whatsapp/agent/runner.ts`) contra
**OpenAI real**, con conversaciones fijas y comprobaciones laxas y deterministas. **No corre en
`npm test` ni en CI** (cuesta tokens; el gate automático es del prompt `tests-de-regresion`).

```
eval/
  runEval.ts      # main: carga y valida los casos, corre cada uno N veces, umbral, tope de gasto, reporte
  assertions.ts   # tipos (EvalCase, Expectation), carga y validación de casos, comprobaciones (lógica pura)
  report.ts       # umbral, tope de gasto, JSON de resultados y línea base (lógica pura)
  world.ts        # el negocio de cada caso: demo de seed:dev (estética) u otra plantilla como un alta real
  transcripts/    # 35 casos .json (uno por archivo)
  results/        # una corrida = un JSON (gitignored)
  baseline.json   # línea base versionada (se crea con la primera corrida real completa)
```

**Sobre qué corre.** Todo en un PGlite efímero (nunca `DATABASE_URL` ni `PGLITE_DIR`); el
agente no manda nada por WhatsApp ni sincroniza nada. "Ahora" es el próximo martes 09:00 de
Costa Rica, así "mañana" siempre tiene atención. Cada caso siembra su negocio:

- **Estética** (default): el demo de `seed:dev` (Escazú y Heredia, precios, equipo y citas de la semana).
- **Otra plantilla** (`"template": "dental" | "nails" | "generic"`): un negocio nuevo de ese
  rubro creado con `createBusiness` (terminología, catálogo y registro de la plantilla), una
  sucursal "Escazú" en el horario por defecto del alta, dos personas y los precios de demo de
  `TEMPLATE_PRICES` (`eval/world.ts`). Uñas y dental son los rubros prioritarios para el primer cliente.

**Un caso** (`eval/transcripts/NN-nombre.json`) tiene `name`, `description`, `user` (el mensaje
del turno) y `expect`; opcionales: `template`, `register` (`vos` / `tu` / `usted`; sin él, el
de la plantilla), `growth` (`{ "quoteRecovery": true }` y/o `{ "upsell": [{ "service", "suggest" }] }`,
por nombre de servicio), `channel: "all"` (el número atiende las dos sucursales), `history`
(turnos previos de hoy; `"byHuman": true` en un mensaje del asistente = lo escribió una persona
desde la bandeja), `seedAppointments` y `critical`. Las comprobaciones (`Expectation`): `tool`,
`anyTool`, `notTool`, `noTools`, `argIncludes` (con `"$service:<nombre>"`), `handoff`,
`outOfScope`, `buttons`, `action`, `notAction`, `contains`, `containsAny`, `containsEach`,
`notContains`, `noAmount` (+ `allowedAmounts`: montos reales que sí puede citar) y `currentYearDates`.

**Qué cubren los 35 casos:** saludo y registro (vos, tú, usted), precio inventado vs. de
catálogo vs. "se cotiza", horarios con botones y año correcto, agendar / consultar /
reprogramar / cancelar con confirmación previa, **confirmación negativa** (eligió hora sin
"sí", o duda → no agenda), **día cerrado y hora fuera de horario** (aunque el historial ya
"acordó" las 20:00, no queda ninguna cita), fuera de alcance vs. pasar a una persona (pedido
explícito, alergia, urgencia dental), sucursal a elegir, **cliente en inglés**, **uñas** (precio,
diseño de precio variable → foto de referencia, horarios) y **dental** (usted, "se cotiza",
urgencia, horarios), **nota de voz** (`[audio] …`), **mensajes tras una persona del equipo**
(sigue el hilo; no vuelve a escalar lo que ya autorizó) y **crecimiento**: cotización
(`record_quote`) y upsell ofrecido, aceptado (`add_service_to_appointment`) y rechazado
(`decline_upsell`). La inyección y extracción del prompt son del prompt `prompt-injection`.

**Cómo correrlas:**

| Comando | Qué hace |
|---|---|
| `EVAL_DRY_RUN=1 npm run eval` | Sin OpenAI ni tokens: valida los casos, siembra el mundo de cada uno y corre el runner con un modelo de mentira (no evalúa las comprobaciones). Sale con 0 si el arnés está sano. |
| `npm run eval` | Una pasada con el modelo de `OPENAI_MODEL` (default `gpt-4o-mini`). |
| `EVAL_REPEAT=3 npm run eval` | Cada caso 3 veces (el agente no es determinista): mide la tasa por caso. |
| `EVAL_CASE=upsell npm run eval` | Solo los casos cuyo nombre contiene el texto. |
| `EVAL_VERBOSE=1 …` | Muestra en consola la respuesta de los casos que fallan (no va al JSON). |
| `EVAL_REPEAT=3 EVAL_WRITE_BASELINE=1 npm run eval` | Además guarda `eval/baseline.json` (solo si la corrida es completa, sin `EVAL_CASE` y con 3+ repeticiones). |

Necesita `OPENAI_API_KEY` de **desarrollo** (nunca la de producción) en el entorno o en `.env`.
**Sin key no corre nada:** imprime "Evals SALTADAS", no escribe resultados y sale con 0 (no
finge resultados). Los casos inválidos (tool o servicio inexistente, servicio que no se
agenda en línea, tool de crecimiento sin su `growth`, `byHuman` en un mensaje del cliente)
frenan la corrida con código 2 antes de gastar un token.

**Cuándo correrlas:** antes de mergear un cambio del **prompt** (`src/modules/whatsapp/agent/prompt.ts`),
de las **tools** (`tools.ts`: definiciones, argumentos o lo que devuelven), del **modelo**
(`OPENAI_MODEL`) o de la temperatura / pasos del runner, y de las plantillas de rubro (`ai` de
`src/modules/business/templates/*.json`). Con `EVAL_REPEAT=3` y comparando con la línea base;
si el cambio la mejora a propósito, se regraba `eval/baseline.json` en el mismo PR.

**Cómo leer el umbral.** Un caso pasa si su tasa (verdes / repeticiones) llega a
`EVAL_MIN_PASS_RATE` (default **0,9**); los `critical` exigen **100 %** ("no inventa precios":
02 y 22; "no agenda fuera de horario": 27 y 28). Con `EVAL_REPEAT=3`, 0,9 significa 3 de 3
(2/3 = 67 %): el margen del 90 % aparece desde 10 repeticiones (9/10). En consola: ✅ todas
verdes, 🟡 alguna roja pero sobre el umbral, ❌ bajo el umbral, ⏭️ sin correr (tope de gasto),
y "(línea base 3/3)" al lado si hay `eval/baseline.json`. Código de salida: 0 todo sobre el
umbral; 1 algún caso debajo o corrida incompleta; 2 casos o variables inválidos.

**Tope de gasto.** `EVAL_MAX_COST_USD` (default **US$1** por corrida) con el costo estimado por
las tarifas de `src/modules/whatsapp/agent/cost.ts`. Se mira entre turnos: al alcanzarlo la
corrida se corta (un turno de más cuesta centavos), los casos restantes quedan sin correr y no
sirve de línea base; si al ritmo actual no va a alcanzar, avisa temprano. Referencia
(estimación, no medida contra OpenAI): cada llamada al modelo lleva ~4 000 tokens de entrada
(prompt + tools de los casos, medido con `buildMessages`) y un turno hace 1–3 llamadas; 35
casos × 3 ≈ 105 turnos ≈ US$0,10–0,20 con `gpt-4o-mini`. Con `gpt-4o` (~16 veces más caro) el
tope de US$1 corta la corrida: subilo a conciencia (`EVAL_MAX_COST_USD=4`).

**Resultado.** Cada corrida real escribe `eval/results/<AAAA-MM-DD-HHMM>-<modelo>.json`:
modelo, fecha, repeticiones, umbral, costo, tokens y, por caso, repeticiones, verdes, tasa,
tasa exigida, si pasó y los motivos de fallo de las comprobaciones. **Sin datos personales:** no
guarda las respuestas del agente; el cliente y el negocio son ficticios (`seed:dev` y `eval/world.ts`).

**El arnés se testea a sí mismo:** `test/unit/evalHarness.test.ts` (en `npm test`, sin red)
valida que haya ≥ 25 casos válidos contra la plantilla que eligen (tools reales, servicios
que el agente ve, crecimiento activo si se esperan sus tools), que estén los grupos de arriba,
las comprobaciones en ambos sentidos, el umbral y el reporte (sin respuestas), siembra el mundo
de cada plantilla, corre con un **modelo guionado** los casos de agenda, horario y crecimiento
para probar que son alcanzables (un caso imposible se leería como "el agente falló": así salió
que `Peeling químico` no se agenda en línea), y que sin `OPENAI_API_KEY` la corrida se salta.

**Pendiente:** la primera corrida real con `EVAL_REPEAT=3` y su `eval/baseline.json` (todavía
no hay key de OpenAI de desarrollo). Hasta entonces no hay tasa de acierto medida.

### 5. ✅ Fiabilidad y concurrencia (`test/reliability`, PGlite)

Corre contra un **Postgres efímero en el proceso (PGlite)** — Postgres real compilado a WASM — con las migraciones
reales de `./drizzle` (`test/helpers/pgliteDb.ts`). Así se ejerce el **SQL de producción** (`FOR UPDATE SKIP
LOCKED`, `EXCLUDE`, CAS, fencing), no una reimplementación en memoria.

- **Cola durable** (`queueStore`, `queueWorker`, `queuePausedBusiness`, `emailQueue`): outbox y dedupe, dos workers
  sin doble proceso, reparto entre negocios, un job en vuelo por `group_key`, reintentos con backoff, DLQ, error
  permanente, recuperación de un worker muerto, latido, timeout, apagado ordenado; un negocio pausado no corre trabajo nuevo.
- **Lease de liderazgo** (`leaderLease`): un solo titular, renovación y traspaso.
- **Citas** (`appointments`, `appointmentOverlap`, `schedulingInputs`): reservas simultáneas (una gana, las otras
  409), anti-solape **en la base** (`EXCLUDE` por profesional, rango semiabierto, canceladas no bloquean).
- **Recordatorios** (`reminders`, `whatsappReminders`): reservar programa, el barrido encola una sola vez,
  reprogramar/cancelar invalida lo pendiente, canal según lo conectado.
- **Dominio de gestión** (`sales`, `commissions`, `reports`, `clientsService`, `clientsFilters`,
  `clientsImportExport`, `customFields`, `settingsApi`, `aiSettings`, `onboarding`): saldos, devoluciones,
  comisiones sobre lo cobrado, agregados de reportes en la zona del negocio, CRM e importación/exportación CSV.
- **Cobro e identidad** (`billingPause`, `stripeWebhook`, `signup`, `identityEmail`): gracia por falta de pago, webhook
  de Stripe con un doble de su API, alta self-service y recuperación de clave por la cola de correo.
- **Esquema y arranque** (`domainSchema`, `clientsAnonymizedMigration`, `seedDev`, `health`): lo que vive en SQL a
  mano, una migración con backfill, el seed de desarrollo contra el esquema real y el health check con ping a la base.

**Fidelidad:** PGlite es de **una sola conexión**, así que las corridas "concurrentes" (`Promise.all`) se
serializan. La atomicidad de un `UPDATE` y los CAS los garantiza Postgres igual en serie; la contención real de dos
backends en paralelo necesitaría un Postgres multi-conexión (no está en CI).

### 6. ✅ Panel E2E (Playwright, proyecto `panel-mock`)

`test/e2e/*panel.spec.ts` (84 tests): el panel compilado por Vite en **modo mock** (`npm --prefix web run dev:mock`,
`VITE_MOCK_API=1`): las respuestas salen de `web/src/lib/mockApi.ts` con la misma forma del contrato, sin backend.
Cubre login, layout, rutas, menú por rol y plan, superadmin y cada sección: `panel` (shell), `agenda`, `clients`,
`crm`, `sales`, `reports`, `whatsapp`, `growth`, `billing`, `onboarding`, `settings-panel`. El estado del mock vive
en `sessionStorage`, así que cada test arranca limpio. Corre en CI en el job `e2e` junto con el proyecto `server`
(ángulo 9) y **bloquea el deploy**.

- Correrlo solo: `E2E_PANEL_ONLY=1 npx playwright test --project=panel-mock` (no levanta el backend). Puertos
  `E2E_SERVER_PORT` / `E2E_PANEL_PORT` para correr en paralelo desde varios worktrees; `E2E_CHROMIUM_PATH` para un
  Chromium ya instalado (solo local).
- Medido el 2026-10-31 en el contenedor de desarrollo: 84 tests en ~9 min. `whatsapp.panel.spec.ts` › "push: el botón
  aparece…" falla en ese contenedor también sin cambios (su Chromium arranca con el permiso de notificaciones "sin
  decidir" en vez de "bloqueado"); en CI, con el Chromium de `npx playwright install`, pasa.

### 7. ✅ Guardrail de migraciones en CI

- Cambiar un `schema.ts` **sin** migración rompe el deploy en silencio (`migrate.ts` aplica solo las migraciones
  existentes y la base queda distinta al código).
- [x] **Drift** (`npm run db:check` → `scripts/checkMigrations.ts`, job `verify`, **bloquea el deploy**): corre
  `drizzle-kit generate` offline (snapshots de `./drizzle/meta`, sin base) y falla si produce cambios en `./drizzle`.
  Deja el árbol como lo encontró.
- [x] **Que las migraciones apliquen limpio** lo cubre `npm test`: PGlite aplica las migraciones reales en cada corrida.

### 8. ✅ Seguridad (`test/security`)

- **Auth** (`auth`, `totp`, `identity`, `superadmin`, `superadminPlans`): sesión firmada (round-trip, token
  manipulado/vencido/basura → `null`), scrypt con anti-timing, rate limit de login, 2FA TOTP con anti-replay, cookie
  aparte del superadmin.
- **HTTP** (`http`, `securityHeaders`): input hostil sin autenticar, CSRF por `Origin`, cabeceras (nosniff,
  `frame-ancestors`, CSP) del handler real de `src/app.ts`.
- **Permisos y planes** (`planLimits`, `whatsappPlanAccess`, `billingAccess` y los del ángulo 2): cada rol y cada
  plan contra cada ruta; `routeInventory` congela el acceso de todas.
- **Secretos** (`secrets`, `requiredSecrets`, `checkSecrets`): cifrado en reposo de tokens de terceros, arranque
  fail-closed en producción sin secretos, y el guardrail `npm run ci:secrets` corrido sobre archivos temporales.
- **Datos personales** (`logsWithoutPii`): los logs no llevan teléfonos completos ni el texto de los mensajes (Ley 8968).
- `/security-review` sobre el diff antes de cada merge grande **es un paso de proceso**, no un test.

### 9. ✅ Smoke tests (CI y post-deploy)

Dos capas, con los mismos chequeos de API. Cada uno falla si se rompe una capa distinta (router, sesión, login,
base), no solo si el proceso está caído.

**Post-deploy y post-rollback: `scripts/ci/smoke.sh <BASE_URL>`** (bash + curl, sin dependencias). Lo corre
`.github/workflows/ci-cd.yml` en el job `deploy` (paso "Smoke post-deploy", después del `/health` con reintentos)
y en el job `rollback` (paso "Smoke post-rollback"; el script sale del commit del workflow, no del SHA revertido).
Si falla, el SHA **no** se guarda como `~/.ultimo-deploy-ok`. No usa credenciales reales ni toca datos:

- [x] **`/health` → 200 `…: ok`** (proceso + ping a la base).
- [x] **El bundle React sirve** (`/panel` → 200 y contiene `<div id="root">`): atrapa "falta el build".
- [x] **El router de la API está montado** (`GET /api/panel/<ruta inexistente>` → **404** JSON `not_found`).
- [x] **La sesión se valida** (`GET /api/panel/auth/me` sin cookie → **401** JSON `unauthorized`; un 404 delata
  que la ruta desapareció y un 500 que algo se rompió).
- [x] **Login vivo + base sana** (`POST /api/panel/auth/login` con `Origin` del host y el correo de smoke
  `smoke-test@selyon-smoke.invalid` → **401** `invalid_credentials`; pasa CSRF + validación y consulta la base, así
  que un 500 la delata). Es **un** intento fallido por corrida: suma al rate-limit de la IP del runner y queda en los
  logs con ese correo (dominio reservado `.invalid`, reconocible). Aceptado por el usuario el 2026-10-30.
- **No** hay usuario de smoke en producción (decisión del 2026-10-30): el login **exitoso** se prueba solo en CI.
- Si cualquiera falla, el script sale con código ≠ 0 (los corre todos y lista cada falla) y el job queda en rojo.
- A mano, contra un server local (`npm run dev` sobre PGlite): `bash scripts/ci/smoke.sh http://localhost:3000`.
  Contra producción lo corre solo el pipeline (cada corrida suma un login fallido).

**En CI: `test/e2e/smoke.spec.ts`** (proyecto `server` de Playwright, job `e2e`, bloquea el deploy). El server real
arranca con `test/e2e/seededServer.ts`: PGlite nuevo en una carpeta temporal + migraciones + `scripts/seedDev.ts`
(negocio demo con la clave pública de desarrollo), y recién después `src/server.ts` sobre esa misma carpeta. Cubre
lo mismo que `smoke.sh` (salvo correr contra producción) y además:

- [x] **Login real de punta a punta:** la dueña demo entra por la UI del panel compilado (no el mock), llega al
  **Inicio** con la tarjeta del día (sale de la API) y su cookie vale contra `GET /api/panel/auth/me` (200, negocio
  "Estética Demo"). Es el único E2E contra el backend real; el resto de los E2E del panel corre contra
  `web/src/lib/mockApi.ts`.
- [x] La landing (`/`) carga.
- Correrlo: `npm run web:build && npx playwright test --project=server`. En un contenedor con un Chromium que no es la
  revisión de `@playwright/test`, `E2E_CHROMIUM_PATH=/ruta/al/chrome` (solo local; CI usa `npx playwright install`).

### 10. ⬜ QA manual en dispositivo (lo único que no se automatiza barato)

- [ ] Entrega de push **iOS/Android** real (pendiente en ROADMAP A5/A8).
- [ ] Plantillas Meta aprobadas fuera de ventana 24h (Utility quick-reply, MARKETING opt-out).
- [ ] Embedded Signup contra el popup real de Meta (C4.2, tras Business Verification).

---

## Cómo agregar tests

- **Lógica pura del backend o del panel** → `test/unit/<tema>.test.ts`, `node:test` + `node:assert/strict`, sin
  dependencias. Del panel se importa `../../web/src/...`: el módulo (y lo que importa) no puede leer
  `import.meta.env` al cargarse ni importar un `.tsx` (ver ángulo 1). Si toca el DOM, va a Playwright.
- **Algo que toca la base** → `test/reliability` (servicios, SQL, cola) o `test/security` (permisos, RLS, HTTP) con
  `test/helpers/pgliteDb.ts`; por HTTP con `test/helpers/panelClient.ts`. Una base por archivo.
- **Una ruta nueva** → su fila en la tabla de `test/security/routeInventory.test.ts` (quién puede llamarla).
- **Un flujo del panel en el navegador** → `test/e2e/<sección>.panel.spec.ts` contra el mock (y su respuesta en
  `web/src/modules/<sección>/*Mock.ts`); contra el server real solo lo del smoke (ángulo 9).
- Nada de red real ni de `DATABASE_URL`: OpenAI, Graph, Stripe, correo y push van con dobles (`test/helpers`).
- **Un caso de eval del agente** → `eval/transcripts/NN-<tema>.json` (ángulo 4; validado por `validateCase`, corre con
  `npm run eval`, NO en CI).

## Principios

1. **Determinista en cada push, no determinista aparte.** Nada que cueste tokens o toque red real corre en CI.
2. **Sin tocar producción.** Todo lo automatizado usa Postgres efímero (PGlite); jamás el `.env` real ni el droplet.
   La plantilla de PGlite (migraciones ya aplicadas) se arma una vez y se cachea en el tmp del sistema
   (`test/helpers/pgliteDb.ts`): cada base nueva sale de ese volcado en vez de migrar de cero.
3. **El sanity script de hoy es el test de mañana.** No botar verificaciones: al terminar una feature, dejar su prueba en `test/`.
4. **Aislamiento por negocio = seguridad, no calidad.** Se prueba siempre con el rol de la app (RLS activo).
5. **Cubrir el modo de fallo caro.** Migración silenciosa y fuga entre negocios antes que cobertura cosmética.
