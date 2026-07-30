# AUDIT — Sale readiness del agente de WhatsApp

**Fecha:** 2026-07-27 · **Commit auditado:** `07df20d` · **Alcance:** solo lectura, sin cambios al código.

> 📌 **Este documento es una FOTO del 2026-07-27; no se actualiza a medida que se arregla.**
> El estado vivo de cada hallazgo está en **`ROADMAP.md` → "Carril E — Hardening multi-cliente"**,
> que es la fuente de verdad (ver `CLAUDE.md`). Acá quedan la traza, el archivo y la línea de cada
> problema, que es lo que sirve al arreglarlo.
>
> **Ya arreglados (2026-07-30):** BLOQ-03 (timeouts) → E1 · ALTO-08 (`seedTenants` pisaba la config
> del cliente) → E2 · BLOQ-09 + BLOQ-08 (horarios pasados y agendar en el pasado) → E3 ·
> BLOQ-05 (Google Calendar compartido entre tenants) → E4. Los 9 bloqueantes restantes del bloque A
> están abiertos como E5–E14.

**Contexto de la auditoría:** producto SaaS multi-tenant para vender a PYMEs de servicios en Costa Rica. Cada
cliente con su número, su contexto y sus datos. El criterio de severidad NO es elegancia técnica, es
**riesgo para vos como vendedor**: qué te hace perder un cliente que paga, qué te obliga a soporte manual con
acceso a la base, y qué te expone legalmente.

**Estado general:** la base de ingeniería es sólida y muy por encima de lo típico en un proyecto de este tamaño
(cola durable con claim atómico, dedup por `wa_message_id`, 162 tests que pasan, typecheck limpio, CI/CD con
smoke post-deploy, aislamiento por `tenant_id` aplicado con disciplina y probado en `test/tenant/aislamiento.test.ts`).
El problema no es la calidad del código: es que **varias piezas siguen siendo de un solo inquilino**. Con un
cliente funciona bien. Con dos, tres cosas se rompen de forma visible y una de ellas filtra datos entre clientes.

---

## Verificaciones ejecutadas

| Comando | Resultado |
|---|---|
| `npm run typecheck` | ✅ limpio |
| `npm test` | ✅ 162/162 |
| `git log --all -- .env` | ✅ nunca commiteado |
| Búsqueda de secretos en el árbol | ✅ solo placeholders en `DEPLOY.md` |
| Búsqueda de `POLICY` / `ROW LEVEL SECURITY` en `drizzle/`, `src/`, `scripts/` | ❌ cero coincidencias |
| Medición real del prompt (script temporal, tenant Selyon) | 1.914 tok (system) + 1.754 tok (tools) = **3.668 tok fijos por llamada** |
| `npx tsx scripts/simulacion/simular.ts` (agregado en Fase 2) | 10 escenarios contra el server real con el agente real — ver abajo |

### Verificación empírica (Fase 2, 2026-07-27)

`scripts/simulacion/simular.ts` dispara payloads firmados contra `src/server.ts` con OpenAI real y la Graph
API interceptada (ningún mensaje sale a WhatsApp, `DATABASE_URL` y `GOOGLE_*` borradas del entorno). Corre en
tres fases: HTTP + repo en memoria, camino de producción (PGlite + `wa_jobs` + worker real), y conversaciones
de agenda multi-turno verificadas contra la tabla `wa_citas`.

| Caso | Resultado |
|---|---|
| Saludo simple · consulta de precio · fuera de alcance · nota de voz | ✅ correctos |
| Mismo `message.id` dos veces | ✅ deduplicado (1 job, 1 respuesta) |
| Ráfaga de 3 mensajes en 2 s | ⛔ 3 respuestas incoherentes + aviso de bot 3× → **confirma BLOQUEANTE-02** |
| Horarios ofrecidos para hoy a las 09:24 | ⛔ incluye 08:00, 08:30, 09:00 → **confirma BLOQUEANTE-09** |
| Tap en el horario ya pasado | ⛔ **crea la cita** `2026-07-27 08:00` en `wa_citas` |
| Cita para una fecha pasada (15 de julio) | ✅ el modelo la rechazó → **BLOQUEANTE-08 corregido a ALTO** |

Latencia observada (2 corridas): ACK a Meta **7-73 ms** (excelente); respuesta al cliente **0,78 s – 28,55 s**.
Ese techo de 28,55 s en un turno sin herramientas es evidencia directa de BLOQUEANTE-03 + ALTO-11: sin timeout
y con el worker serial, son 28 s en los que ningún otro cliente recibe respuesta.

---

## Lo que NO pude determinar leyendo el código

Lo digo explícito para que no lo tomes como verificado:

1. **Si hay RLS aplicado directamente en Supabase** (por consola, fuera de las migraciones). En el repo no hay
   nada. Si lo activaste a mano, no está versionado — y un `drizzle-kit` futuro o una restauración de backup lo
   pierde silenciosamente.
2. **Si Sentry, el uptime monitor y el cron de backups están realmente activos en el droplet.** El `.env` local
   no tiene `SENTRY_DSN`; `DEPLOY.md` §16-19 los documenta como pasos manuales opcionales. Necesito ver el
   droplet.
3. **Si las plantillas de Meta están aprobadas** (recordatorio Utility, marketing, reapertura, rescate). El
   `ROADMAP.md:160` dice que la de recordatorios sigue esperando aprobación.
4. **Si PM2 corre en modo `fork` (1 proceso) o `cluster` (N procesos).** Cambia el análisis de duplicados
   (ver ALTO-04). Asumí `fork` porque es lo que sugiere `DEPLOY.md` §6.
5. **El costo real por conversación de Meta en CR** (tarifas de servicio/utilidad/marketing). Las estimaciones
   de la sección 7 son solo del lado de OpenAI.
6. **Conteo exacto de tokens.** Usé la aproximación 3,7 caracteres/token para español. El orden de magnitud es
   correcto; el número exacto puede variar ±15%.

---

# 1. Webhook y entrega de mensajes

### ✅ Lo que está bien (no lo toques)

- **Verificación del token de Meta** — `src/whatsapp/client.ts:12-20`. Correcto.
- **Validación de firma `X-Hub-Signature-256`** — `src/whatsapp/client.ts:26-34`. HMAC-SHA256 sobre el cuerpo
  **crudo** (no el JSON reparseado, que es el error clásico), comparación en tiempo constante con
  `timingSafeEqual`, y **fail-closed**: si falta `WHATSAPP_APP_SECRET` devuelve `false`. Bien hecho.
- **200 antes del LLM** — `src/server.ts:95-118`. Fase 1 (persistir + encolar, transaccional) → `200` → Fase 2
  (LLM) en el worker. Correcto.
- **Idempotencia** — índice único `wa_msg_waid_uq` (`src/db/schema.ts:78`) + `onConflictDoNothing` dentro de
  una transacción que también inserta el job (`src/booking/drizzleRepository.ts:489-522`). Probado en
  `test/reliability/colaDurable.test.ts:133`. Un reintento de Meta no duplica ni el mensaje ni el job.

---

### 🔴 BLOQUEANTE-01 — El tap en "Confirmo ✅" de una plantilla aprobada cae al flujo "no puedo ver stickers"

**Archivo:** `src/whatsapp/client.ts:81-87` · `src/handleWebhook.ts:107-139, 185-188`

**Qué pasa hoy:** `parsearEntrante` solo reconoce `msg.type === "interactive"`. Cuando el cliente toca un botón
de **quick reply de una plantilla aprobada**, Meta envía `msg.type === "button"` con la carga en
`msg.button.payload` / `msg.button.text` — un tipo distinto. Ese caso no está contemplado, así que
`esTexto = false`, cae a la rama `"no-texto"` y el cliente recibe:

> "¡Hola! 🙂 Por ahora no puedo ver stickers ni videos…"

**Por qué importa ahora:** hoy no explota porque `enviarRecordatorio` (`src/reminders/scheduler.ts:108-114`)
manda **texto libre con botones** (`type: interactive`) cuando no hay plantilla configurada. Pero el plan
declarado (`GUIA-META.md` §A, `ROADMAP.md:160`) es activar `WHATSAPP_TEMPLATE_RECORDATORIO` con botones de
quick-reply. **El día que apruebes esa plantilla, la confirmación de citas deja de funcionar para todos los
clientes a la vez** y nadie se entera hasta que el dueño reclame que nadie confirma.

**Qué debería pasar:** `parsearEntrante` debe manejar `msg.type === "button"` mapeando `msg.button.payload` a
`interactiveId` (misma convención `tipo|arg`) y `msg.button.text` al título. Es un `if` de cinco líneas junto
al bloque de `interactive`, más un test.

---

### 🔴 BLOQUEANTE-02 — Tres mensajes seguidos producen tres respuestas que se ignoran entre sí ✅ verificado

> **Verificado el 2026-07-27 con `scripts/simulacion/simular.ts`, caso 6**, sobre el camino de PRODUCCIÓN
> (Postgres real + `wa_jobs` + el worker de `src/queue/worker.ts`). Reproducible en las 3 corridas.
>
> Cliente escribe 3 frases con 0,7 s de separación → **3 jobs, 3 respuestas**, cada una ignorando a la
> anterior:
>
> | # | El cliente escribió | El bot respondió | +t |
> |---|---|---|---|
> | 1 | "hola buenas" | "¡Hola! ¿Cómo estás? 😊 ¿En qué puedo ayudarte hoy?" | 1,98 s |
> | 2 | "quiero agendar una reunión" | "**¡Hola!** Claro, puedo ayudarte con eso. ¿Te gustaría una reunión de diagnóstico o una demo?" | 14,61 s |
> | 3 | "para mañana si se puede" | "Claro, **¿qué tipo de reunión te gustaría agendar?** Tenemos dos opciones: 1. Reunión de diagnóstico… 2. Demo…" | 16,79 s |
>
> Se saluda dos veces y hace **la misma pregunta dos veces seguidas** (2 y 3), porque el job 3 nunca vio la
> respuesta del job 2. Ni siquiera llegó a registrar que el cliente dijo "para mañana".
>
> **Hallazgo NUEVO que no estaba en la versión original de este informe:** el aviso legal de bot
> (`AVISO_BOT`, `handleWebhook.ts:30`) se antepuso a **las 3 respuestas**. La causa es la misma: `primerContacto`
> también se calcula en la ingesta (`handleWebhook.ts:144`) y se congela en el payload del job, mientras que
> `marcarOptIn` recién corre en la fase 2 (`:580`). Los tres jobs creyeron ser el primer contacto.
> El cliente recibe tres veces *"Soy el asistente automatizado de Selyon… Escribí agente si preferís hablar
> con una persona"*. Es lo primero que se nota y es lo que más "cara de robot roto" le da.
>
> Nota de latencia: la tercera respuesta tardó **16,8 s** por el efecto serial de la cola.

**Archivo:** `src/handleWebhook.ts:144, 148, 156-163` · `src/queue/worker.ts:29-68`

**Qué pasa hoy:** en Fase 1 se toma un **snapshot** del historial (`historialPrevio = conv.mensajes.slice()`)
y se **serializa dentro del payload del job** (`src/handleWebhook.ts:162`). El worker procesa los jobs en
serie, pero cada uno usa el snapshot congelado en el momento de la ingesta.

Traza concreta con el cliente escribiendo tres mensajes en 3 segundos:

| t | Evento | `historialPrevio` guardado en el job |
|---|---|---|
| 0s | Llega "hola" | `[]` |
| 1s | Llega "quiero agendar" | `[hola]` |
| 2s | Llega "para mañana" | `[hola, quiero agendar]` |
| 4s | Worker responde job 1 → "¡Hola! ¿En qué te ayudo?" | — |
| 8s | Worker responde job 2 con `[hola]` | **no ve su propia respuesta anterior** |
| 12s | Worker responde job 3 con `[hola, quiero agendar]` | **no ve ninguna de sus dos respuestas** |

El bot se saluda tres veces, vuelve a pedir datos que ya pidió, y se contradice. Es el patrón de escritura
**normal** en WhatsApp en Costa Rica (la gente manda frases sueltas, no párrafos). No es un caso borde.

**Qué debería pasar:** dos arreglos, ambos necesarios:
1. El worker debe **releer el historial desde la base** al procesar el job, en vez de usar el snapshot
   serializado. `historialPrevio` en el payload es una optimización que cuesta corrección.
2. **Coalescing / debounce**: agrupar los mensajes de un mismo cliente que llegan en una ventana corta
   (2-5 s) en un solo turno del agente. Alternativa más barata sin cambiar la cola: al reclamar un job,
   verificar si hay jobs más nuevos pendientes de la misma conversación y, si los hay, marcar este como hecho
   sin responder (el último gana, con el historial completo).

---

### 🔴 BLOQUEANTE-03 — Cero timeouts en toda la superficie de red

**Archivos:** `src/agent/runAgent.ts:23-26, 359-364` · `src/whatsapp/client.ts:267-271, 411, 420` ·
`src/whatsapp/transcribir.ts:33-37`

**Qué pasa hoy:** una búsqueda de `timeout|AbortSignal|AbortController|maxRetries` en `src/` devuelve **cero
resultados** en código de configuración. Eso significa:

- `new OpenAI()` (`src/agent/runAgent.ts:24`) usa los defaults del SDK: **timeout de 600.000 ms (10 minutos)** y
  **2 reintentos**. Peor caso: **30 minutos** bloqueado en una sola llamada.
- Los `fetch` a la Graph API no pasan `signal`. Quedan a merced de los defaults de undici (~300 s de
  `headersTimeout`), × 3 intentos de `MAX_INTENTOS_ENVIO` = hasta 15 minutos.

**Combinado con el worker serial** (`src/queue/worker.ts:30-67`, un `reclamarUno` a la vez), esto es
**head-of-line blocking global**: un mensaje colgado de tu cliente A congela la cola de los clientes B, C y D.
Todos dejan de recibir respuestas. Tu único síntoma es la línea `cola pendiente=N` creciendo en `pm2 logs`,
que nadie está mirando.

**Qué debería pasar:**
- `new OpenAI({ timeout: 20_000, maxRetries: 1 })` — 20 s es generoso para `gpt-4o-mini`.
- `AbortSignal.timeout(15_000)` en cada `fetch` de `client.ts` y en la descarga de media.
- Además, el worker debería tolerar concurrencia (ver ALTO-04).

---

### 🔴 BLOQUEANTE-04 — Ubicación, documentos, contactos y reacciones caen en "no puedo ver stickers ni videos"

**Archivo:** `src/whatsapp/client.ts:60-104` (parseo) · `src/handleWebhook.ts:107-139, 181-197` (rama no-texto)

**Qué pasa hoy:** el parseo solo distingue `text`, `audio`, `image` e `interactive`. Todo lo demás cae en la
rama genérica `"no-texto"` y recibe el mismo mensaje literal:

> "Por ahora no puedo ver **stickers ni videos**. Contame por texto…"

Casos reales que caen ahí y suenan mal:

| El cliente manda | El bot responde | Por qué es un problema |
|---|---|---|
| Su **ubicación** (`type: location`) | "no puedo ver stickers ni videos" | Es un gesto útil: quiere saber si le queda cerca. |
| Un **PDF/documento** (`type: document`) | idem | Cotización, factura, orden de compra. |
| Un **contacto** (`type: contacts`) | idem | "te paso el número de mi socio". |
| Una **reacción 👍** (`type: reaction`) | idem | El cliente solo agradeció y el bot le contesta con un sermón. |
| Un **video** | idem | Este sí es correcto. |

El caso de la **reacción** es el peor: es un gesto de cortesía que dispara una respuesta del bot **y** una
notificación push al operador (`src/handleWebhook.ts:190-195`), consumiendo una conversación de Meta.

**Qué debería pasar:** `parsearEntrante` debe exponer el `type` crudo, y `responderEntrante` ramificar:
`reaction` → ignorar por completo (ni respuesta ni push); `location` → guardar coordenadas y pasar al agente
como texto ("el cliente compartió su ubicación: lat, lng"); `document`/`contacts` → mensaje específico
("recibí tu archivo, ya se lo paso a una persona del equipo") + push. El texto genérico debería quedar solo
para `video` y `sticker`.

---

### 🟠 ALTO-01 — No se lee el contexto de respuesta (`context.id`) ni el flag de reenviado

**Archivo:** `src/whatsapp/client.ts:60-104`

**Qué pasa hoy:** cuando el cliente **cita/responde** a un mensaje anterior (deslizar y responder, muy común en
WhatsApp), Meta manda `msg.context.id` con el `wamid` del mensaje citado. No se parsea. El bot recibe solo
"ese mismo" o "cuánto es ese" sin saber a qué se refiere, y responde algo genérico o escala.

Tampoco se lee `msg.context.forwarded` / `frequently_forwarded`, que serviría para detectar cadenas de spam.

**Qué debería pasar:** capturar `context.id`, buscar ese `wa_message_id` en `wa_mensajes` (ya está indexado y
es único) y anteponer al turno del usuario algo como
`[El cliente responde a este mensaje tuyo: "…"] <texto>`. Es barato y mejora mucho la coherencia percibida.

---

### 🟠 ALTO-02 — Un error transitorio de OpenAI nunca se reintenta: el cliente recibe la disculpa y listo

**Archivo:** `src/handleWebhook.ts:593-615`

**Qué pasa hoy:** el `catch` de `responderEntrante` **atrapa el error y retorna normalmente**. El worker
(`src/queue/worker.ts:51-52`) interpreta eso como éxito y llama `marcarHecho`. Resultado: **el mecanismo de
reintentos de la cola (`maxIntentos: 5` + backoff exponencial) nunca se activa para el caso más frecuente de
falla**, que es un hipo de OpenAI.

El cliente recibe "Disculpá, tuvimos un problemita. Probá de nuevo en un momento 🙏" y el mensaje se da por
resuelto, aunque un reintento 4 segundos después hubiera funcionado.

Está bien que no reintente **indefinidamente** (evita spamear al cliente con disculpas), pero perder el
reintento por completo es el otro extremo.

**Qué debería pasar:** distinguir errores transitorios (429, 5xx, timeout de OpenAI) de permanentes. Los
transitorios deben **relanzarse** para que la cola reintente en silencio (sin mandarle nada al cliente en los
primeros 1-2 intentos), y recién en el último intento mandar la disculpa + escalar a humano.

---

### 🟠 ALTO-03 — La ventana de 24 h se respeta en el panel pero no en los recordatorios ni en el post-servicio

**Archivos:** `src/reminders/scheduler.ts:89-115, 128-135` · `src/panel/router.ts:1353-1361` (el caso bien resuelto)

**Qué pasa hoy:** el panel hace lo correcto: `obtenerConversacionPorId` calcula `ventanaAbierta`
(`src/whatsapp/ventana.ts`) y el endpoint `responder` devuelve `409 ventana_cerrada` en vez de dejar que Meta
rechace el envío. Muy bien.

Pero el scheduler **no consulta la ventana en ningún momento**. Si `WHATSAPP_TEMPLATE_RECORDATORIO` no está
configurado (que es el estado actual, `ROADMAP.md:160`), manda **texto libre con botones** a citas de mañana —
que por definición casi siempre están fuera de la ventana. Meta lo rechaza, el `catch` revierte el claim
(`scheduler.ts:159`) y **el ciclo lo reintenta cada 5 minutos indefinidamente** contra la misma cita, quemando
llamadas a la Graph API y llenando el log de errores. Lo mismo con el post-servicio (`scheduler.ts:186-201`).

**Qué debería pasar:** antes de enviar, consultar el estado de la ventana. Si está cerrada y no hay plantilla
configurada para ese tenant, marcar el recordatorio como "omitido" (no revertir el claim) y registrar el motivo,
en vez de reintentar en bucle.

---

# 2. Aislamiento multi-tenant

### ✅ Lo que está bien

El filtrado por `tenant_id` a nivel de aplicación está aplicado con **disciplina real**, no por casualidad:

- Todas las lecturas del repositorio Drizzle llevan `eq(waCitas.tenantId, tenantId)` / `eq(waConversaciones.tenantId, tenantId)`.
- Las **escrituras** también van scopeadas en el `WHERE`, no solo por id: `cancelarCita`, `reprogramarCita`,
  `confirmarCita`, `completarCita`, `marcarNoShow`, `setModoConversacion`, `guardarNotas`, `marcarLeidas`
  (`src/booking/drizzleRepository.ts:264-310, 534-553, 731-770`). Eso es defensa en profundidad correcta.
- `test/tenant/aislamiento.test.ts` prueba explícitamente 8 escenarios de cruce, incluido "el mismo número de
  cliente en dos tenants".
- El **token de sesión firma el `tenantId`** y hay test de que alterarlo lo invalida
  (`test/security/seguridad.test.ts:67`).
- El `accessToken` de WhatsApp **nunca vuelve al navegador** — hay test dedicado
  (`test/e2e-panel/api.spec.ts:103-130`).

---

### 🔴 BLOQUEANTE-05 — Todos los tenants comparten un solo Google Calendar

**Archivos:** `src/calendar/googleCalendar.ts:27-32, 119, 149, 167` · `src/booking/gestionCitas.ts:23, 34`

**Qué pasa hoy:**

```ts
// src/calendar/googleCalendar.ts:119
const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID!);
```

`GOOGLE_CALENDAR_ID` es **una variable de entorno global**, no un campo de `wa_tenants`. `crearEventoCita`
recibe el `tenant` como parámetro pero **lo ignora para elegir el calendario**. Lo mismo la service account
(`GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_PRIVATE_KEY`).

**Consecuencia con dos clientes:** las citas de la barbería aparecen en el Google Calendar del lavacar, con
nombre del cliente, teléfono, servicio y precio. **Es una fuga de datos personales de los clientes de un
negocio hacia otro negocio, en un sistema de terceros que vos no controlás.** Ese es exactamente el escenario
que te hunde: no es un bug de UX, es un incidente de privacidad que el cliente afectado ve con sus propios ojos.

Peor: `sincronizarCancelacionGcal` borra eventos por `gcalEventId`, así que un tenant podría borrar eventos del
calendario compartido de otro.

**Qué debería pasar:** `googleCalendarId` como columna en `wa_tenants` (igual que `googlePlaceId`, que sí está
per-tenant en `src/db/schema.ts:221`), configurable desde "Mi negocio", y `calendarioConfigurado(tenant)`
recibiendo el tenant. Mientras eso no exista: **borrar `GOOGLE_CALENDAR_ID` del `.env` de producción antes de
dar de alta al segundo cliente.** Sin la variable, la integración queda apagada (`calendarioConfigurado()`
devuelve `false`) y todo lo demás sigue funcionando.

---

### 🟠 ALTO-04 — No hay RLS en ninguna tabla

**Archivos:** `drizzle/*.sql` (22 migraciones, cero `POLICY`) · `src/db/schema.ts:10-13` (el comentario lo
reconoce como pendiente: *"agregá políticas RLS en tu flujo `rls/apply.ts`"*)

**Qué pasa hoy:** el aislamiento es **100 % dependiente de que cada query lleve el `WHERE tenant_id`**. Hoy lo
llevan (bien), pero no hay red de seguridad. Un solo `SELECT` futuro sin filtro, un endpoint nuevo escrito
apurado, o un bug en el ruteo del webhook, y no hay nada que lo detenga en la capa de datos.

Además, la app se conecta con **un solo rol de Postgres** (`src/db/client.ts:12-16`) que tiene acceso total a
todo. Cualquier SQL injection o error lógico ve todos los tenants.

**Nota:** no puedo verificar si activaste RLS a mano en la consola de Supabase. Si lo hiciste, no está en el
repo, y una restauración de backup o un cambio de schema lo puede perder sin aviso.

**Qué debería pasar:** políticas RLS en las 12 tablas con `tenant_id`, en una migración versionada, más
`SET LOCAL app.tenant_id = $1` al inicio de cada transacción. Es trabajo real (hay que envolver el acceso a
`db`), pero es la diferencia entre "confío en mi disciplina" y "es estructuralmente imposible".

**Por qué ALTO y no BLOQUEANTE:** hoy las queries están bien y hay tests que lo verifican. Es deuda de
arquitectura, no un agujero abierto. Pero el riesgo crece con cada feature nueva.

---

### 🟠 ALTO-05 — Un tenant sin `accessToken` propio manda mensajes con el token global

**Archivo:** `src/whatsapp/client.ts:257, 408`

```ts
const token = tenant.accessToken ?? process.env.WHATSAPP_ACCESS_TOKEN;
```

**Qué pasa hoy:** si en el alta se olvidan de pegar el `accessToken` del cliente (es un campo **opcional** en
`validarAltaTenant`, `src/panel/router.ts:300-301`), el envío usa el token de **tu** número de prueba contra el
`phone_number_id` **del cliente**. Meta responde 401/403, el mensaje nunca llega, y el error queda enterrado en
`pm2 logs` mientras el cliente ve un bot mudo.

Peor variante: si por alguna razón el `phone_number_id` también quedara mal, podrías terminar mandando mensajes
de un cliente desde el número de otro.

**Qué debería pasar:** el `accessToken` debe ser **obligatorio** en el alta cuando hay `DATABASE_URL`, o al
menos el alta debe hacer un ping de verificación (`GET /{phone_number_id}`) con el token dado y rechazar el
alta si falla. El fallback a `WHATSAPP_ACCESS_TOKEN` debería existir solo cuando `NODE_ENV !== "production"`.

---

### 🟠 ALTO-06 — Las sesiones no se revocan: desactivar un usuario no lo saca hasta 7 días después

**Archivos:** `src/panel/auth.ts:81-110` · `src/panel/router.ts:260-266`

**Qué pasa hoy:** la sesión es un token HMAC **stateless** que lleva `tenantId.usuarioId.rol.exp.version`.
`sesionDeOperador` valida la firma y resuelve el tenant, pero **nunca consulta si el usuario sigue activo ni
cuál es su rol actual**.

Consecuencias concretas:

| Acción del dueño | Efecto real |
|---|---|
| Desactiva a un empleado que se fue (`POST /usuarios/{id}` con `activo: false`) | El empleado **sigue entrando al panel hasta 7 días**, lee todas las conversaciones y puede responder como el negocio. |
| Degrada a un dueño a operador | Conserva permisos de dueño 7 días: puede editar "Mi negocio", cambiar el prompt, crear usuarios. |
| El superadmin resetea una clave (Carril D 0.5) | La sesión vieja con la clave anterior **sigue viva**. |
| Un usuario cambia su propia clave por sospecha de robo | El atacante conserva la sesión robada. |

Esto es lo primero que va a hacer un cliente el día que despida a alguien, y va a llamarte diciendo "lo saqué
y sigue entrando".

**Qué debería pasar:** `sesionDeOperador` debe consultar `obtenerUsuarioPorId(usuarioId)` (ya existe,
`src/config/tenantStore.ts:229`, lee del caché en memoria — costo casi cero) y rechazar si el usuario no existe
o está inactivo. Y tomar el `rol` **de la cuenta**, no del token. Para el cambio de clave, agregar un
`sessionEpoch` por usuario que invalide tokens anteriores.

---

### 🟡 MEDIO-01 — `borrarPushSub` no filtra por tenant: un operador puede desuscribir dispositivos de otro negocio

**Archivos:** `src/booking/drizzleRepository.ts:885-887` · `src/panel/router.ts:1168-1173`

```ts
async borrarPushSub(endpoint: string): Promise<void> {
  await this.db.delete(waPushSubs).where(eq(waPushSubs.endpoint, endpoint));
}
```

El endpoint viene del cuerpo del request sin validar que pertenezca al tenant de la sesión. Un operador
autenticado del negocio A que conozca (o adivine) un endpoint del negocio B le apaga las notificaciones push.
Es un DoS de bajo impacto pero es una **escritura cross-tenant real** desde una superficie autenticada.

**Qué debería pasar:** `.where(and(eq(waPushSubs.endpoint, endpoint), eq(waPushSubs.tenantId, tenantId)))`.
Cambio de una línea.

---

### 🟡 MEDIO-02 — Escrituras sin `tenant_id` en el `WHERE` (defensa en profundidad faltante)

**Archivo:** `src/booking/drizzleRepository.ts`

| Método | Línea | Filtro actual |
|---|---|---|
| `registrarRespuestaSeguimiento` | 452-462 | solo `eq(waSeguimientos.citaId, citaId)` |
| `marcarOptIn` / `marcarOptOut` | 192-204 | solo `conversacionId` |
| `guardarGcalEventId` | 244-246 | solo `citaId` |
| `marcarRecordatorio` / `reclamarRecordatorio` / `revertirRecordatorio` | 404-445 | solo `citaId` |
| `guardarMensaje` / `actualizarMediaMensaje` | 160-190 | solo `conversacionId` |

Hoy **ninguno es explotable**: los ids siempre vienen de una lectura previa ya scopeada. La excepción parcial es
`registrarRespuestaSeguimiento`, cuyo `citaId` viene del `interactiveId` del cliente
(`src/handleWebhook.ts:438, 464`) — pero ese id lo emitió el propio sistema y el payload viene firmado por Meta,
y los `citaId` son UUIDv4 (no adivinables). Riesgo residual bajo.

**Qué debería pasar:** agregar `eq(tabla.tenantId, tenantId)` a todos, igual que ya se hizo con las mutaciones
de citas y conversaciones. Es consistencia, y hace que el día que agregues RLS no tengas que reauditar.

---

# 3. Configurabilidad por cliente

### 🔴 BLOQUEANTE-06 — El nombre de la plantilla de recordatorios es global, no por cliente

**Archivo:** `src/reminders/scheduler.ts:89, 96`

```ts
const plantilla = process.env.WHATSAPP_TEMPLATE_RECORDATORIO;
const idioma = process.env.WHATSAPP_TEMPLATE_IDIOMA ?? "es";
```

**Qué pasa hoy:** las plantillas de WhatsApp se aprueban **por WABA** (por cliente). Este código usa un único
nombre global para todos. Con dos clientes:

- O ambos aprueban una plantilla con **exactamente el mismo nombre** (`recordatorio_cita`) en sus respectivos
  WhatsApp Manager — y vos tenés que coordinarlo y verificarlo, cliente por cliente, sin ningún check en el
  código;
- o el envío falla con "template not found" para todos menos uno, en silencio, cada 5 minutos.

El contraste con el resto del código es notable: `plantillaMarketing`, `plantillaReapertura` y `rescatePlantilla`
**sí** están per-tenant en `wa_tenants` (`src/db/schema.ts:187-190, 217`). La de recordatorios se quedó atrás.

Y `WHATSAPP_TEMPLATE_IDIOMA` global también afecta a las campañas (`src/campaigns/worker.ts:74`) y al rescate
(`src/rescate/worker.ts:148`) — si un cliente aprueba en `es_MX` y otro en `es`, uno de los dos rompe.

**Qué debería pasar:** columnas `plantillaRecordatorio` y `plantillaIdioma` en `wa_tenants`, editables desde
"Mi negocio", con el `.env` solo como fallback de desarrollo.

---

### 🔴 BLOQUEANTE-07 — El texto que ve el cliente final está hardcodeado en español tico y con emojis de lavacar

**Archivo:** `src/handleWebhook.ts` (principalmente) · `src/reminders/scheduler.ts`

El motor del prompt sí es genérico (B7 está bien hecho: `tipoNegocio`, `registro`, `tono`, `instrucciones`,
secciones libres). Pero **todo lo que el bot dice fuera del LLM** está fijo en el código:

| Línea | Texto | Problema |
|---|---|---|
| `handleWebhook.ts:30-31` | "Soy el asistente automatizado de %NOMBRE%… Escribí *agente* si preferís hablar con una persona." | Voseo fijo. Para un cliente mexicano/colombiano suena mal, y ya existe el campo `registro` que se ignora acá. |
| `handleWebhook.ts:34` | "Dejame consultarlo con una persona del equipo 🙋" | idem |
| `handleWebhook.ts:188` | "no puedo ver stickers ni videos" | ver BLOQUEANTE-04 |
| `handleWebhook.ts:420` | "¡Gracias por confirmar tu cita! ✅ Te esperamos. **🚗**" | **Emoji de carro** en un motor multi-rubro. Una clínica dental o una barbería recibe un auto. |
| `handleWebhook.ts:444` | "…nos ayudaría muchísimo que dejaras una reseña en Google" | Voseo fijo, texto no editable. |
| `handleWebhook.ts:481` | "Listo, no vas a recibir más promociones…" | idem |
| `handleWebhook.ts:508` | "¡Listo! Te paso con una persona del equipo…" | idem |
| `handleWebhook.ts:604` | "Disculpá, tuvimos un problemita. Probá de nuevo en un momento 🙏" | idem |
| `scheduler.ts:112-113` | "Te recordamos tu cita en {negocio} {cuándo}: {servicio}. ¿Nos confirmás?" | Voseo fijo |
| `scheduler.ts:131` | "¿Cómo te fue con tu {servicio} en {negocio}? **🚗**" | Otro emoji de carro |
| `runAgent.ts:124` | `motivo: "ese servicio no se agenda; **los lavados son por orden de llegada**"` | Texto de lavacar que el LLM lee y puede parafrasear al cliente de una barbería. |

También hardcodeado y no configurable:

- **Palabras clave de escalada** — `handleWebhook.ts:322, 502`: `/\bagente\b|\bhumano\b|\bpersona\b/i`.
  El caso `persona` genera **falsos positivos reales**: "¿el precio es por persona?", "¿atienden a más de una
  persona?", "soy persona física" → el bot corta y escala. En un negocio de servicios eso pasa seguido.
- **Comando de opt-out** — `handleWebhook.ts:478`: `"baja"` exacto. No configurable, no documentado al cliente
  salvo si el dueño lo pone en su plantilla.
- **Modelo de OpenAI** — `runAgent.ts:17`: `OPENAI_MODEL` global. No podés darle un modelo mejor a un cliente
  Pro ni uno más barato a un Básico.
- **Idioma de transcripción** — `transcribir.ts:36`: `language: "es"` fijo.
- **Formato de moneda** — `systemPrompt.ts:51`, `rescate/worker.ts:84,146`: `toLocaleString("es-CR")` siempre.

**Qué debería pasar:** mover esos textos a una tabla de mensajes por tenant (o a campos de `wa_tenants` con
defaults), aplicar `FRASE_REGISTRO` (que ya existe en `systemPrompt.ts:7-11`) a los textos del sistema, y quitar
los emojis específicos de rubro. Las palabras clave de escalada deberían ser una lista configurable, y `persona`
debería salir del default.

---

### 🟠 ALTO-07 — La agenda soporta un solo recurso: no hay capacidad ni empleados

**Archivo:** `src/booking/availability.ts:49-63`

```ts
const ocupados = citasDelDia.filter(c => c.estado === "agendada").map(...);
const choca = ocupados.some(([oi, of]) => t < of && fin > oi);
```

Cualquier solapamiento bloquea el horario. Eso modela un negocio con **una sola bahía / un solo sillón / un
solo profesional**.

- Un lavacar con 3 bahías pierde 2/3 de su capacidad.
- Una barbería con 4 sillas solo puede agendar 1 corte a la vez.
- Un consultorio con 2 doctores no se puede modelar.

El `ROADMAP.md:142` lista "agenda multi-empleado" en el backlog "construir solo por demanda", lo cual es una
decisión razonable — pero significa que **hoy solo podés venderle a negocios de un solo recurso**, y eso hay
que saberlo al vender, no descubrirlo en el onboarding.

**Qué debería pasar:** como mínimo, un campo `capacidadSimultanea` por servicio o por tenant (contar cuántas
citas solapan y comparar contra el tope). Es mucho más barato que el modelo completo de empleados y cubre la
mayoría de los casos.

---

### 🟠 ALTO-08 — `seedTenants.ts` corre en cada deploy y pisa la configuración que el cliente editó

**Archivos:** `scripts/seedTenants.ts:42-83` · `.github/workflows/ci-cd.yml:92`

**Qué pasa hoy:** el pipeline ejecuta `npx tsx scripts/seedTenants.ts` en **cada push a `main`**. Ese script
hace un `onConflictDoUpdate` con **todos** los campos de `TENANT_FALLBACK_SELYON`, incluyendo `horario`,
`servicios`, `kb`, `instrucciones`, `tono` y `pais`:

```ts
await db.insert(waTenants).values(datos)
  .onConflictDoUpdate({ target: waTenants.id, set: { ...datos, actualizadoEn: new Date() } });
```

Y también resetea el `passwordHash` del usuario desde `.env` (`seedTenants.ts:80-83`).

**Consecuencia:** si el dueño de Selyon afina su base de conocimiento desde "Mi negocio" un martes, el próximo
deploy (que puede ser por un cambio de CSS totalmente ajeno) **le revierte todo** a los valores hardcodeados en
`src/config/tenants.ts`. Y si cambió su contraseña, vuelve a la vieja.

Hoy afecta solo al tenant `selyon`. Pero es el patrón que vas a copiar para el próximo cliente, y ahí sí es
destructivo para un cliente que paga.

**Qué debería pasar:** el seed debe ser **idempotente en el sentido de "no pisar"**: `onConflictDoNothing`, o un
`onConflictDoUpdate` limitado a `phoneNumberId` y `accessToken` (lo que sí es infraestructura). Alternativa
más limpia: sacar `seedTenants` del pipeline y correrlo solo a mano en el bootstrap inicial.

---

### 🟡 MEDIO-03 — El `.env` referencia una variable que el código ya no lee

`.env` define `PANEL_PASSWORD_HASH_ROSALES`, pero el código lee `PANEL_PASSWORD_HASH_SELYON`
(`src/config/tenants.ts:26`, `src/config/tenantStore.ts:80`, `scripts/seedTenants.ts:24`). Con el `.env` actual,
`seedTenants.ts` **aborta** con "❌ Falta PANEL_PASSWORD_HASH_SELYON", y como el pipeline usa `set -e`
(`ci-cd.yml:87`), **el deploy falla antes del `pm2 restart`** — que es exactamente la trampa documentada en
`[[deploy-migracion-obligatoria]]`. Verificá el `.env` del droplet; el local está desactualizado.

---

## ¿Cuánto trabajo tuyo toma dar de alta un cliente nuevo hoy?

Reconstruido del código y de `GUIA-META.md` / `DEPLOY.md`, **no de la documentación optimista**:

| # | Paso | Dónde | Tiempo tuyo | Espera externa |
|---|---|---|---|---|
| 1 | Crear/asociar el WABA del cliente, obtener `phone_number_id` y un token permanente de system user | Meta Business Manager, manual | 20-40 min | — |
| 2 | Suscribir tu app al WABA y apuntar el webhook | Meta, manual (`suscribirApp` solo se usa vía Embedded Signup, que **no está aprobado** — `ROADMAP.md`/`GUIA-META.md` §B) | 10 min | — |
| 3 | Redactar y enviar a aprobación **4 plantillas** (recordatorio Utility, marketing, reapertura, rescate) en el WhatsApp Manager **del cliente** | Meta | 30-45 min | **horas a días** |
| 4 | **Coordinar que el nombre de la plantilla de recordatorio sea idéntico al de todos tus otros clientes** (BLOQUEANTE-06) | manual, sin validación | 5 min + riesgo | — |
| 5 | Alta del negocio en `/panel/admin`: slug, nombre, `phone_number_id`, token, timezone, moneda, ubicación, horario semanal, servicios (id/nombre/precio/duración/agendable), KB (FAQ + secciones + datos + políticas), perfil (tipoNegocio/país/registro/tono/instrucciones), usuario + clave | Panel, form largo | **45-90 min** | — |
| 6 | Setear el plan (Básico/Pro) | `POST /api/panel/admin/tenants/{id}/plan` — hay UI | 1 min | — |
| 7 | **Google Calendar: hoy no se puede por cliente** (BLOQUEANTE-05). Hay que dejarlo apagado globalmente. | — | — | bloqueado |
| 8 | Configurar el cobro | **Manual** — `PROCESO-COBRO-MANUAL.md`. Stripe está codificado (`src/billing/stripe.ts`) pero **no hay ninguna ruta que lo invoque**: es código muerto. | 15 min/mes recurrente | — |
| 9 | Prueba end-to-end: mandar mensajes reales, agendar, confirmar, escalar | Manual | 20-30 min | — |

**Total: 2,5 a 4 horas de tu tiempo, más 1-3 días de espera por Meta, más un paso bloqueado (Calendar) y un
proceso de cobro manual recurrente.** No es autoservicio y no escala más allá de ~5 clientes sin que se te
convierta en trabajo de tiempo completo.

**Lo que más lo mejoraría, en orden:** (a) resolver BLOQUEANTE-06 y -05 para que el alta no requiera tocar el
`.env` del droplet; (b) plantillas de negocio pre-armadas por rubro (barbería, taller, clínica) para que el
paso 5 baje de 90 a 15 minutos; (c) cablear Stripe (el código ya está escrito).

---

# 4. Comportamiento del agente

### ✅ Lo que está bien

- **Handoff a humano por cuatro vías**: palabra clave en texto (`handleWebhook.ts:502`) y en audio
  (`:322`), la tool `escalar_a_humano` (`runAgent.ts:380-388`), agotar `MAX_PASOS` (`:402-407`), y el toggle
  manual del panel.
- **Anti-pisada**: se revalida el modo **después** del LLM y antes de hablar (`handleWebhook.ts:542-546`), así
  el bot no interrumpe a un humano que tomó la conversación mientras el modelo pensaba. Hay test
  (`test/e2e-webhook/webhook.test.ts:346`).
- **Los horarios no se inventan**: `ofrecer_horarios` / `agendar_cita` consultan la base y revalidan
  disponibilidad antes de crear (`runAgent.ts:134-138`).
- **El add-on del upsell no se puede inventar**: se valida contra la config del tenant, no contra lo que dice
  el modelo (`runAgent.ts:277-292`). Muy bien pensado.
- **Aviso de transparencia** en el primer contacto, con opt-in persistido (`handleWebhook.ts:30, 253`).

---

### 🟠 BLOQUEANTE-08 → corregido a ALTO tras la verificación empírica — falta el guard, pero el modelo aguantó

> **Corrección (verificado el 2026-07-27 con `scripts/simulacion/simular.ts`, caso C2).** La versión
> original de este hallazgo decía "el bot puede agendar citas en el pasado". **No se reprodujo.** Con el
> cliente pidiendo el 15 de julio (12 días atrás) y luego insistiendo *"sí, confirmá esa fecha"*, el modelo se
> negó las dos veces: *"no puedo agendar citas en fechas pasadas. Hoy es 27 de julio de 2026."* Cero citas
> creadas en `wa_citas`. El bloque de FECHA Y HORA del prompt (`systemPrompt.ts:90-92`) está haciendo su
> trabajo para fechas obviamente pasadas.
>
> Matiz que sí se observó: en un turno intermedio el modelo **afirmó disponibilidad para esa fecha pasada**
> (*"Para el 15 de julio tengo disponibilidad a las 10:00 a.m."*) antes de corregirse solo en el turno
> siguiente. Es decir, la defensa existe pero es probabilística.
>
> **Sigue siendo un hallazgo real** porque la ausencia del guard es la misma causa raíz de BLOQUEANTE-09, que
> sí se reprodujo y sí crea la cita. La diferencia: el modelo detecta una fecha absurda, pero **no** detecta
> una hora pasada de hoy, porque ahí confía en lo que le devuelve la herramienta.

**Archivo:** `src/agent/runAgent.ts:117-138` (falta el check) vs. `src/agent/runAgent.ts:239-241` (donde sí está)

`reprogramar_cita` valida correctamente:

```ts
// runAgent.ts:239
if (fecha < hoyEnTz(tenant.timezone)) {
  return JSON.stringify({ ok: false, motivo: "no se puede reprogramar a una fecha pasada." });
}
```

**`agendar_cita` no tiene esa validación.** Solo valida el *formato* (`:130`). El único freno es una instrucción
en el prompt (`systemPrompt.ts:92`: *"JAMÁS agendes en un año pasado"*) — es decir, **una sugerencia a un modelo
de lenguaje**, no un guard.

Y el panel **sí** lo valida (`src/panel/router.ts:1255-1257`), así que la inconsistencia está solo en el camino
del bot, que es el que usa el cliente final.

**Cómo se dispara en la práctica:** cliente escribe "agendame para el 15" a fin de mes; el modelo interpreta el
15 del mes que ya pasó. O "el lunes" un lunes. La cita se crea, entra al dashboard de ingresos, dispara la
sincronización a Calendar, y nunca genera recordatorio (el scheduler solo mira hoy/mañana). El dueño la ve en la
agenda de una fecha pasada y no entiende nada.

**Qué debería pasar:** copiar la validación de la línea 239 a `agendar_cita`. Tres líneas.

---

### 🔴 BLOQUEANTE-09 — Se ofrecen horarios que ya pasaron, y tocarlos CREA la cita ✅ verificado

> **Verificado el 2026-07-27 a las 09:24 (hora de Costa Rica) con `scripts/simulacion/simular.ts`, casos C1
> y C3.** Reproducible en las 3 corridas.
>
> **C1** — el cliente pide agendar para hoy. El bot devuelve la lista tocable de WhatsApp con estos ids:
> ```
> slot|2026-07-27|08:00   ← ya pasó
> slot|2026-07-27|08:30   ← ya pasó
> slot|2026-07-27|09:00   ← ya pasó
> slot|2026-07-27|09:30 … 12:30
> ```
> **3 de los 10 horarios ofrecidos ya habían pasado.**
>
> **C3** — el cliente toca "8:00 a.m." (el tap llega como `interactive`/`list_reply` con ese id). Respuesta
> del bot:
> > *"He agendado tu reunión de diagnóstico para hoy, 27 de julio de 2026, a las 08:00. ¡Te esperamos!"*
>
> Y en la base: `wa_citas` pasó de 0 a 1 filas → `2026-07-27 08:00 · reunion-diagnostico · Nathan Rosales`.
> **La cita se crea de verdad, una hora y veinte minutos en el pasado.**
>
> Por qué acá sí falla y en C2 no: el modelo puede razonar que "el 15 de julio ya pasó", pero **no** cuestiona
> una hora que la propia herramienta le presentó como disponible. `agendar_cita` tampoco la valida. No hay
> ninguna capa que lo detenga.

**Archivo:** `src/booking/availability.ts:57-63`

```ts
for (let t = apertura; t + servicio.duracionMin <= cierre; t += paso) { ... }
```

El bucle arranca en la hora de apertura **sin comparar contra la hora actual**. Si son las 15:00 y el negocio
abre 8:00-18:00, `espaciosDisponibles(tenant, hoy, ...)` devuelve `["08:00","08:30",…,"14:30","15:00",…]`.

Combinado con BLOQUEANTE-08, el bot ofrece con total naturalidad: *"Para hoy tengo a las 8:00 a.m., 8:30 a.m.,
9:00 a.m…"* a las tres de la tarde, el cliente toca una y **la cita se crea**.

Esto se ve en tres superficies a la vez: el bot (`ofrecer_horarios`), el rescate de cotizaciones
(`src/rescate/worker.ts:59-68`, que arranca la búsqueda en `hoyEnTz`) y la agenda del panel
(`router.ts:1217-1230`).

**Qué debería pasar:** `espaciosDisponibles` debe recibir la hora actual y, cuando `fecha === hoy`, descartar
los slots cuyo inicio sea anterior a `ahora + margenMinimoMin` (un margen configurable, típicamente 30-60 min,
porque nadie agenda para dentro de 5 minutos).

---

### 🟠 ALTO-09 — El modelo elige el precio que se persiste, sin validación contra el catálogo

**Archivos:** `src/agent/runAgent.ts:147` · `src/agent/tools.ts:64-68`

```ts
precio: args.precio != null && !Number.isNaN(Number(args.precio)) ? Number(args.precio) : undefined,
```

El único filtro es "que sea un número". No se compara contra `tenant.servicios.find(...).precio`, ni contra un
rango, ni se detecta si el servicio tiene `precioVariable`.

Consecuencias en cascada:
1. **El dashboard de ingresos del cliente miente.** `calcularMetricas` suma estos precios
   (`drizzleRepository.ts:847`). Un precio alucinado infla o desinfla la métrica que el dueño usa para decidir
   si tu producto vale la plata.
2. **Se le promete un precio al cliente final.** El prompt dice *"NUNCA inventés precios"* — pero eso es todo
   lo que hay entre el modelo y un compromiso comercial. Un `gpt-4o-mini` a `temperature: 0.3` con una KB
   ambigua se equivoca. El cliente llega al local con el screenshot.
3. Lo mismo con `registrar_cotizacion` (`runAgent.ts:256-270`): el `monto` es libre, y ese monto alimenta el
   texto del rescate que se le manda al cliente (`rescate/worker.ts:84`) y el "monto recuperado" del dashboard.

**Qué debería pasar:** si el servicio tiene `precio` fijo, **ignorar el valor del modelo y usar el del catálogo**.
Si tiene `precioVariable`, aceptar el del modelo pero validarlo contra un rango razonable configurado por el
dueño (`precioMin`/`precioMax`) y marcar la cita como "precio a confirmar". Y registrar en `wa_eventos_calidad`
cuando el modelo propone un precio distinto al del catálogo — es la señal más valiosa que podés tener de que el
prompt de un cliente está mal armado.

---

### 🟠 ALTO-10 — Una vez en modo humano, el bot no vuelve nunca: el cliente queda en silencio indefinido

**Archivos:** `src/handleWebhook.ts:493-499` · `src/db/schema.ts:29` (`modo` default `"bot"`, sin retorno automático)

**Qué pasa hoy:** al escalar, `setModoConversacion(..., "humano")` y el bot **deja de responder para siempre** en
esa conversación. La única forma de volver a `bot` es que alguien toque el toggle en el panel
(`router.ts:1412-1421`).

Escenarios reales:

- Cliente escribe "quiero hablar con una persona" un **viernes a las 8 p.m.** El bot responde *"En un momento
  te responden por acá"* — una promesa que nadie va a cumplir hasta el lunes. Push enviado, nadie lo ve.
- Cliente escribe "¿el precio es por **persona**?" (falso positivo del regex, ver BLOQUEANTE-07). Escala. El
  dueño no lo nota. **El cliente queda sin bot para siempre**, incluso semanas después cuando vuelva a escribir
  para agendar.
- El dueño de un negocio chico no entra al panel todos los días. Las conversaciones escaladas se acumulan
  mudas.

No hay: horario de atención para la promesa, timeout de reversión a bot, recordatorio al operador si nadie
respondió en X minutos, ni mensaje al cliente si se escala fuera de horario.

**Qué debería pasar, en orden de valor:**
1. **Mensaje distinto fuera del horario del negocio** (el horario ya está en `tenant.horario`): *"Ya le avisé al
   equipo. Te responden mañana a partir de las 8 a.m."* — no prometas "en un momento" a las 8 p.m.
2. **Auto-retorno a `bot`** tras N horas sin respuesta humana (configurable, default 24 h), con un mensaje al
   cliente ofreciendo seguir por el bot.
3. **Escalamiento del aviso**: si nadie abre la conversación en 15 min, segundo push / correo.

Este es el hallazgo que más probablemente te genere el reclamo "tu bot dejó a mi cliente colgado".

---

### 🟡 MEDIO-04 — El límite de historial son 20 mensajes y se pierde en silencio

**Archivo:** `src/booking/drizzleRepository.ts:129-136`

```ts
.orderBy(desc(waMensajes.creadoEn)).limit(20)
```

Los 20 más recientes (el comentario aclara que antes traía los 20 más viejos — bug ya corregido, bien). Pero en
una conversación de 40 mensajes el modelo **olvida silenciosamente** la primera mitad: el nombre del cliente,
qué servicio quería, el precio que ya le cotizaron. No hay resumen ni compactación.

En un flujo de venta con ida y vuelta (bastante común: cotizar → dudar → volver → agendar), 20 turnos se
alcanzan rápido, sobre todo porque el cliente manda frases sueltas (cada una es un turno).

**Qué debería pasar:** subir el límite a 30-40 (el costo marginal es bajo, ver sección 7) **y** persistir un
resumen rodante de la conversación en `wa_conversaciones` que se anteponga al historial cuando se trunca.

---

### 🟡 MEDIO-05 — La detección de "fuera de alcance" es un regex sobre la respuesta del modelo

**Archivo:** `src/agent/runAgent.ts:371`

```ts
const fueraDeAlcance = /solo puedo ayudarte con/i.test(respuesta);
```

Depende de que el modelo reproduzca **literalmente** la frase sugerida en el prompt (`systemPrompt.ts:120`).
Si parafrasea ("solo te puedo ayudar con…", "únicamente atiendo temas de…"), la métrica no lo cuenta. El
dashboard de calidad que le mostrás al cliente subcuenta los casos fuera de alcance, que es justo la métrica
que justifica subirlo a Pro o afinarle el prompt.

**Qué debería pasar:** una tool `fuera_de_alcance()` explícita (como ya existe `escalar_a_humano`), o pedirle al
modelo un marcador estructurado. El patrón correcto ya está en el código para el escalado; replicalo.

---

### 🟡 MEDIO-06 — "hola" cuesta lo mismo que una conversación compleja

Un "hola" pelado dispara el ciclo completo: 1.914 tokens de system prompt + 1.754 de definiciones de tools =
**3.668 tokens** para responder "¡Hola! ¿En qué te puedo ayudar?". Ver sección 7 para el impacto agregado.

---

# 5. Fallas y resiliencia

### ✅ Lo que está bien

- **Google Calendar cae** → `sincronizarCreacionGcal` atrapa y la cita queda guardada igual
  (`src/booking/gestionCitas.ts:23-33`, `runAgent.ts:152`). Correcto: la fuente de verdad es tu base.
- **La base cae en Fase 1** → `500` a Meta, que reintenta; la dedup evita el doble procesamiento
  (`src/server.ts:98-106`). Correcto.
- **La base cae al recargar tenants** → se **conserva el caché anterior** en vez de tirar los tenants buenos
  (`src/config/tenantStore.ts:173-183`). Muy bien pensado.
- **Reintentos con backoff a la Graph API**, con clasificación de errores transitorios de Meta por código
  (`src/whatsapp/client.ts:222-300`). El comentario dice que nació de un incidente real; se nota.
- **Cola durable con reaper** para jobs zombis (`src/queue/cola.ts:128-139`).
- **Secretos:** `.env` en `.gitignore`, **nunca commiteado** (verificado con `git log --all -- .env`: vacío).
  `backups/` también ignorado. Solo hay placeholders en `DEPLOY.md:411,439`. ✅
- **`PANEL_SESSION_SECRET` obligatorio en producción** con error explícito al arrancar
  (`src/panel/auth.ts:14-28`). Excelente: falla temprano y ruidoso en vez de tarde y silencioso.

---

### 🔴 BLOQUEANTE-10 — `/api/panel/login` es un DoS trivial contra todo el servidor

**Archivos:** `src/panel/auth.ts:38, 63` · `src/panel/router.ts:711-734`

**Qué pasa hoy:** el login usa `crypto.scryptSync` — la variante **síncrona**, que **bloquea el event loop de
Node** (~50-150 ms por invocación con los parámetros default). Y se ejecuta **siempre**, incluso cuando el
usuario no existe (`HASH_DUMMY`, `router.ts:719`) — decisión correcta contra timing attacks, pero que convierte
el endpoint en un amplificador.

**No hay rate limiting en ninguna parte del proyecto** (búsqueda de `rate.limit|ratelimit` en `src/`: solo
comentarios sobre el throttle de campañas).

**El ataque:** cualquiera en internet, **sin credenciales**, manda 20 POST/s a `/api/panel/login` con un usuario
inventado. El event loop queda saturado con `scryptSync`. Como Node es de un solo hilo y este proceso también
atiende **el webhook de WhatsApp**, el resultado es: los mensajes de **todos** tus clientes dejan de procesarse,
Meta empieza a recibir timeouts y reintenta, y eventualmente Meta **deshabilita tu webhook por tasa de error**.

El mismo problema, más leve, aplica a `admin/login` (`router.ts:513-518`) y a `cambiar-clave` (`:791`).

**Qué debería pasar:**
1. **`scrypt` asíncrono** (`crypto.scrypt` con `promisify`) para no bloquear el event loop. Cambio pequeño,
   beneficio inmediato.
2. **Rate limit por IP** en `/api/panel/login` y `/api/panel/admin/login` (p. ej. 10 intentos / 15 min / IP,
   en memoria con un `Map`, sin dependencias nuevas — respeta tu política de supply chain).
3. **Lockout por usuario** tras N fallos.
4. Idealmente: separar el proceso del webhook del proceso del panel.

---

### 🟠 ALTO-11 — Worker serial: el techo de throughput es global y bajo

**Archivo:** `src/queue/worker.ts:30-67`

`reclamarUno` procesa **un job a la vez**, para todos los tenants. Con una latencia típica de turno de 2-5 s
(el propio código la mide: `registrarLatenciaAgente`), el techo es **12-30 mensajes/minuto en total**, no por
cliente.

El comentario de la línea 16-17 lo reconoce ("*Para escalar a concurrencia: lanzar `iniciarWorker` varias
veces*"), pero hoy no está hecho. Con 5 clientes en hora pico, o con un solo cliente que reciba una ráfaga
(una campaña genera respuestas), la cola se apila y los clientes de los demás negocios esperan minutos.

Y no hay ninguna alerta cuando eso pasa: la profundidad de cola solo se imprime cada 5 minutos en `pm2 logs`
(`src/observabilidad/metricas.ts:55-57`).

**Qué debería pasar:** N workers concurrentes (la cola con `FOR UPDATE SKIP LOCKED` ya lo soporta sin cambios,
y hay test de ello en `test/reliability/colaDurable.test.ts:59`), con un límite de **1 job en vuelo por
conversación** para no perder el orden. Empezar con 4.

---

### 🟠 ALTO-12 — El reaper (180 s) es más corto que el timeout de OpenAI (600 s)

**Archivos:** `src/queue/worker.ts:24` (`QUEUE_REAPER_UMBRAL_SEG ?? 180`) vs. timeout default del SDK de OpenAI
(600 s, ver BLOQUEANTE-03)

Con **una sola instancia** de PM2 en modo `fork`, esto no produce duplicados: el worker está ocupado, no puede
reclamar el job que el reaper reencoló, y al terminar lo marca `hecho`.

Pero en el momento que agregues una segunda instancia (o pases PM2 a modo `cluster`, o hagas un deploy sin
downtime con solapamiento), un job lento de >180 s **es reclamado por la segunda instancia mientras la primera
sigue trabajando** → el cliente recibe **la misma respuesta dos veces**. La semántica at-least-once está
documentada honestamente en `src/queue/cola.ts:14-16`, pero el margen elegido (180 s vs 600 s) la hace
probable, no rara.

**Qué debería pasar:** el umbral del reaper debe ser **mayor** que el peor caso del trabajo. Con el timeout de
OpenAI en 20 s (BLOQUEANTE-03), un reaper de 120 s es holgado y seguro.

---

### 🟡 MEDIO-07 — Si Meta agota sus reintentos, el mensaje se pierde sin registro

Cuando la base está caída, Fase 1 devuelve `500` y Meta reintenta. Meta reintenta con backoff durante un rato
acotado y después **descarta el evento**. En ese punto el mensaje del cliente **desapareció**: no está en tu
base, no está en ningún log estructurado (solo un `console.error`), y el operador no tiene forma de saber que
existió.

**Qué debería pasar:** escribir el cuerpo crudo a un archivo de dead-letter local antes de devolver el 500, o
al menos `capturarError` con el `wamid` y el `phone_number_id` para poder reconstruirlo desde el WhatsApp
Manager.

---

### 🟡 MEDIO-08 — No hay detección ni alerta de token de WhatsApp vencido o revocado

Si un cliente revoca el token, o el token de system user expira, todos los envíos de ese tenant fallan con
401/403. `postMensaje` lo clasifica como **permanente** (correcto, `client.ts:291`) y lanza. Ese error termina
en un `console.error` y, en el mejor caso, en `wa_eventos_calidad` como `tipo: "error"`.

**Nadie te avisa.** El bot de ese cliente queda mudo y vos te enterás cuando el cliente llama.

**Qué debería pasar:** detectar 401/403/190 de Meta y disparar una alerta específica por tenant (Sentry con tag
`tenantId`, o un correo), además de marcar el tenant como "degradado" y mostrarlo en el admin.

---

# 6. Operación y soporte

### 🔴 BLOQUEANTE-11 — El health check no verifica nada

**Archivo:** `src/server.ts:42-46`

```ts
if (url.pathname === "/salud") {
  res.writeHead(200, ...);
  res.end("Agente de WhatsApp corriendo ✅");
}
```

Devuelve `200` mientras el proceso de Node esté vivo. No verifica: conexión a la base, si el caché de tenants
está cargado (podría estar en el fallback hardcodeado, `tenantStore.ts:178`), si el worker sigue vivo, si la cola
está creciendo, ni la edad del último job procesado.

**Consecuencia:** todo tu monitoreo cuelga de esto — el smoke post-deploy (`ci-cd.yml:97-108`) y el uptime
monitor (`DEPLOY.md` §17). Un bot con la base caída, con el worker muerto, o corriendo con el tenant de fallback
en vez de los reales, **reporta verde**. Un cliente puede estar caído horas con tu dashboard en verde.

Y el escenario del fallback es real y silencioso: si la base no responde al arrancar, `activarFallback` carga el
tenant `selyon` hardcodeado y **el bot atiende con la configuración equivocada** (`tenantStore.ts:173-183`),
mientras `/salud` dice OK.

**Qué debería pasar:** `/salud` debe devolver un JSON con checks reales y un `503` si alguno falla crítico:

```
{ ok, db: {ok, latenciaMs}, tenants: {cargados: N, fuente: "db"|"fallback"},
  cola: {pendientes, masViejoSeg, enError}, ultimoJobHace: "12s", uptime }
```

Con `fuente: "fallback"` o `masViejoSeg > 120` → `503`. Eso convierte tu uptime monitor de decorativo en útil.

---

### 🟠 ALTO-13 — Los logs no llevan `tenantId` ni `conversacionId`: no podés reconstruir un reclamo

**Archivo:** `src/handleWebhook.ts:141, 275, 383, 424, 465, 484, 494, 544, 568, 586`

Este es el hallazgo que ataca directo tu requisito de *"darle soporte sin acceder a su base de datos
manualmente"*.

```ts
// handleWebhook.ts:141
console.log(`[entrante] ${entrante.clienteWa}: "${entrante.texto.slice(0, 80)}"`);
// handleWebhook.ts:586
console.log(`[saliente] → ${entrante.clienteWa}: "${respuesta.slice(0, 80)}"...`);
```

Problemas concretos cuando el cliente C te escribe *"ayer a las 3 el bot le dijo cualquier cosa a un cliente
mío"*:

1. **No hay `tenantId`.** Con 5 clientes, todos los logs están mezclados en el mismo `pm2 logs` y no podés
   filtrar por negocio.
2. **No hay `conversacionId` ni `wamid`.** No podés correlacionar el entrante con su saliente ni con el error.
3. **Truncado a 80 caracteres.** Justo lo que necesitás ver (la respuesta completa que molestó) está cortado.
4. **Sin timestamp propio** (dependés del prefijo de PM2) y **sin nivel** (todo es `log`/`error`).
5. **No es JSON**, así que no se puede consultar con nada.
6. **Contenido de mensajes de clientes finales en texto plano** en el log del servidor — datos personales de
   los clientes de tus clientes, con retención indefinida y sin política declarada. Con los "Términos" y la
   "Privacidad" que ya publicaste en la landing, eso es una inconsistencia que conviene cerrar.

**Qué debería pasar:** un logger mínimo (sin dependencias) que emita JSON con `{ts, nivel, tenantId, convId,
wamid, evento, ...}`. Y dejar de loggear el contenido del mensaje por default (un flag `LOG_CONTENIDO=1` para
depurar).

---

### 🟠 ALTO-14 — No podés ver una conversación más allá de los últimos 100 mensajes

**Archivo:** `src/booking/drizzleRepository.ts:671-676`

El panel trae los **100 más recientes**, sin paginación hacia atrás, sin búsqueda y sin exportación. Para una
conversación larga (un cliente recurrente de un año), el reclamo de "qué le dijo el bot en marzo" **te obliga a
entrar a la base a mano** — justamente lo que dijiste que no querés hacer.

**Qué debería pasar:** paginación por cursor en `GET /conversaciones/{id}` (`?antes=<timestamp>`), búsqueda de
texto en la bandeja, y un botón "Exportar conversación" (CSV/TXT) que además le sirve al dueño para sus propios
reclamos.

---

### 🟡 MEDIO-09 — El deploy usa `npm install`, no `npm ci`, y no tiene rollback

**Archivo:** `.github/workflows/ci-cd.yml:90-95`

```bash
git pull
npm install        # ← no determinístico
npx tsx scripts/migrar.ts
npx tsx scripts/seedTenants.ts   # ← ver ALTO-08
npm run web:build
pm2 restart whatsapp-bot
```

- `npm install` puede resolver versiones distintas a las de `package-lock.json` (los rangos `^` de
  `drizzle-orm`, `openai`, `postgres`, `web-push`, `dotenv`). **CI valida un árbol de dependencias y producción
  corre otro.** Además contradice tu política de supply chain de `CLAUDE.md`, que exige versiones fijas.
- **Migraciones sin rollback.** Si `migrar.ts` aplica una migración y algo falla después, no hay vuelta atrás.
- **No hay rollback automático si el smoke falla.** El smoke (líneas 97-151) es bueno — verifica `/panel`, `/me`
  y `/login`, mucho mejor que un simple ping — pero si falla, la producción **queda rota** y solo se marca el
  job en rojo.
- **`pm2 restart` con una sola instancia = downtime** de unos segundos en cada push. Los webhooks que lleguen
  en esa ventana reciben connection refused; Meta reintenta, así que no se pierden, pero suma latencia.

**Qué debería pasar:** `npm ci --omit=dev`; fijar las versiones exactas en `package.json` (ya lo hacés con
Sentry, Stripe, Playwright y PGlite — falta el resto); guardar el SHA anterior y hacer `git reset --hard` +
`pm2 restart` automático si el smoke falla; `pm2 reload` en vez de `restart` cuando pases a 2+ instancias.

---

### 🟡 MEDIO-10 — Alertas: solo Sentry opcional, y no cubre lo que más importa

`capturarError` está bien colocado en los loops críticos (`worker.ts:59,64,85,89`, `scheduler.ts:215,221,227`,
`server.ts:102,116`) y `Sentry.init()` además captura `unhandledRejection` sin matar el proceso — buena decisión,
bien documentada en `src/observabilidad/sentry.ts:7-15`.

Pero es **opcional** (no-op sin `SENTRY_DSN`, que no está en el `.env` local) y **no hay alerta para las
condiciones que realmente rompen el servicio sin lanzar una excepción**:

| Condición | ¿Alerta hoy? |
|---|---|
| Cola creciendo (`wa_jobs` pendientes > N) | ❌ solo un `console.log` cada 5 min |
| Jobs en estado `error` (reintentos agotados) | ❌ nada consulta esa tabla |
| Tenant corriendo con el caché de fallback | ❌ solo un `console.error` al arrancar |
| Token de WhatsApp revocado (ver MEDIO-08) | ❌ |
| Conversación escalada a humano sin atender hace horas | ❌ |
| Un tenant sin ningún mensaje en 24 h (webhook desconectado) | ❌ |

---

### 🟡 MEDIO-11 — Backups: el script existe, la activación es manual y no verificable desde el repo

`scripts/backupDb.ts` existe y `DEPLOY.md` §19 documenta el cron y el procedimiento de restore (bien: incluye
probar el restore, que es lo que la mayoría se saltea). Pero es **setup manual en el droplet**, no hay forma de
verificar desde el código que esté activo, y no hay alerta si un backup falla.

Para un cliente que paga, "perdimos tus conversaciones y tus citas" es terminal. Antes de vender: confirmá que
el cron corre, que los archivos se están generando, y probá un restore completo.

---

### 🟡 MEDIO-12 — Stripe está escrito pero desconectado: el cobro es 100 % manual

`src/billing/stripe.ts` implementa `crearCheckoutSession`, `crearPortalSession` y `construirEvento`
(validación de firma del webhook). **Ninguna de esas funciones se invoca desde ningún lado** — verificado con
`grep` en `src/`, `web/src/` y `test/`. No hay ruta de webhook de Stripe en `server.ts` ni en `router.ts`, y no
hay componente de Facturación en `web/src/components/`.

`actualizarFacturacionTenant` (`tenantStore.ts:477`) tiene un comentario que referencia
`src/billing/webhook.ts`, **archivo que no existe**.

Es código muerto que da la falsa impresión de que C4.3 está listo. El cobro real es
`PROCESO-COBRO-MANUAL.md`: unos 15 min/mes por cliente, que a 10 clientes son 2,5 h/mes de trabajo manual
propenso a error.

No es bloqueante para los primeros clientes (cobrar por SINPE/transferencia funciona), pero conviene que el
ROADMAP no lo marque como hecho.

---

# 7. Costos

### Medición real del overhead

Medido ejecutando `construirSystemPrompt(TENANT_FALLBACK_SELYON)` y serializando `TOOLS`
(aproximación 3,7 car/token para español):

| Componente | Caracteres | ≈ Tokens |
|---|---|---|
| System prompt (tenant Selyon, KB moderada) | 7.081 | **1.914** |
| Definiciones de las 10 tools (`src/agent/tools.ts`) | 6.489 | **1.754** |
| **Overhead fijo, en CADA llamada al LLM** | | **3.668** |

A eso se suma el historial (hasta 20 mensajes) y los resultados de las tools, y todo se **reenvía completo en
cada paso** del ciclo de tool-calling (`MAX_PASOS = 4`, `runAgent.ts:18, 358`).

### Estimación por conversación (gpt-4o-mini, $0,15/1M in · $0,60/1M out)

Conversación típica de agendamiento: 8 mensajes del cliente, ~1,5 llamadas al LLM por mensaje (algunas con tool
calls), historial promedio de ~600 tokens a mitad de conversación.

```
Input : 8 msgs × 1,5 llamadas × (3.668 + ~600) ≈ 51.200 tokens → $0,0077
Output: 8 msgs × 1,5 llamadas × ~120 tokens    ≈  1.440 tokens → $0,0009
                                                        TOTAL ≈ $0,0086
```

**≈ $0,009 por conversación ≈ ₡4,7.** A 500 conversaciones/mes por cliente: **~$4,30/mes de OpenAI por
cliente.** Es barato y no es tu problema de costos.

**Tu costo dominante es Meta** (cobra por conversación de 24 h, no por mensaje). No lo pude cuantificar desde el
código; verificalo en la tabla de precios de Meta para Costa Rica y modelá tu precio de venta con ese número,
no con el de OpenAI.

Extras medibles:
- **Nota de voz** (whisper-1, $0,006/min): ~$0,003 por audio de 30 s. Despreciable.
- **Foto** (visión, `gpt-4o-mini`): una imagen `detail: high` de 1024×1024 son **~25.000 tokens** en 4o-mini
  → **~$0,004 por foto**, unas 3-5× un turno de texto. No se pasa `detail` (`runAgent.ts:345`), así que usa el
  default alto, y **la imagen va a resolución completa sin redimensionar**.

---

### 🟠 ALTO-15 — El prompt caching de OpenAI está roto por un timestamp con minutos

**Archivo:** `src/agent/systemPrompt.ts:69-78, 91`

```ts
const ahoraTexto = new Intl.DateTimeFormat("es-CR", {
  ..., hour: "2-digit", minute: "2-digit", hour12: false,
}).format(new Date());
// se inserta en `fechaBloque`, cerca del INICIO del system prompt (línea 91)
```

OpenAI cachea automáticamente el **prefijo** de los prompts de más de 1.024 tokens, con **50 % de descuento**
sobre la parte cacheada. Tu system prompt son 1.914 tokens — califica.

Pero como el bloque de fecha/hora **con minutos** está cerca del inicio, el prefijo cambia **cada minuto**, y en
un turno de 4 pasos cada llamada sucesiva también tiene un prefijo distinto si cruza el minuto. **El caché
prácticamente nunca acierta.**

**Qué debería pasar:** dos cambios que no cuestan nada:
1. **Mover el bloque de fecha/hora al FINAL** del system prompt, después de la KB. El prefijo largo y estable
   (reglas + información del negocio) queda cacheable.
2. **Redondear a la hora** en el texto (o dar solo la fecha + una franja "mañana/tarde"). El modelo no necesita
   el minuto exacto para interpretar "mañana a las 3".

Impacto estimado: **~40-45 % menos de costo de input** en conversaciones de más de un turno.

---

### 🟠 ALTO-16 — La base de conocimiento no tiene tope de tamaño: hasta ~17.000 tokens por llamada

**Archivos:** `src/config/validadores.ts:19-22` (`limpiarLineas`) · `:126-137` (`validarFaq`)

```ts
export function limpiarLineas(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(s => String(s ?? "").trim()).filter(Boolean);   // ← sin límite de cantidad ni de largo
}
```

`validarSecciones` sí limita a **12 secciones** (`:162`) y cada FAQ se recorta a 300+1000 caracteres (`:134`),
pero:
- **no hay tope en la cantidad de FAQs**;
- **no hay tope en la cantidad de líneas** de `datos`, `politicas` ni de los `items` de cada sección;
- **no hay tope en el largo de cada línea**.

El único freno real es `MAX_BODY = 64 KB` en el POST (`router.ts:221`). Es decir: un dueño entusiasta que pega
su catálogo completo puede meter **~64 KB de texto ≈ 17.000 tokens en cada llamada al LLM**.

Con 4 pasos de tool-calling eso son ~70.000 tokens de input **por mensaje del cliente** → **~$0,01 por mensaje**,
más de 10× lo normal. Y el dueño lo hace **desde el panel, sin que vos te enteres**, porque no hay
enforcement de uso.

**Qué debería pasar:** límite duro de caracteres totales de la KB (p. ej. 12.000, ~3.200 tokens) validado en
`POST /config`, con un contador visible en la UI de "Mi negocio" tipo "8.240 / 12.000 caracteres". Y mostrarle
al dueño el impacto: "una KB más grande hace las respuestas más lentas y caras".

---

### 🟠 ALTO-17 — Las fotos se guardan como base64 dentro de Postgres

**Archivos:** `src/handleWebhook.ts:204-211` · `src/db/schema.ts:73` (`mediaUrl: text`) ·
`src/booking/drizzleRepository.ts:671-676`

`descargarImagenComoDataUrl` devuelve `data:image/jpeg;base64,…` y se persiste **entero** en la columna
`media_url` de `wa_mensajes`. Una foto de WhatsApp de 3 MB son **~4 MB de texto base64 por fila**.

Tres costos encadenados:
1. **Almacenamiento en Supabase**, que es de los recursos más caros de tu stack. 100 fotos/mes/cliente = 400 MB.
2. **`obtenerConversacionPorId` trae los 100 mensajes con sus `mediaUrl`** (`drizzleRepository.ts:671-676`). Una
   conversación con 10 fotos devuelve un JSON de **40 MB** en una sola respuesta HTTP. El panel se congela y el
   ancho de banda del droplet se dispara.
3. La misma data URL completa se manda a OpenAI sin redimensionar.

**Qué debería pasar:** guardar la imagen en Supabase Storage (o en disco del droplet) y persistir solo la URL.
Como mínimo inmediato: **excluir `mediaUrl` del listado** y servirla por un endpoint aparte
(`GET /api/panel/mensajes/{id}/media`), y redimensionar a ~1024 px antes de mandarla a OpenAI.

---

### 🟡 MEDIO-13 — Otros multiplicadores de costo sin control

| Vector | Archivo | Qué falta |
|---|---|---|
| **No hay tope de uso por plan** | `src/observabilidad/uso.ts` mide, nadie enforcea | El comentario (`:11-14`) dice "medir primero" — decisión válida, pero significa que hoy un cliente Básico puede generar 5.000 conversaciones y vos pagás. Falta al menos una **alerta** al superar el tope del plan. |
| **Sin límite de largo del mensaje entrante** | `src/whatsapp/client.ts:71` | Un cliente que pega 4.000 caracteres los mete en el prompt **y en el historial** de los 20 turnos siguientes. |
| **`MAX_PASOS = 4` reenvía todo** | `src/agent/runAgent.ts:18, 358` | 4× el prompt completo en el peor caso. |
| **Reintentos de la cola** | `src/db/schema.ts:280` (`maxIntentos: 5`) | Un error que sí escapa a `responderEntrante` reintenta 5 veces la llamada completa al LLM. |
| **"hola" cuesta 3.668 tokens** | — | Un short-circuit para saludos/agradecimientos triviales (sin LLM) ahorraría ~15 % de las llamadas. |
| **Visión sin `detail: "low"`** | `src/agent/runAgent.ts:345` | 3-5× el costo de un turno de texto por cada foto. |

---

# 8. Tests

### ✅ Lo que existe (y es bueno)

**162 tests que pasan + 20 E2E de Playwright.** Muy por encima de lo típico. Destacan:

| Área | Archivo | Cobertura |
|---|---|---|
| Aislamiento multi-tenant | `test/tenant/aislamiento.test.ts` | 8 tests, lecturas **y escrituras** cross-tenant |
| Seguridad (sesiones, firma, hashing) | `test/security/seguridad.test.ts` | 24 tests: forjar rol, cambiar tenant, extender expiración, versión de sesión, anti-timing |
| Fiabilidad de colas con Postgres real (PGlite) | `test/reliability/*.test.ts` | 28 tests: claim único, reaper, backoff, concurrencia |
| Webhook end-to-end | `test/e2e-webhook/webhook.test.ts` | 15 tests: dedup por wamid, opt-out, botones, ventana humana, visión |
| Panel (Playwright, Graph mockeado) | `test/e2e-panel/*.spec.ts` | 20 tests: CSRF, guards de rol, CRUD de agenda, responsive |
| Guardrail de drift de migraciones | `scripts/verificarMigraciones.ts` en CI | Cubre la trampa que rompía el deploy en silencio |

---

### 🟠 ALTO-18 — Cero tests del comportamiento del agente, que es el producto

**No existe ningún test de `src/agent/runAgent.ts` ni de `src/agent/systemPrompt.ts`.** Los tests del webhook
mockean `correrAgente` por completo. El corazón del producto — lo que el cliente final realmente experimenta —
no tiene ninguna verificación.

Concretamente, **no hay nada que hubiera detectado** BLOQUEANTE-08 (agendar en el pasado), BLOQUEANTE-09
(horarios pasados) ni ALTO-09 (precio inventado). Los tres son bugs de comportamiento que un cliente ve en
producción.

**Qué debería existir, en orden de valor:**

1. **Tests de guardas de `ejecutarTool`** (sin LLM, invocando `ejecutarTool` directo con args maliciosos). Rápidos,
   deterministas, sin costo:
   - `agendar_cita` con `fecha` de ayer → debe fallar. **(hoy pasa)**
   - `agendar_cita` con hora ya transcurrida hoy → debe fallar. **(hoy pasa)**
   - `agendar_cita` con `precio` distinto al del catálogo → debe usar el del catálogo.
   - `registrar_cotizacion` con monto absurdo → rechazado.
2. **Snapshot del system prompt** por tenant de ejemplo: falla si un cambio inyecta texto de un rubro, rompe el
   orden cacheable, o hace crecer el prompt más de X tokens. Barato y atrapa regresiones de costo.
3. **Evals del agente** (10-15 conversaciones grabadas contra la API real, corridas a mano antes de cada
   release, no en CI): "solo hola", "pide algo fuera de alcance", "pide hablar con una persona", "pregunta un
   precio que no está en la KB", "pide agendar para ayer", "manda 3 mensajes seguidos". Es la única forma de
   detectar regresiones de prompt.

---

### 🟡 MEDIO-14 — Huecos concretos de cobertura

| Hueco | Riesgo asociado |
|---|---|
| No hay test de **ráfaga de 3 mensajes** | BLOQUEANTE-02 pasa sin detección |
| No hay test de `msg.type === "button"`, `location`, `document`, `reaction` | BLOQUEANTE-01, BLOQUEANTE-04 |
| No hay test de **timeout** del LLM ni de head-of-line blocking | BLOQUEANTE-03, ALTO-11 |
| No hay test de que **desactivar un usuario lo saque de su sesión** | ALTO-06 |
| Los E2E del panel corren contra el **repo en memoria**, no Postgres | Divergencias de comportamiento SQL vs. JS invisibles |
| No hay test de que la **config del tenant sobreviva un deploy** | ALTO-08 |
| No hay test de carga / concurrencia multi-tenant | ALTO-11 |
| No hay smoke de **aislamiento de Google Calendar** | Imposible: hoy es global (BLOQUEANTE-05) |

---

# A) BLOQUEANTES para vender

Lo que no podés entregarle a un cliente que paga sin arreglar primero. Ordenados por **riesgo real para vos**,
no por dificultad.

| # | Hallazgo | Archivo | Por qué te hunde | Esfuerzo |
|---|---|---|---|---|
| **1** | **Todos los tenants comparten un Google Calendar** (BLOQ-05) | `calendar/googleCalendar.ts:119,149,167` | **Fuga de datos personales entre clientes**, visible para ellos, en un sistema de terceros. Es el incidente que te cuesta la reputación, no solo el cliente. **Mitigación inmediata (5 min): quitar `GOOGLE_CALENDAR_ID` del `.env` de producción.** | Mitigación: 5 min · Arreglo: 3-4 h |
| **2** | **Ráfaga de mensajes → respuestas incoherentes + aviso de bot 3×** (BLOQ-02) ✅ *verificado* | `handleWebhook.ts:144,148,162` | Probado en el camino de producción: 3 mensajes → 3 respuestas, dos preguntas repetidas y el aviso legal 3 veces. Es el patrón de escritura NORMAL en WhatsApp en CR. Mata la demo el primer día. | 1 día |
| **3** | **Login sin rate limit + `scryptSync` bloqueante** (BLOQ-10) | `panel/auth.ts:63` · `router.ts:711` | DoS trivial, sin credenciales, desde internet, que tumba el webhook de **todos** tus clientes a la vez y puede hacer que Meta te deshabilite. | 3-4 h |
| **4** | **Cero timeouts + worker serial** (BLOQ-03 + ALTO-11) | `runAgent.ts:24,359` · `queue/worker.ts:30` | Una llamada colgada de un cliente congela a todos los demás hasta 30 min. Con 3+ clientes es cuestión de tiempo. | 4-6 h |
| **5** | **Se ofrecen horas ya transcurridas y tocarlas CREA la cita** (BLOQ-09) ✅ *verificado* | `availability.ts:57` · `runAgent.ts:117-138` | Probado: a las 09:24 ofreció 08:00/08:30/09:00 y al tocar "8:00 a.m." creó la cita en `wa_citas`. El dueño ve una cita imposible y el cliente cree que tiene lugar. | 3-4 h |
| **6** | **Plantilla de recordatorio global, no por cliente** (BLOQ-06) | `reminders/scheduler.ts:89,96` | Los recordatorios (la feature que más vende: anti no-show) **no funcionan para el segundo cliente en adelante**, en silencio. | 3-4 h |
| **7** | **Tap en plantilla aprobada cae en "no puedo ver stickers"** (BLOQ-01) | `whatsapp/client.ts:81` | El día que apruebes la plantilla con botones, la confirmación de citas se rompe para todos a la vez. | 2 h |
| **8** | **Health check que no verifica nada** (BLOQ-11) | `server.ts:42-46` | Todo tu monitoreo es decorativo. Un cliente puede estar caído horas con el dashboard en verde. | 3-4 h |
| **9** | **Textos hardcodeados en voseo tico y con emojis de carro** (BLOQ-07) | `handleWebhook.ts:30,420,444,508` · `scheduler.ts:131` | Vendés "motor multi-rubro" y la barbería recibe 🚗. El falso positivo de "persona" escala conversaciones legítimas. | 1 día |
| **10** | **Ubicación / documento / reacción → mensaje equivocado** (BLOQ-04) | `handleWebhook.ts:185-188` | Cotidiano y visible. Responder un sermón a un 👍 es lo que hace que el bot "se sienta tonto". | 4-6 h |
| **11** | **`seedTenants.ts` pisa la config del cliente en cada deploy** (ALTO-08) | `scripts/seedTenants.ts:64-83` · `ci-cd.yml:92` | Destructivo para un cliente que paga: pierde su KB y su clave por un deploy de CSS. Arreglo trivial. | 30 min |
| **12** | **Las sesiones no se revocan** (ALTO-06) | `panel/auth.ts:92` · `router.ts:260` | El primer día que un cliente despida a alguien: "lo saqué y sigue entrando y leyendo todo". | 2-3 h |
| **13** | **Verificar backups + Sentry + uptime en producción** (MEDIO-11, MEDIO-10) | `DEPLOY.md` §16-19 | No pude verificarlo desde el código. "Perdimos tus datos" es terminal. **Verificalo antes de cobrar el primer mes.** | 2 h (verificación) |

**Estimación total del bloque A: 6-9 días de trabajo enfocado.**

Si tuvieras que hacer **solo tres cosas hoy**: (1) quitar `GOOGLE_CALENDAR_ID` del `.env` de producción — 5
minutos, elimina el peor riesgo; (2) los timeouts de OpenAI y fetch — media hora, elimina el peor modo de falla
en cascada; (3) el `onConflictDoNothing` en `seedTenants.ts` — 10 minutos, elimina la pérdida de datos del
cliente.

---

# B) Puede esperar a los primeros clientes

Real, pero no te cuesta un cliente que paga en los primeros 3-6 meses.

### Corto plazo (con los primeros 1-3 clientes en producción)

| # | Hallazgo | Por qué puede esperar |
|---|---|---|
| ALTO-01 | No se lee `context.id` (respuestas citadas) | Degrada la calidad, no rompe nada. |
| ALTO-02 | Los errores transitorios de OpenAI no se reintentan | El cliente recibe una disculpa razonable; con los timeouts arreglados, baja mucho la frecuencia. |
| ALTO-03 | Los recordatorios no chequean la ventana de 24 h | Hoy se manifiesta como ruido en el log; se vuelve visible al activar plantillas. |
| ALTO-10 | Sin retorno automático de modo humano ni horario de atención | Doloroso, pero con 1-3 clientes atentos al panel es manejable. **Subilo a bloqueante en cuanto tengas un cliente que no mire el panel a diario.** |
| ALTO-13 | Logs sin `tenantId` / `conversacionId` | Con 1-2 clientes podés filtrar a ojo. Se vuelve crítico en el 4º. |
| ALTO-15 | Prompt caching roto por el timestamp | Puro costo, no correctitud. **Pero es media hora de trabajo por ~40 % de ahorro** — hacelo apenas puedas. |
| ALTO-16 | KB sin tope de tamaño | Solo explota si un dueño pega un catálogo enorme. Un tope simple lo cierra. |
| ALTO-17 | Fotos en base64 dentro de Postgres | Con volumen bajo no duele. Duele rápido: revisalo al llegar a ~50 fotos/mes. |
| ALTO-18 | Sin tests del agente | Empezá por los tests de guardas de `ejecutarTool` (baratos, deterministas) junto con los arreglos de BLOQ-08/09. `scripts/simulacion/simular.ts` ya cubre el extremo end-to-end; falta el nivel unitario. |
| ALTO-08b (nuevo) | `agendar_cita` no valida fecha pasada aunque el modelo hoy la rechace | Verificado que el prompt aguanta (C2), pero es la única barrera. Arreglalo junto con BLOQ-09: es la misma función. |
| MEDIO-01 | `borrarPushSub` sin filtro de tenant | Una línea. Hacelo cuando toques ese archivo. |
| MEDIO-03 | `.env` con `PANEL_PASSWORD_HASH_ROSALES` | **Verificá el `.env` del droplet ya** — si tiene el nombre viejo, el próximo deploy falla. |
| MEDIO-09 | `npm install` en vez de `npm ci`, sin rollback | Riesgo real pero probabilístico. Media hora. |

### Mediano plazo (con 3-10 clientes)

- **ALTO-04 — RLS en Postgres.** El aislamiento a nivel de app hoy es correcto y está testeado. RLS es la red
  de seguridad para cuando el código crezca más rápido que tu atención. Hacelo antes de sumar un desarrollador.
- **ALTO-05 — `accessToken` obligatorio + ping de verificación en el alta.**
- **ALTO-07 — Capacidad simultánea en la agenda.** Hasta entonces, **vendé solo a negocios de un solo recurso**
  y decilo explícito en la llamada de venta.
- **ALTO-12 — Ajustar el umbral del reaper.** Solo importa cuando pases a 2+ instancias; hacelo *en el mismo
  cambio* que la concurrencia.
- **ALTO-14 — Paginación y exportación de conversaciones.**
- **MEDIO-04 — Historial de 20 mensajes + resumen rodante.**
- **MEDIO-08 — Alerta de token de WhatsApp revocado.**
- **MEDIO-10 — Alertas de cola, jobs en error y tenant en fallback.**
- **MEDIO-12 — Cablear Stripe.** El código ya está escrito; falta la ruta del webhook y la UI. Hacelo cuando el
  cobro manual pase de ~1 h/mes.
- **MEDIO-13 — Enforcement (o al menos alerta) del tope de uso por plan.**

### Backlog / no urgente

- MEDIO-02 — `tenant_id` en el `WHERE` de las escrituras restantes (defensa en profundidad).
- MEDIO-05 — Reemplazar el regex de "fuera de alcance" por una tool explícita.
- MEDIO-06 — Short-circuit para saludos triviales.
- MEDIO-07 — Dead-letter cuando Meta agota reintentos.
- MEDIO-14 — Huecos de cobertura de tests.
- Zona horaria: `new Date(\`${fecha}T12:00:00\`)` en `availability.ts:19` y `scheduler.ts:72` se parsea en la
  hora local del **servidor**, no del tenant. Con servidor en UTC y tenants en América funciona; se rompería
  con un tenant en UTC+13. Irrelevante para tu mercado hoy.
- Política de retención y anonimización de datos de clientes finales (coherencia con `landing/privacidad.html`).

---

## Nota final sobre el ROADMAP

Según `CLAUDE.md`, `ROADMAP.md` es la fuente de verdad y se actualiza en el mismo commit que el trabajo. Esta
auditoría fue **solo lectura** (Fase 1), así que no lo toqué. Cuando ataques estos hallazgos, tres ítems
merecen corrección de estado:

- **C4.3 (Facturación Stripe)** figura como pendiente `[ ]`, lo cual es correcto — pero conviene anotar que el
  módulo `src/billing/stripe.ts` **ya está escrito y desconectado**, para que nadie lo reimplemente.
- **B5 (Observabilidad)** está `[ ]` con "_Done:_ alertas activas y deploy automatizado". El deploy sí está
  automatizado; las alertas cubren excepciones pero no las condiciones de degradación silenciosa (BLOQ-11,
  MEDIO-10).
- Vale la pena abrir una sección nueva — **"Hardening multi-cliente"** — con el bloque A, porque son ítems
  transversales que no encajan en los carriles B/C/D existentes.
