> ✅ **Archivado — plan ejecutado.** B1 y B4 están ✅ en `ROADMAP.md` (Carril B). Este documento
> queda como bitácora histórica de cómo se implementaron; el estado vigente vive en `ROADMAP.md`.

# Plan de implementación — B1 (cola durable) y B4 (recordatorios safe para N instancias)

> **Para quién es esto:** guía de ejecución paso a paso para implementar los dos bloqueantes 🔴 del
> ROADMAP. Escrito para ejecutarse con precisión (podés seguirlo casi al pie de la letra). Los dos son
> independientes: se pueden hacer en cualquier orden o en commits separados. **Ninguno necesita paquetes
> npm nuevos** (todo con `sql\`\`` de postgres.js / drizzle) → no aplica la política de deps.
>
> **Regla de oro de este repo:** la única base Postgres real es **producción** (Supabase). NO correr
> `migrar.ts`/seeds contra ella desde local. Toda prueba local va con `DATABASE_URL=` vacío (repo en
> memoria). La verificación contra Postgres ocurre en el deploy.

---

## Contexto verificado del código (para no perder tiempo)

### Flujo actual de un mensaje entrante (relevante a B1)
- **`src/server.ts:61–100`** — handler POST del webhook. Dos fases:
  - **Fase 1 (síncrona, ANTES del 200):** `pendiente = await ingerirEntrante(body, repo)` — valida firma,
    parsea, busca tenant, guarda el mensaje (dedup por `wa_message_id`). Si falla → **500** y Meta reintenta.
  - **Fase 2 (fire-and-forget, DESPUÉS del 200):** `server.ts:98`
    → `responderEntrante(pendiente, repo).catch(...)` **NO se hace `await`**.
- **El hueco (lo que B1 cierra):** si el proceso muere/reinicia mientras corre `responderEntrante`
  (que hace la llamada al LLM, segundos), el mensaje ya está en la base pero **la respuesta nunca se
  genera** — la Promise se pierde. Los reintentos de envío a WhatsApp (`src/whatsapp/client.ts`, 3
  intentos con backoff 500ms→1.5s→5s) son **solo en memoria**: tampoco sobreviven a la muerte del proceso.
- **Dedup de entrantes** ya resuelto: índice único `wa_msg_waid_uq` en `wa_mensajes.wa_message_id`;
  `guardarMensaje` devuelve `false` si es duplicado (`src/booking/drizzleRepository.ts:70–86`,
  `src/booking/inMemoryRepository.ts:80–97`).
- **`responderEntrante`** vive en **`src/handleWebhook.ts:89–235`**. Su firma:
  `responderEntrante(p: Pendiente, repo: Repositorio): Promise<void>`. Usa de `p`:
  `clase`, `tenant`, `entrante`, `conv`, `primerContacto`, `historialPrevio`.

### Scheduler de recordatorios (relevante a B4)
- **`src/reminders/scheduler.ts`** — `iniciarRecordatorios(repo)` (líneas 142–157) arranca un
  `setInterval` (línea 153) cada `RECORDATORIOS_INTERVALO_MIN` (default **5 min**). Se llama en
  **`src/server.ts:128`**.
- Cada tick recorre tenants → `procesarTenant` (99–136) → `repo.citasPorFecha(...)` → decide qué citas
  tocan recordatorio (día-antes desde las 17:00; mismo-día N horas antes, nunca antes de las 6:00) →
  `enviarRecordatorio(...)` → `repo.marcarRecordatorio(citaId, tipo)`.
- **Idempotencia actual (solo dentro de UNA instancia):** columnas
  `wa_citas.recordatorio_dia_antes_en` y `recordatorio_mismo_dia_en` (timestamptz, NULL = pendiente).
  Se leen (skip si ya tienen valor) y se escriben con `marcarRecordatorio`
  (`src/booking/drizzleRepository.ts:152–158`).
- **El hueco (lo que B4 cierra):** con 2+ instancias, ambas leen la misma cita con la columna en NULL,
  ambas envían, recién después marcan → **recordatorio duplicado**. Hay una carrera read→write.
- **No se usan advisory locks en ningún lado hoy.**

### Capa de base de datos (para ambos)
- Cliente: **`src/db/client.ts`** — `crearDb()`. Supabase se detecta por URL y usa
  `postgres(url, { ssl: "require", prepare: false })`. **`prepare: false` es obligatorio por el pooler.**
- Esquema: **`src/db/schema.ts`** con `pgTable`. Helper `id()` = UUID PK vía `randomUUID()`. Timestamps
  `timestamp(name, { withTimezone: true })`. JSONB: `jsonb(name).$type<...>()`. Índices `index(...)` /
  `uniqueIndex(...)`.
- Migraciones: editar `schema.ts` → **`npx drizzle-kit generate`** (crea `drizzle/000N_*.sql`) →
  **`npx tsx scripts/migrar.ts`** aplica (usa `migrate()` de drizzle). En prod ya corre en el DEPLOY.
- Transacciones: `db.transaction(async (tx) => { ... })` (ver `tenantStore.crearTenant`, líneas 178–197).
- Repos: interfaz **`Repositorio`** con dos impls — `RepositorioDrizzle` (con DB) y `RepositorioEnMemoria`
  (sin DB). `src/server.ts:~20`: `const repo = process.env.DATABASE_URL ? new RepositorioDrizzle(crearDb()) : new RepositorioEnMemoria()`.

> ⚠️ **Gotcha crítico del pooler (afecta la decisión de B4):** con el pooler de Supabase en modo
> *transaction* (`prepare:false`), los **advisory locks a nivel sesión** (`pg_advisory_lock`) son poco
> confiables: cada statement puede caer en un backend distinto, así que el lock tomado en un query puede
> quedar en una conexión que vuelve al pool. Solo son confiables los **`pg_advisory_xact_lock`** DENTRO de
> una transacción (postgres.js fija una conexión por transacción). Por eso B4 usa **claim atómico por
> recordatorio** (abajo), que es pooler-safe y no necesita locks.

---

# B1 — Cola durable en Postgres (`wa_jobs`)

**Objetivo (Done del ROADMAP):** *un mensaje entrante sobrevive a un restart del proceso.* Es decir: el
mensaje se encola de forma durable ANTES de responder 200; un worker lo toma, corre el LLM y responde; si
el proceso muere a mitad, otro arranque (u otra instancia) retoma el job.

**Beneficio extra:** con `FOR UPDATE SKIP LOCKED`, N instancias comparten la cola sin doble-procesar → el
procesamiento de mensajes ya queda listo para varias instancias (a diferencia de los recordatorios, que
necesitan B4).

## Decisiones de diseño (cerradas)
1. **Semántica at-least-once.** Un job se marca `hecho` DESPUÉS de responder. Si el proceso muere justo
   después de enviar el WhatsApp pero antes de marcar `hecho`, el job se re-ejecuta → posible **respuesta
   duplicada al cliente** (raro, solo en crash en esa ventana). Es un trade-off aceptado para el piloto.
   *No* intentamos exactly-once. (Dejar comentado en el código; se puede endurecer luego dedup-eando la
   salida.)
2. **Claim en transacción corta, trabajo fuera de la transacción.** No sostener una transacción abierta
   durante la llamada al LLM (segundos). Patrón: (a) tx corta que reclama y marca `procesando`; (b) correr
   `responderEntrante` fuera de tx; (c) tx corta que marca `hecho`/`error`.
3. **Reaper (rescate de zombies).** Un job en `procesando` cuyo `locked_at` es más viejo que un umbral
   (p.ej. 3 min) se reencola (esto cubre el crash a mitad de trabajo). El reaper es solo un `UPDATE`
   periódico.
4. **Orden por conversación:** el volumen del piloto es bajo. Empezar con **worker serial** (procesa 1 job
   a la vez por instancia) para preservar el orden natural y simplificar. Escalar a concurrencia con
   sharding por conversación queda para B5/más adelante (dejar `LIMIT 1` documentado como decisión).
5. **Solo con DB.** Sin `DATABASE_URL` (repo en memoria, dev local) se mantiene el camino actual
   fire-and-forget inline. La cola es una feature del `RepositorioDrizzle`/DB.
6. **Atomicidad mensaje+job:** guardar el mensaje entrante y encolar el job en **una sola transacción**, de
   modo que "mensaje persistido ⇒ job encolado" sea invariante (evita el caso "mensaje guardado pero job
   perdido" ante un 500/retry de Meta).

## Cambios

### 1. Esquema — nueva tabla `wa_jobs` (`src/db/schema.ts`)
Agregar (seguir el estilo del archivo; exportarla en el objeto `schema` del final):

```ts
export const waJobs = pgTable(
  "wa_jobs",
  {
    id: id(), // UUID
    tenantId: text("tenant_id").notNull(),
    tipo: text("tipo").notNull().default("responder_entrante"), // deja lugar a otros tipos luego
    estado: text("estado").notNull().default("pendiente"), // pendiente | procesando | hecho | error
    intentos: integer("intentos").notNull().default(0),
    maxIntentos: integer("max_intentos").notNull().default(5),
    ejecutarDespuesDe: timestamp("ejecutar_despues_de", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
    finalizadoEn: timestamp("finalizado_en", { withTimezone: true }),
    // payload: todo lo necesario para reconstruir `Pendiente` sin `tenant` (se relee del store).
    payload: jsonb("payload").$type<PendienteSerializado>().notNull(),
    ultimoError: text("ultimo_error"),
    // idempotencia del encolado: 1 job por mensaje entrante. NULL permitido (varios NULL no chocan).
    waMessageId: text("wa_message_id"),
  },
  (t) => ({
    // El índice que usa el claim: pendientes listos para correr, más viejos primero.
    idxClaim: index("wa_jobs_claim_idx").on(t.estado, t.ejecutarDespuesDe),
    uqWaId: uniqueIndex("wa_jobs_waid_uq").on(t.waMessageId),
  }),
);
```
Definir el tipo `PendienteSerializado` (en `schema.ts` o mejor en `src/types.ts`): es `Pendiente` sin el
campo `tenant`, pero con `tenantId: string`. Es decir `{ clase, tenantId, entrante, conv, primerContacto?, historialPrevio? }`.

Luego: `npx drizzle-kit generate` → aparece `drizzle/000N_*.sql` (commitearlo). NO aplicar local.

### 2. Módulo de cola — `src/queue/cola.ts` (NUEVO)
Recibe el `db` de drizzle (igual que `RepositorioDrizzle`). Exporta funciones con `sql\`\`` crudo donde
convenga (el claim necesita `FOR UPDATE SKIP LOCKED`, que drizzle no expresa nativamente):

- `async encolar(tx, job: { tenantId, waMessageId, payload })` — `INSERT ... ON CONFLICT (wa_message_id)
  DO NOTHING`. Acepta un `tx` para poder correr dentro de la transacción del guardado del mensaje.
- `async reclamarUno(): Promise<JobRow | null>` — en una transacción:
  ```sql
  SELECT * FROM wa_jobs
   WHERE estado = 'pendiente' AND ejecutar_despues_de <= now()
   ORDER BY ejecutar_despues_de ASC
   FOR UPDATE SKIP LOCKED
   LIMIT 1;
  -- si hay fila:
  UPDATE wa_jobs SET estado='procesando', locked_at=now(), intentos=intentos+1
   WHERE id = $id;
  ```
  Devolver la fila (con `intentos` ya incrementado). Todo dentro de `db.transaction`.
- `async marcarHecho(id)` — `UPDATE ... SET estado='hecho', finalizado_en=now(), locked_at=NULL`.
- `async marcarFalloOReintentar(id, error, intentos, maxIntentos)`:
  - Si `intentos >= maxIntentos` → `estado='error', ultimo_error=$e, finalizado_en=now()`.
  - Si no → `estado='pendiente', ultimo_error=$e, locked_at=NULL, ejecutar_despues_de = now() + backoff`
    (backoff exponencial, p.ej. `LEAST(2^intentos, 60)` segundos: `now() + interval '1 second' * ...`).
- `async reencolarVencidos(umbralSegundos = 180)` (reaper) —
  `UPDATE wa_jobs SET estado='pendiente', locked_at=NULL WHERE estado='procesando' AND locked_at < now() - interval '1 second' * $umbral`.
  Devolver la cantidad reencolada (para loguear).

### 3. Worker — `src/queue/worker.ts` (NUEVO)
- `iniciarWorker(repo: Repositorio, db)` — arranca dos loops:
  - **Loop de trabajo:** en bucle, `const job = await reclamarUno()`. Si `null`, `await dormir(POLL_MS)`
    (p.ej. 1000ms) y seguir. Si hay job:
    1. Reconstruir `Pendiente`: `tenant = obtenerTenantPorId(job.payload.tenantId)` (del `tenantStore`;
       si el tenant no existe → marcar `error` con motivo claro y seguir). Armar
       `const pendiente = { ...job.payload, tenant }`.
    2. `try { await responderEntrante(pendiente, repo); await marcarHecho(job.id); }`
       `catch (e) { await marcarFalloOReintentar(job.id, String(e), job.intentos, job.maxIntentos); }`.
  - **Loop reaper:** cada ~60s, `await reencolarVencidos()` (loguear si reencoló algo).
- Usar un flag para poder parar en tests, y `POLL_MS`/umbral por env con defaults.
- **Serial:** un job a la vez (no lanzar varios `reclamarUno` en paralelo en esta primera versión).

### 4. Encolar en Fase 1 — `src/handleWebhook.ts` (`ingerirEntrante`)
Hoy `ingerirEntrante` guarda el mensaje y devuelve `Pendiente`. Cambiar para que, **cuando hay DB**,
además encole el job **en la misma transacción** que el `guardarMensaje`, y que el server ya NO corra
`responderEntrante` inline.

Enfoque recomendado (mínimo acoplamiento): agregar al `RepositorioDrizzle` un método
`guardarEntranteYEncolar(conv, msg, jobPayload): Promise<boolean>` que abre `db.transaction`, hace el
`insert` del mensaje con `onConflictDoNothing().returning()` y, si insertó (no era duplicado), hace el
`INSERT` en `wa_jobs` (vía `cola.encolar(tx, ...)`); devuelve si encoló. En `RepositorioEnMemoria`, este
método simplemente guarda el mensaje (como hoy) y devuelve `true` **sin encolar** (no hay cola en memoria).

- `ingerirEntrante`: donde hoy llama `guardarMensaje`, si `hayBaseDeDatos()` usar el método nuevo con el
  `jobPayload` (= `Pendiente` serializado: `clase, tenantId, entrante, conv, primerContacto,
  historialPrevio`). Seguir devolviendo `Pendiente | null` como hoy (para compatibilidad del path en
  memoria y del `no-texto`).

### 5. `src/server.ts`
- Arriba, si hay DB, iniciar el worker: `if (process.env.DATABASE_URL) iniciarWorker(repo, db)` (necesitás
  el `db`; hoy `crearDb()` se llama inline al armar el repo — exponer el `db` o crearlo una vez y pasarlo a
  ambos).
- **Fase 2 (línea 98):** cambiar la lógica:
  - **Con DB:** NO llamar `responderEntrante` (el worker lo hace). El `pendiente` ya quedó encolado por
    Fase 1. Solo responder 200. (Cuidado con el `clase:"no-texto"`: hoy también pasa por
    `responderEntrante`; encolarlo igual, o manejar el aviso multimedia inline antes del 200 — decidir:
    lo más simple es encolar también los `no-texto` y que el worker los procese igual.)
  - **Sin DB:** mantener el actual `responderEntrante(pendiente, repo).catch(...)` inline (comportamiento
    de hoy para dev local).

### 6. Notas para el operador ante `estado='error'`
Cuando un job agota reintentos (`error`), conviene avisar al operador (ya existe `notificarOperador` en
`handleWebhook.ts`). Opcional pero recomendado: en `marcarFalloOReintentar`, cuando pasa a `error`, disparar
una notificación "el bot no pudo procesar un mensaje de <cliente>, atendelo a mano". (Reusar el patrón del
`catch` actual de `responderEntrante`.)

## Verificación B1
- **Local sin DB:** `npm run typecheck`. Con `DATABASE_URL=` vacío + `npm run dev`: el bot responde igual
  que hoy (path inline, sin worker). Confirmar que arranca sin intentar tocar `wa_jobs`.
- **Local typecheck del esquema:** que `waJobs` y `PendienteSerializado` tipen bien; `npx drizzle-kit
  generate` produce un solo `.sql` nuevo, sin diffs raros en tablas existentes.
- **Deploy (Supabase):** tras `migrar.ts` existe `wa_jobs`. Mandar un WhatsApp real →
  en la base, ver la fila en `wa_jobs` pasar `pendiente→procesando→hecho`; el cliente recibe respuesta.
- **Prueba de crash (la que valida el Done):** en el droplet, mandar un mensaje y, **mientras el LLM
  piensa**, `pm2 restart whatsapp-bot`. Al reiniciar, el worker debe reclamar el job (reaper si quedó en
  `procesando`) y **la respuesta igual se envía**. Confirmar que el cliente recibe respuesta pese al restart.
- **Reintento:** forzar un error (p.ej. token WhatsApp inválido momentáneo) y ver `intentos` subir y
  `ejecutar_despues_de` posponerse con backoff; al recuperar, se completa.

## Riesgos B1
- **Duplicado de salida** en crash post-envío/pre-`hecho` (at-least-once): aceptado; documentar.
- **Atomicidad mensaje+job:** si no van en la misma transacción, un 500 tras guardar el mensaje deja al
  mensaje como "duplicado" en el retry de Meta y el job nunca se crea. Por eso el método transaccional
  del punto 4 es **obligatorio**, no opcional.
- **`prepare:false` + transacciones:** ya está configurado en `crearDb()`; las transacciones de postgres.js
  fijan una conexión, así que `FOR UPDATE SKIP LOCKED` funciona bien con el pooler.
- **Migración segura:** tabla nueva, aditiva; no toca datos existentes. `migrar.ts` es idempotente.

---

# B4 — Recordatorios safe para N instancias (claim atómico)

**Objetivo (Done del ROADMAP):** *correr 2 instancias no duplica recordatorios.*

## Decisión de diseño (cerrada) y por qué
- **Claim atómico por recordatorio (compare-and-swap), NO advisory lock de sesión.** Motivo: el pooler de
  Supabase hace poco confiables los `pg_advisory_lock` de sesión (ver gotcha arriba). El claim atómico es
  pooler-safe, fino (por cita, no por tick) y de paso arregla la carrera read→write.
- **Preservar el reintento ante fallo de envío** (semántica actual, mejor que at-most-once): se hace un
  claim de dos fases — reclamar (marca ganada), enviar, y si el envío falla, **revertir** la marca para que
  el próximo tick lo reintente.

> Alternativa considerada y descartada: `pg_advisory_xact_lock` envolviendo todo el tick en una transacción.
> Descartada porque mantendría una transacción/conexión abierta durante los envíos de WhatsApp (segundos),
> con riesgo de timeout del pooler y de serializar innecesariamente. El claim atómico no tiene ese problema.

## Cambios

### 1. Repo: reemplazar "leer-y-marcar" por "reclamar/revertir" atómico
En la interfaz `Repositorio` (y sus dos impls), agregar:
- `reclamarRecordatorio(citaId: string, tipo: TipoRecordatorio): Promise<boolean>`
- `revertirRecordatorio(citaId: string, tipo: TipoRecordatorio): Promise<void>`

**`RepositorioDrizzle`** (`src/booking/drizzleRepository.ts`, junto a `marcarRecordatorio:152–158`):
```ts
async reclamarRecordatorio(citaId, tipo) {
  const col = tipo === "dia_antes" ? waCitas.recordatorioDiaAntesEn : waCitas.recordatorioMismoDiaEn;
  // UPDATE ... SET col = now() WHERE id = $id AND col IS NULL RETURNING id
  const filas = await this.db.update(waCitas)
    .set(tipo === "dia_antes" ? { recordatorioDiaAntesEn: new Date() } : { recordatorioMismoDiaEn: new Date() })
    .where(and(eq(waCitas.id, citaId), isNull(col)))
    .returning({ id: waCitas.id });
  return filas.length > 0; // true = ESTA instancia ganó el claim
}
async revertirRecordatorio(citaId, tipo) {
  await this.db.update(waCitas)
    .set(tipo === "dia_antes" ? { recordatorioDiaAntesEn: null } : { recordatorioMismoDiaEn: null })
    .where(eq(waCitas.id, citaId));
}
```
(`isNull` se importa de `drizzle-orm`.) El `UPDATE ... WHERE col IS NULL RETURNING` es atómico: solo una
instancia puede pasar de NULL a timestamp; las demás obtienen 0 filas.

**`RepositorioEnMemoria`** (`src/booking/inMemoryRepository.ts`): equivalente en memoria — si el campo está
seteado devolver `false`, si no setearlo y devolver `true`; `revertir` lo pone en `undefined`. (Una sola
instancia en memoria, así que basta replicar la semántica.) Se puede dejar de usar `marcarRecordatorio` o
mantenerlo para compatibilidad; el scheduler ya no lo llamará.

### 2. Scheduler — `src/reminders/scheduler.ts` (`procesarTenant`, 99–136)
Reemplazar, para cada cita que toca (día-antes y mismo-día), el patrón actual
"`if (cita.recordatorioXEn) skip` … enviar … `marcarRecordatorio`" por:
```ts
// La comprobación de ventana horaria (17:00 / N horas antes / no antes de 6:00) queda IGUAL.
if (!(await repo.reclamarRecordatorio(cita.id, tipo))) continue; // otra instancia ya lo tomó
try {
  await enviarRecordatorio(tenant, cita, tipo);
} catch (e) {
  await repo.revertirRecordatorio(cita.id, tipo); // liberar para reintentar en el próximo tick
  console.error("[recordatorios] envío falló, se reintentará:", e);
}
```
- Mantener la lectura previa `cita.recordatorioXEn` como filtro barato (evita intentar claim de las ya
  enviadas) **pero el claim es la fuente de verdad** — no confiar solo en la lectura.
- El `setInterval` (línea 153) se **mantiene**: cada instancia sigue ticando, pero el claim atómico dedupe.
  (No hace falta advisory lock ni leader election para cumplir el Done.)

### 3. Sin cambios de esquema ni migración
B4 reutiliza las columnas existentes `recordatorio_dia_antes_en` / `recordatorio_mismo_dia_en`.
**No hay `drizzle-kit generate` ni migración.**

## Verificación B4
- **Local (memoria):** `npm run typecheck`. Con citas de demo, un solo proceso: los recordatorios se
  mandan una sola vez (comportamiento igual al de hoy).
- **Deploy (la prueba del Done):** correr **2 instancias** apuntando a la misma base (p.ej. levantar un
  segundo proceso PM2 temporal con otro `PORT`, o dos `pm2 start` de la misma app). Con una cita cuyo
  recordatorio toca ya, confirmar que **el cliente recibe UN solo mensaje** y que en la base la columna se
  seteó una vez. Revisar logs: una instancia loguea el envío, la otra hace `continue` (claim perdido).
- **Reintento ante fallo:** simular fallo de envío (token inválido) → la columna se revierte a NULL → el
  próximo tick reintenta. Confirmar que no queda "marcado pero no enviado".

## Riesgos B4
- **Ventana envío→marca invertida a marca→envío:** ahora marcamos antes de enviar y revertimos si falla.
  Si el proceso **muere entre el claim y el envío** (sin alcanzar el `revertir`), ese recordatorio queda
  marcado como enviado y **no se manda** (at-most-once en ese crash puntual). Es el trade-off inverso al de
  hoy y se considera aceptable (mejor perder un recordatorio raro que spamear). Si se quisiera at-least-once
  estricto, ese caso lo cubriría enrutar los recordatorios por la cola de B1 (queda para más adelante).
- **Pooler:** el claim es un `UPDATE` atómico de una fila, 100% compatible con el pooler y `prepare:false`.

---

## Checklist de cierre (para ambos)

- [ ] **B1:** `wa_jobs` en `schema.ts` + `drizzle-kit generate` (commitear el `.sql`); `src/queue/cola.ts`
      y `src/queue/worker.ts`; método transaccional `guardarEntranteYEncolar` en el repo Drizzle;
      `ingerirEntrante` encola; `server.ts` inicia worker y NO corre inline con DB; typecheck OK.
- [ ] **B4:** `reclamarRecordatorio`/`revertirRecordatorio` en ambos repos + interfaz; scheduler usa claim
      atómico; typecheck OK. **Sin migración.**
- [ ] **ROADMAP.md:** marcar **B1** y **B4** como ✅ en el MISMO commit que hace el trabajo, actualizar la
      fecha de "Última actualización". (Regla del repo: el ROADMAP se mantiene vivo en cada commit.)
- [ ] **DEPLOY.md:** para B1, recordar que `migrar.ts` (ya en el flujo de deploy) crea `wa_jobs`; no hay
      pasos manuales nuevos. Para B4, nada nuevo en deploy (mismo esquema). Documentar la prueba de las 2
      instancias si se quiere dejar registrada.
- [ ] **Prueba de crash (B1)** y **prueba de 2 instancias (B4)** hechas contra el deploy sembrado, no local.

## Orden sugerido
1. **B4 primero** (más chico, sin migración, sin worker) → gana robustez rápido y es bajo riesgo.
2. **B1 después** (más grande: tabla nueva, cola, worker, reconexión de la Fase 2).

Se pueden hacer en commits separados; cada uno cierra su ítem del ROADMAP por su cuenta.
