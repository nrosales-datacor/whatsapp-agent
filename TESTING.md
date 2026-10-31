# TESTING.md — Estrategia de pruebas del agente de WhatsApp

> **Objetivo:** probar la app desde todos los ángulos para asegurar funcionamiento **correcto** (no rompe),
> **fiable** (no duplica, no pierde mensajes, aislado por tenant) y **de valor** (el bot cotiza/agenda/escala bien).
>
> **Este doc es un plan, no un estado.** A medida que se implemente cada ángulo, marcar su casilla y anotar
> el comando/archivo real. Mantener vivo igual que `ROADMAP.md`.
>
> **Última actualización:** 2026-10-31 (ángulo 4, evals: arnés real con 35 casos, umbral y tope de gasto; falta la
> primera corrida con OpenAI y la línea base). Antes, 2026-07-14 (ángulos 1–5, 7, 8 y 9 completos; ángulo 6 implementado por la
> UI in-memory — los flujos que exigen base de datos quedan documentados para la corrida con Postgres;
> ángulo 10 es QA manual en dispositivo, no automatizable)

---

## Punto de partida (qué hay hoy)

- **No hay pruebas automatizadas permanentes.** No hay runner (vitest/jest) ni carpeta de tests.
- Lo que se hizo hasta hoy: `typecheck` (`tsc --noEmit`) + **"sanity scripts"** desechables (`tsx` de un solo uso,
  descritos en cada ítem del ROADMAP pero **no versionados**) + verificación manual con Playwright.
  → Cada feature se verificó **una vez** y esa verificación se botó. **No hay red contra regresiones.**
- **Andamiaje ya disponible (barato de aprovechar):**
  - `src/booking/inMemoryRepository.ts` — repo completo sin Postgres.
  - `SEED_DEMO=1` — levanta el server con datos de demo, sin tocar producción.
  - Patrón de `fetch` mockeado para Graph API / OpenAI (ya usado en los sanity scripts).
  - `.github/workflows/ci-cd.yml` — pipeline listo para colgarle un paso `npm test`.

**Decisión de herramienta:** usar **`node:test`** (runner nativo de Node ≥18) + `node:assert`.
Cero dependencias nuevas → cumple la política supply-chain del `CLAUDE.md` sin trámite.
Para el panel se sigue con **Playwright** (ya en uso). Evals del agente: script propio con `tsx`.

---

## Los ángulos, priorizados por palanca

Orden = mayor retorno primero. Un ✅ significa "implementado y corriendo en CI (o documentado como manual)".

### 1. ✅ Suite unitaria de lógica pura (LA PRIORIDAD)

Runner `node:test` vía `tsx --test`, script `npm test` (corre en CI antes del typecheck, ver `.github/workflows/ci-cd.yml`). 56 casos en `test/unit/*.test.ts` + fabricadores en `test/helpers/fixtures.ts`:

| Módulo | Qué probar | Archivo |
|---|---|---|
| `booking/availability.ts` | espacios libres, choque con cita existente, **bloqueos/feriados**, horario por día | `test/unit/availability.test.ts` |
| `campaigns/segmentos.ts` | cada segmento: todos / inactivos ≥N días / servicio hace ≥N meses, con datasets armados a mano | `test/unit/segmentos.test.ts` |
| `billing/planes.ts` | `tenantPuede(tenant, "campanias"\|"multiUsuario"\|"whiteLabel")` para básico/pro | `test/unit/planes.test.ts` |
| `config/validadores.ts` | hex `#rrggbb`, URLs http(s)/vacío, horarios, servicios, precios | `test/unit/validadores.test.ts` |
| `panel/metricas.ts` | `noShowPct`, `ahorroBotPct`, nuevos vs. recurrentes, bot vs. manual — con conteos exactos | `test/unit/metricas.test.ts` |
| `whatsapp/client.ts` | round-trip protocolo de botones (`confirmar\|`, `mover\|`, `postbien\|`, `postmal\|`, `opcionHorario`), `verificarWebhook`, `firmaValida` | `test/unit/whatsappClient.test.ts` |
| `whatsapp/client.ts` (`parsearEntrante`) | decodifica texto / audio / imagen / interactivo (button_reply) → frase | `test/unit/whatsappClient.test.ts` |
| `queue/cola.ts` | lógica de backoff exponencial y decisión de reintento (sin el SQL) | `test/unit/cola.test.ts` |

**Nota:** `campaigns/segmentos.ts` y `queue/cola.ts` tenían la lógica pura entrelazada con I/O (DB). Se extrajeron
`calcularSegmento(citas, conversaciones, filtro, hoy)` y `calcularBackoffSeg`/`agotoIntentos` (mismo patrón que
`calcularMetricas`, ya puro) para poder probarlas sin mockear Postgres/Drizzle. Comportamiento sin cambios.

**Pendiente de este ángulo:** ~~`handleWebhook` completo (el handler que orquesta parseo + dedup + cola) queda para
el ángulo 3 (E2E del webhook), ya que necesita repo en memoria + Graph API mockeado.~~ → Resuelto en el ángulo 3.

**Meta:** convertir los sanity scripts ya descritos en el ROADMAP en tests **permanentes**. Logrado para lo determinista.

### 2. ✅ Invariante multi-tenant (SEGURIDAD)

Suite en `test/tenant/aislamiento.test.ts` (corre en CI vía `npm test`; el glob ya incluye `test/tenant/*.test.ts`).
Siembra **2 tenants** con el **mismo número de cliente** (la prueba más dura de la clave `tenantId:clienteWa`) y afirma:

- **Lecturas scopeadas:** un tenant sin datos no ve NADA del otro — `citasPorFecha`, `citasEnRango`,
  `citasActivasCliente`, `listarConversaciones`, `obtenerConversacionPorId`, `obtenerModo`, `fichaCliente`,
  `listarPushSubs`, `metricas`. Y con el mismo cliente en ambos, cada uno ve **solo lo suyo** (nombre/ficha/servicio/subs).
- **Escrituras rechazadas:** test parametrizado que recorre cada mutación con el `tenantId` equivocado y espera
  rechazo + estado intacto: mutaciones de cita (`reprogramar`/`cancelar`/`confirmar`/`completar`/`marcarNoShow`
  → `null`) y de conversación (`setModo`/`marcarEstado`/`guardarNotas`/`marcarLeidas` → no-op). Cada test tiene
  su **control positivo**: el dueño legítimo SÍ puede, para no pasar por un bug genérico.
- **Recordatorios** (sin `tenantId`, keyed por `citaId` único): el claim de una cita no bloquea la del otro tenant.

**Fuera de alcance de este bloque:** `usuarios` / `config` / `campañas` viven en el tenantStore y sus módulos; su
aislamiento lo cubren el panel E2E (ángulo 6) y `test/security/rlsAplicado.test.ts`, que corre TODO el acceso a
datos de producción con el rol `app_wa` (sin BYPASSRLS): una consulta sin `conTenant`/`conSistema` falla ahí.
- **Una fuga acá es un incidente, no un bug cosmético.** Bloque propio, sin excepciones.

### 3. ✅ End-to-end del webhook (in-process, sin red)

Suite en `test/e2e-webhook/webhook.test.ts` (corre en CI vía `npm test`). Repositorio real sobre PGlite
(`test/helpers/repoDePrueba.ts`: una base por archivo, vaciada con TRUNCATE entre tests) + `global.fetch`
mockeado (`test/helpers/webhookMock.ts`) que atiende los tres destinos del flujo SIN red: Graph API (envíos, capturados
para afirmar qué respondió el bot), descarga de media (bytes falsos, para visión), y OpenAI (turnos **programados** por el
test → agente 100% determinista). `test/helpers/setupEnv.ts` fija `OPENAI_API_KEY` dummy antes de importar el server
(módulos como `whatsapp/transcribir.ts` construyen su cliente OpenAI en el load). Se afirma la salida de `responderEntrante`
(a quién/qué se respondió, qué quedó en el repo, y si el agente se invocó o no):

- [x] Cotiza con el texto del agente ante **texto** y ante **foto** (visión): la foto se descarga, se adjunta al LLM como
  `image_url` y se guarda en el mensaje (relay fiel — que el precio sea correcto es del ángulo 4, evals).
- [x] Agenda: el agente ofrece horarios como **lista** tocable (slots codificados `slot|fecha|hora`); el **tap** crea la cita.
- [x] Reprograma por el bot (C1.1) y **reinicia los recordatorios** (`recordatorioDiaAntesEn` → null).
- [x] **Escala a humano**: escotilla por texto ("agente"), `escalar_a_humano` del agente, y respeta la **ventana humana**
  (si un humano toma la conversación mientras el LLM piensa, se descarta la respuesta).
- [x] **`BAJA`** (exacto) marca opt-out sin agente; "baja" en una frase NO es falso positivo (pasa al agente).
- [x] Confirmación de cita por botón (C1.3) es **acción directa** (no pasa por el agente).
- [x] Post-servicio (C3.1): "Todo bien" manda link de reseñas; "Tuve un problema" escala a humano.
- [x] **Dedup por `wamid`**: reenviar el mismo mensaje no re-procesa (`ingerirEntrante` devuelve null la 2ª vez).

**Nota:** la sincronización a Google Calendar en `agendar_cita` es no-op sin `GCAL_*` (no se ejerce acá); su lógica pura
ya está cubierta indirectamente por el repo. `notificarOperador` sin VAPID solo loguea, así que tampoco toca red.

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

### 5. ✅ Fiabilidad y concurrencia (validar lo que B1/B4 prometen)

Suite en `test/reliability/*.test.ts` (corre en CI vía `npm test`; el glob ya la incluye). Corre contra un **Postgres
efímero in-process (PGlite)** — Postgres real compilado a WASM, sin servidor ni Docker — al que se le aplican las
migraciones reales de `./drizzle` (helper `test/helpers/pgliteDb.ts`). Así se ejerce el **SQL de producción**
(`FOR UPDATE SKIP LOCKED`, CAS de recordatorios, backoff, reaper), no una reimplementación en memoria.

- [x] **Cola durable** (`colaDurable.test.ts`): un job pendiente se reclama **exactamente una vez** (un 2º worker no lo
  re-entrega); al fallar reencola con **backoff** (no reclamable antes de `ejecutar_despues_de`) y al agotar intentos
  queda en `error`; `guardarEntranteYEncolar` es **idempotente por `wamid`** (un reintento de Meta no duplica el job).
- [x] **2 instancias no duplican recordatorios** (`recordatorios.test.ts`): claim atómico B4 — 8 intentos concurrentes
  por `citaId`/tipo → **un solo ganador**; `revertir` (envío falló) permite reintentar; el claim de una cita no bloquea otra.
- [x] **2 instancias no duplican envíos de campaña** (`campanias.test.ts`): cada envío se reclama una sola vez al drenar
  la cola y ante claims concurrentes; **no se reclama si la campaña no está `enviando`** (cancelada a mitad).
- [x] **Throttling de campañas** respeta `CAMPANIA_ENVIO_INTERVALO_MS`: se extrajo `elegirEsperaMs(huboEnvio, intervalo, poll)`
  (pura, mismo patrón que el ángulo 1) y se prueba la política; el loop del worker la usa.
- [x] **Reaper recupera jobs colgados**: un job `procesando` con `locked_at` viejo se reencola (`reencolarVencidos`); uno
  con lock reciente no se toca.

**Gotcha de driver:** `db.execute(sql\`…\`)` devuelve formas distintas según el driver (postgres.js → arreglo; PGlite →
`{ rows }`). Se absorbe con `src/db/filas.ts` (`filasDe`), dejando las colas agnósticas del driver — comportamiento en
producción sin cambios (con postgres.js el resultado ya es el arreglo).

**Fidelidad / fuera de alcance:** PGlite es de **una sola conexión**, así que las corridas "concurrentes" (`Promise.all`)
se serializan. Eso NO debilita el invariante que importa: la atomicidad del `UPDATE` de una fila y el CAS los garantiza
Postgres igual en serie. La **contención real de 2 backends en paralelo** (que atraparía una regresión que quite el
`FOR UPDATE SKIP LOCKED`) necesita un Postgres multi-conexión y se cubriría en el job de **Postgres efímera del ángulo 7**.

### 6. ✅ Panel E2E (Playwright — formalizar lo que hoy es manual)

Suite en `test/e2e-panel/*.spec.ts` (Chromium, `npm run test:e2e`; corre en CI como **job aparte**
`e2e-panel`, que además **bloquea el deploy**). Playwright `@1.60.0` fijo (política supply-chain). El
webServer levanta el **mismo `src/server.ts`** en modo seguro (`test/e2e-panel/servidor.ts`): base **local del server** (PGlite en
memoria, sin `DATABASE_URL` → jamás toca producción; se neutraliza el `.env` real vía `DOTENV_CONFIG_PATH`),
`SEED_DEMO=1`, y **Graph API mockeado in-process** (reusa el helper del ángulo 3) para que `responder` envíe
sin red. `workers:1` porque todas las specs comparten la base del proceso.

- [x] **Login** (feliz + credenciales malas) → **responder** (el mensaje del operador aparece, Graph mockeado)
  → **toggle bot/humano** → **marcar atendido/reabrir**. Todo por la UI real.
- [x] Bandeja con conversaciones sembradas; abrir chat → mensajes → **ficha del cliente** → **dashboard**.
- [x] Agenda: **crear / confirmar / reprogramar / completar / cancelar / no-show** (ciclo CRUD por la API
  autenticada); la vista y el modal "Nueva cita" cargan por la UI.
- [x] **Guards de rol:** operador recibe **403** en `GET /usuarios` y `POST /config`; el dueño **pasa** el guard
  (cae en el 503 de "requiere DB") — códigos distintos ⇒ el 403 es por rol. Las cookies se **mintean** con el
  `PANEL_SESSION_SECRET` conocido, sin depender de que exista el usuario en la base.
- [x] **CSRF:** `POST` con `Origin` ajeno → 403; con el `Origin` del host → pasa el guard (y falla por credenciales).
- [x] **Responsivo 390/1440px × claro/oscuro; sin errores de consola** (pageerror + console.error, filtrando ruido de red/PWA).
- [x] **PWA:** `sw.js` (200 + `Service-Worker-Allowed: /panel/`), `manifest.webmanifest`, íconos.
- [x] **Con base de datos → proyecto Playwright `db`** (`test/e2e-db/*.spec.ts`, ~125 casos). Su server
  (`test/e2e-db/servidor.ts`) es el mismo `src/server.ts` con un **Postgres efímero in-process (PGlite +
  migraciones reales)** inyectado vía `_inyectarDbParaTests` (DATABASE_URL apunta a un host inválido que nunca
  se usa), 5 negocios sembrados que cubren cada estado (Pro con la demo, Básico al 85% de cuota, al 100%, tope
  de IA agotado, pausado), superadmin con **2FA TOTP activo**, llaves VAPID efímeras y **toda la red mockeada**
  (Graph, OAuth de Embedded Signup, OpenAI) con un servidor de control (`puertoControl`) para leer lo que "envió"
  el bot y forzar fallas de Graph. Los workers reales (cola, campañas, recordatorios) corren contra PGlite.
  Cubre: landing (links, anclas, FAQ, menú móvil, CSP), login/sesión/pausa, bandeja completa (filtros, búsqueda,
  modo, atendida, acciones rápidas, composer, ventana 24 h + reapertura, permiso de promos, ficha, borrado Ley
  8968, webhook firmado en vivo), agenda (día/semana, alta con validaciones, choques, cada acción del detalle,
  feriados, equipo con carriles/409/reasignación), **"Mi negocio" sección por sección** (+ validaciones, white-
  label aplicado, historial F15, gating Básico), usuarios (alta, roles, revocación de sesión, último dueño),
  campañas (preview, borrador, envío real por el worker, programar, cancelar), dashboard, cuotas/avisos, push,
  superadmin (2FA + anti-replay, plan, pausa, reset de clave → cambio obligatorio, WhatsApp, borrado, historial,
  alta manual y por **Embedded Signup con el SDK de Facebook simulado**, tope, DLQ, baja) y todas las vistas en
  390/1440 px × claro/oscuro. `npm run test:e2e` corre ambos proyectos (`--project=db` para uno solo).
  Bugs que encontró en su primera corrida (2026-10-03, corregidos): el alta de negocio descartaba el perfil
  (B7); "Mi negocio" borraba `mensajeTopeExcedido`; la CSP bloqueaba el script de la landing con CRLF; un typo
  en la clave temporal sacaba al login; "Agendá la primera" agendaba en hoy; se aceptaban horarios que cierran
  antes de abrir; la tabla del equipo del admin no se refrescaba tras un reset; tras el cambio obligatorio de
  clave el usuario caía al login (se revocaba también su propia sesión).

### 7. ✅ Guardrail de migraciones en CI (tu trampa conocida)

- Cambiar `src/db/schema.ts` **sin** migración drizzle rompe TODO el deploy en silencio
  (`seedTenants` aborta antes del `pm2 restart`).
- [x] **Detección de drift** (`npm run db:check` → `scripts/verificarMigraciones.ts`, corre en el job
  `verificar` antes del typecheck y **bloquea el deploy**): corre `drizzle-kit generate` (offline, usa los
  snapshots de `./drizzle/meta` — **no necesita base**) y falla si eso produce cambios en `./drizzle`, o sea si
  `schema.ts` tiene cambios sin migrar. Deja el árbol como lo encontró (revierte lo que `generate` haya tocado).
- [x] **Que las migraciones apliquen limpio** ya lo cubre la suite de **fiabilidad** (ángulo 5): PGlite aplica las
  migraciones reales de `./drizzle` en cada push. Por eso el guardrail acá se enfoca en el drift, que es el modo
  de fallo caro y silencioso; no hace falta un service container solo para esto.

### 8. ✅ Seguridad

Suite pura en `test/security/seguridad.test.ts` (17 casos, corre en CI vía `npm test`; el glob ya la incluye)
para los invariantes de crypto, más una aserción a nivel HTTP en el E2E del panel (ángulo 6) para el aislamiento
del token. Se apoya en el `PANEL_SESSION_SECRET` fijado antes de importar `auth.ts` (secreto determinista, no el
aleatorio-por-arranque del modo dev).

- [x] **Auth — sesión firmada (HMAC):** round-trip devuelve `tenantId/usuarioId/rol`; y se rechaza (→ `null`) todo
  intento de **forjar/manipular** el token: firma alterada, **escalar rol** operador→dueño sin re-firmar, **cambiar
  tenantId** (no cruza tenants), **extender el vencimiento**, token vencido (con firma legítima), y **versión** distinta
  (re-login global). Ídem para la sesión del **superadmin** (una sesión de operador NO cuela como admin).
- [x] **Auth — anti-timing en login:** `HASH_DUMMY` es un `salt:hash` válido (16 B : 64 B) → el path de "usuario
  inexistente" corre el **mismo scrypt** que el válido (no cortocircuita); `verificarPassword` usa `timingSafeEqual`
  y rechaza hash ausente/mal formado sin lanzar; cada `hashearPassword` usa un salt distinto.
- [x] **Token de WhatsApp nunca vuelve al navegador (C4.2):** en `test/e2e-panel/api.spec.ts`, `GET admin/tenants`,
  `GET me` y `GET config` **no** exponen `accessToken` (ni la clave ni el valor sembrado). Regresión cara: filtrar el
  token deja enviar mensajes en nombre del negocio.
- [x] **CSRF + validación server-side + guards de rol:** cubiertos a nivel HTTP en el ángulo 6 (POST con `Origin`
  ajeno → 403; operador → 403 en `usuarios`/`config`; el front no se confía — se le pega directo a la API).
- [x] **Firma del webhook de Meta (`WHATSAPP_APP_SECRET`):** `firmaValida` acepta la legítima y rechaza al impostor
  (firmado con otro secreto), la ausente/vacía y la mal formada — comparación en **tiempo constante**.
- [ ] `/security-review` sobre el diff antes de cada merge grande **es un paso de proceso** (no un test automatizable);
  el slash-command `/security-review` queda como checklist previo a merges grandes.

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

## Estructura propuesta de archivos

```
test/
  unit/            # node:test — availability, planes, segmentos, validadores, metricas, botones
  tenant/          # aislamiento multi-tenant
  e2e-webhook/     # responderEntrante con el repo real sobre PGlite + fetch mockeado
  reliability/     # cola, recordatorios, campañas (concurrencia)
  security/        # sesión firmada, anti-timing, firma del webhook (ángulo 8)
  e2e-panel/       # Playwright: servidor.ts (server E2E), *.spec.ts, constantes.ts
  helpers/         # fabricadores de tenant/cita/conversación, mock de Graph/OpenAI
eval/              # evals del agente contra OpenAI real (ángulo 4, NO en CI)
  runEval.ts       #   main; assertions.ts, report.ts (lógica pura), world.ts (negocio de cada caso)
  transcripts/     #   35 casos .json; results/ (gitignored) y baseline.json
playwright.config.ts  # webServer = test/e2e-panel/servidor.ts, workers:1
scripts/
  verificarMigraciones.ts  # guardrail de drift (ángulo 7)
```

`package.json`:
```jsonc
"scripts": {
  "test": "tsx --test test/unit/*.test.ts test/tenant/*.test.ts test/e2e-webhook/*.test.ts test/reliability/*.test.ts test/security/*.test.ts",
  "test:e2e": "npm run web:build && playwright test",  // panel (build + Playwright)
  "eval": "tsx eval/runEval.ts",                       // agente vs. OpenAI real (ángulo 4, NO en CI)
  "db:check": "tsx scripts/verificarMigraciones.ts"    // drift de schema (ángulo 7)
}
```

CI (`.github/workflows/ci-cd.yml`): `npm test` y `npm run db:check` corren en el job `verificar`
(antes del typecheck); el E2E del panel es el job separado `e2e-panel` (build + `npx playwright install`
+ `npx playwright test`). Ambos jobs **bloquean el deploy** (`desplegar.needs: [verificar, e2e-panel]`).

---

## Principios

1. **Determinista en cada push, no determinista aparte.** Nada que cueste tokens o toque red real corre en el hot path de CI.
2. **Sin tocar producción.** Todo lo automatizado usa Postgres efímero (PGlite); jamás el `.env` real ni el droplet.
   La plantilla de PGlite (migraciones ya aplicadas) se arma una vez y se cachea en el tmp del sistema
   (`test/helpers/pgliteDb.ts`): cada base nueva cuesta ~1 s en vez de 5-13 s.
3. **El sanity script de hoy es el test de mañana.** No botar verificaciones: al terminar una feature, dejar su prueba en `test/`.
4. **Aislamiento por tenant = seguridad, no calidad.** Se prueba siempre, no es opcional.
5. **Cubrir el modo de fallo caro.** Migración silenciosa y fuga entre tenants antes que cobertura cosmética.
