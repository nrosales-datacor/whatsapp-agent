# TESTING.md — Estrategia de pruebas del agente de WhatsApp

> **Objetivo:** probar la app desde todos los ángulos para asegurar funcionamiento **correcto** (no rompe),
> **fiable** (no duplica, no pierde mensajes, aislado por tenant) y **de valor** (el bot cotiza/agenda/escala bien).
>
> **Este doc es un plan, no un estado.** A medida que se implemente cada ángulo, marcar su casilla y anotar
> el comando/archivo real. Mantener vivo igual que `ROADMAP.md`.
>
> **Última actualización:** 2026-07-14 (ángulos 1–5, 7, 8 y 9 completos; ángulo 6 implementado por la
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

**Fuera de alcance de este repo:** `usuarios` / `config` / `campañas` viven en auth y stores propios (no en
`RepositorioEnMemoria`); su aislamiento se cubre en el panel E2E (ángulo 6, guards de rol 403).
- **Una fuga acá es un incidente, no un bug cosmético.** Bloque propio, sin excepciones.

### 3. ✅ End-to-end del webhook (in-process, sin red)

Suite en `test/e2e-webhook/webhook.test.ts` (15 casos, corre en CI vía `npm test`). Repo en memoria + `global.fetch`
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

### 4. ✅ Evals del agente (LLM — no determinista, corre aparte)

Harness en `eval/correrEval.ts` (`npm run eval`), tenant de fixture con KB completa en `eval/fixtureEval.ts`,
11 transcripciones fijas en `eval/transcripciones/*.json`. Corre `correrAgente` contra **OpenAI real** (necesita
`OPENAI_API_KEY`; sin ella aborta con código 2) sobre un repo en memoria — **nunca toca producción**. Observa qué
herramienta eligió el agente espiando `globalThis.fetch` (lee los `tool_calls` de la respuesta sobre un clon, sin
tocar el flujo real).

- Aserciones **laxas** (vocabulario en `Espera`): `herramienta`/`herramientaAlguna`/`herramientaNo`/`sinHerramienta`,
  `escala`, `fueraDeAlcance`, `interactivo`, `contiene`/`contieneAlguno`/`noContiene`, y `fechaAnioActual`
  (verifica que no inventó el año en los args de fecha).
- Casos cubren: cotiza lavado y **pulido con el precio fijo del prompt**, lavado **no se agenda** (orden de llegada),
  **fuera de alcance** (no escala), **escala** ante pregunta de negocio desconocida, **carrocería** se revisa en persona,
  **repelente ≠ pulido**, pulido ambiguo pregunta cuál, **ofrece horarios** como lista, **no inventa disponibilidad**,
  y **consultar_mi_cita** con cita sembrada. Los 11 pasan en verde contra `gpt-4o-mini`.
- **No en cada push** (cuesta tokens): manual o job nocturno. `EVAL_REPETICIONES=N` mide la tasa ante no determinismo
  (marca ⚠️ inestable si pasa en unas y falla en otras); `EVAL_CASO=<substr>` filtra un caso al iterar. Exit ≠ 0 si algún
  caso no fue verde en todas sus repeticiones.
- Es el ángulo de **calidad/valor** que ningún unit test cubre.

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
webServer levanta el **mismo `src/server.ts`** en modo seguro (`test/e2e-panel/servidor.ts`): repo **en
memoria** (sin `DATABASE_URL` → jamás toca producción; se neutraliza el `.env` real vía `DOTENV_CONFIG_PATH`),
`SEED_DEMO=1`, y **Graph API mockeado in-process** (reusa el helper del ángulo 3) para que `responder` envíe
sin red. `workers:1` porque todas las specs comparten el repo en memoria del proceso.

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
- [ ] **Requiere base de datos real → cubrir en la corrida con Postgres** (ángulo 7 / job futuro con service
  container): alta de negocio **409 por duplicado**, CRUD de **usuarios/config/campañas** (en memoria dan 503),
  y **white-label** aplicado/limpiado (necesita un tenant con colores guardados). El **403** del operador y la
  separación admin/operador SÍ se prueban acá (son de rol, no de DB).

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

### 9. ✅ Smoke test post-deploy

En `.github/workflows/ci-cd.yml`, paso **"Smoke post-deploy"** del job `desplegar` (corre tras el `/salud` contra
la URL pública de producción). Solo golpea superficies que **no tocan datos ni requieren credenciales reales**, así que
es seguro contra producción:

- [x] **El bundle React sirve** (`/panel` → 200 y contiene `<div id="root">`) — atrapa la regresión de "falta el
  build → 503" que dejaría el panel inservible.
- [x] **La API del panel está viva y exige auth** (`/api/panel/me` sin cookie → **401**, no 500/404).
- [x] **Login vivo + tenantStore/DB sanos** (`/api/panel/login` con `Origin` del host y credenciales falsas → **401**;
  un 500/503 delataría que la base o el store se rompieron). Es el **proxy seguro** de "un login real funciona" sin
  meter credenciales de demo en producción.
- Si cualquiera falla, el paso sale con código ≠ 0 y marca el deploy en rojo.

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
  e2e-webhook/     # responderEntrante con repo en memoria + fetch mockeado
  reliability/     # cola, recordatorios, campañas (concurrencia)
  security/        # sesión firmada, anti-timing, firma del webhook (ángulo 8)
  e2e-panel/       # Playwright: servidor.ts (server E2E), *.spec.ts, constantes.ts
  helpers/         # fabricadores de tenant/cita/conversación, mock de Graph/OpenAI
eval/
  transcripciones/ # casos fijos del agente
  correrEval.ts
playwright.config.ts  # webServer = test/e2e-panel/servidor.ts, workers:1
scripts/
  verificarMigraciones.ts  # guardrail de drift (ángulo 7)
```

`package.json`:
```jsonc
"scripts": {
  "test": "tsx --test test/unit/*.test.ts test/tenant/*.test.ts test/e2e-webhook/*.test.ts test/reliability/*.test.ts test/security/*.test.ts",
  "test:e2e": "npm run web:build && playwright test",  // panel (build + Playwright)
  "db:check": "tsx scripts/verificarMigraciones.ts",   // drift de schema (ángulo 7)
  "eval": "tsx eval/correrEval.ts"                      // LLM, manual/nocturno
}
```

CI (`.github/workflows/ci-cd.yml`): `npm test` y `npm run db:check` corren en el job `verificar`
(antes del typecheck); el E2E del panel es el job separado `e2e-panel` (build + `npx playwright install`
+ `npx playwright test`). Ambos jobs **bloquean el deploy** (`desplegar.needs: [verificar, e2e-panel]`).
`eval` NO en el push (tokens).

---

## Principios

1. **Determinista en cada push, no determinista aparte.** Nada que cueste tokens o toque red real corre en el hot path de CI.
2. **Sin tocar producción.** Todo lo automatizado usa repo en memoria o Postgres efímera; jamás el `.env` real ni el droplet.
3. **El sanity script de hoy es el test de mañana.** No botar verificaciones: al terminar una feature, dejar su prueba en `test/`.
4. **Aislamiento por tenant = seguridad, no calidad.** Se prueba siempre, no es opcional.
5. **Cubrir el modo de fallo caro.** Migración silenciosa y fuga entre tenants antes que cobertura cosmética.
