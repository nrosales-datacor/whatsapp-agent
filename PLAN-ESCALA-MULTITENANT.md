# Plan de Ejecución — Escala multi-tenant (de 1 piloto a 50 negocios)

**Fecha:** 2026-08-05 · **Stack:** TypeScript/`node:http` · Drizzle + Postgres (Supabase) · React + TanStack Query (PWA) · Meta Cloud API · OpenAI · Google Calendar

**Origen:** auditoría de arquitectura y multitenancy del 2026-08-05 (rama `hardening-multicliente-carril-e`). Cubre los hallazgos de `AUDIT.md` que **no** entraron al bloque A (y por lo tanto no tienen ítem en el Carril E) más 6 hallazgos nuevos que esa auditoría no había registrado. El estado de cada ítem vive en `ROADMAP.md` → **Carril F**; acá va el detalle ejecutable.

**Objetivo:** que el sistema aguante **50 negocios en paralelo** sin que (a) los datos de uno puedan filtrarse a otro, (b) un cliente ruidoso degrade a los demás, ni (c) sea imposible saber cuánto cuesta y cómo le va a cada uno.

**Regla de oro:** la Fase 0 es lo único bloqueante para vender el cliente **N.º 2**. La Fase 1 es lo que hay que tener antes del cliente **N.º 10**. La Fase 2 es lo que hace falta para **operar** 50 sin quemarse.

> **Lo que este plan NO toca:** el Carril E (E5–E14) y B5/C4.3 ya están en el ROADMAP con su propio detalle en `AUDIT.md`. Acá se los **secuencia** (aparecen en el cronograma integrado) pero no se los renumera ni se repite su especificación. Si un ítem de este plan depende de uno de ellos, se dice explícitamente.

---

## 📅 Cronograma integrado

| Fase | Contenido | Duración | Al finalizar podés… |
|---|---|---|---|
| **0** | Aislamiento real + no perder mensajes + Carril E pendiente | ~17–20 días | Vender el 2.º cliente sin riesgo de incidente de datos |
| **1** | Capacidad: concurrencia, fairness, cuotas, storage | ~16–19 días | Sostener 10–50 tenants sin que uno afecte a otro |
| **2** | Operación: costo por tenant, observabilidad, cobro, offboarding | ~15–18 días | Operar 50 y saber si cada uno deja margen |

**Total ≈ 48–57 días-persona** (~10–12 semanas a una persona; ~6–7 semanas a dos, ver §Paralelización).

---

## 🧭 Estado real del código (leer antes de empezar)

Para que nadie reconstruya lo que ya existe:

- **Aislamiento por aplicación: correcto y probado.** Los 48 métodos de `RepositorioDrizzle` filtran por `tenant_id`; las mutaciones lo llevan **en el WHERE**, no solo en el router. `test/tenant/aislamiento.test.ts` recorre método por método con el tenant equivocado. **No se encontró ninguna ruta de fuga explotable.** Lo que falta es la red de seguridad debajo (RLS) y cerrar 9 escrituras que no reciben `tenantId`.
- **Idempotencia del webhook: sólida.** `wa_message_id` único en `wa_mensajes` y `wa_jobs` + mensaje y job insertados en **una transacción** (`drizzleRepository.ts:509-542`). No hay que rediseñarla.
- **Reintentos: en 3 capas y bien hechos.** Graph API con clasificación de transitorios por status y por código de Meta (`whatsapp/client.ts:259-339`), cola con backoff exponencial y reaper, timeouts explícitos en los 11 `fetch` (E1 ✅).
- **Ruteo de tenant: determinístico.** `phone_number_id` único en DB → `Map` en memoria síncrono, con refresco periódico y on-demand (`config/tenantStore.ts:212, 518`).
- **CI/CD: existe.** `.github/workflows/ci-cd.yml` corre typecheck + 189 tests + guardrail de migraciones + E2E de Playwright + deploy + smoke post-deploy. Lo que falta es `npm ci`, rollback y migraciones online-safe — **no** el pipeline.
- **Colas independientes a propósito** (`db/schema.ts:327-335`): un bug en campañas no puede tocar el pipeline de respuesta. Respetar ese patrón (ver `[[patron-colas-independientes]]`).

**Política de dependencias:** todos los ítems de este plan están diseñados para **cero dependencias npm nuevas** salvo dos, marcados explícitamente (F9 y F14), que además ofrecen una variante sin dependencia. Ver `CLAUDE.md` § Política de dependencias.

---

# FASE 0 — Aislamiento real y cero pérdida de mensajes 🔴 BLOQUEANTE

> Nadie puede vender el segundo cliente con confianza mientras el aislamiento dependa de que ningún desarrollador se olvide de un `and()`, el token de WhatsApp de cada negocio esté en texto plano, y un blip de base de datos haga desaparecer mensajes sin dejar rastro.

## F1 — Row Level Security en las 13 tablas con `tenant_id`

**Severidad: P0.** Corresponde a `AUDIT.md` ALTO-04, que **no tiene ítem en el ROADMAP**.

**Estado real:** cero `ENABLE ROW LEVEL SECURITY` y cero `CREATE POLICY` en las 25 migraciones (verificado por grep sobre `drizzle/`). El propio schema lo deja anotado como pendiente: `src/db/schema.ts:11-13` («agregá políticas RLS en tu flujo `rls/apply.ts`»). La app se conecta con **un solo rol** y sin `SET LOCAL` (`src/db/client.ts:12-17`). Hoy el aislamiento es 100 % aplicación: un `and(eq(tenantId))` olvidado en un método futuro = fuga silenciosa, sin red debajo.

**Trabajo:**

1. **Migración A — `tenant_id` en `wa_mensajes`** (es la única tabla de negocio sin la columna, `schema.ts:57-81`; sin ella no se le puede poner política sin un JOIN):
   - `ALTER TABLE wa_mensajes ADD COLUMN tenant_id text;`
   - Backfill: `UPDATE wa_mensajes m SET tenant_id = c.tenant_id FROM wa_conversaciones c WHERE m.conversacion_id = c.id;` (por lotes si el volumen lo pide).
   - `SET NOT NULL` + índice `(tenant_id, conversacion_id)`.
   - Escribirla en los 2 `INSERT` de mensajes: `drizzleRepository.ts:165-177` y `:519-529`.
2. **Migración B — rol de aplicación dedicado.** Hoy probablemente se usa el rol `postgres` de Supabase, que tiene `BYPASSRLS` y **haría las políticas decorativas**. Crear `app_wa` sin `BYPASSRLS`, con permisos `SELECT/INSERT/UPDATE/DELETE` sobre las tablas `wa_*`, y apuntar `DATABASE_URL` a ese rol. ⚠️ **Decisión abierta D-1** (ver §Decisiones).
3. **Migración C — políticas.** En las 13 tablas con `tenant_id` + `wa_mensajes`:
   ```sql
   ALTER TABLE wa_citas ENABLE ROW LEVEL SECURITY;
   ALTER TABLE wa_citas FORCE ROW LEVEL SECURITY;
   CREATE POLICY tenant_aislado ON wa_citas
     USING (tenant_id = current_setting('app.tenant_id', true))
     WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
   ```
   `wa_tenants` y `wa_usuarios` quedan **fuera** del patrón: las lee el `tenantStore` de forma cross-tenant por diseño (es el registro). Se les da una política aparte o se las deja al rol con acceso completo, documentado.
4. **`SET LOCAL app.tenant_id` por transacción.** Helper `conTenant(db, tenantId, fn)` que abre transacción, hace `SET LOCAL` y ejecuta. Adoptarlo **primero** en las rutas DB-directas (`campaigns/`, `rescate/`), que son las que no pasan por el `Repositorio`.
5. **Escape hatch documentado** para los procesos legítimamente cross-tenant: `tenantStore` (carga el registro), worker de campañas al reclamar (`campaigns/cola.ts:49-56`), scheduler y `listarUsoMensualActual`. Estos usan una conexión sin `app.tenant_id` seteado y con acceso explícito, no un bypass silencioso.

**Aceptación:** un test de fiabilidad (PGlite) que abre una conexión con `app.tenant_id = 'A'` y verifica que un `SELECT * FROM wa_citas` **sin `WHERE`** devuelve solo filas de A; y que un `UPDATE` sobre una fila de B afecta 0 filas. Suite completa en verde. `npm run db:check` sin drift.

**Estimado: 4–5 días.** Sin dependencias nuevas. **Depende de:** confirmar D-1.

---

## F2 — Cifrar el `access_token` de cada WABA en reposo

**Severidad: P0.** Hallazgo **nuevo** (no está en `AUDIT.md`).

**Estado real:** `wa_tenants.access_token` es `text` plano (`schema.ts:190`), escrito en `tenantStore.ts:271` y leído en `client.ts:294` y `:447`. Cero cifrado en todo el repo (grep de `pgcrypto|encrypt|cipher` sin resultados). Lo que **sí** está bien y hay que conservar: el token nunca sale por la API (`router.ts:594-608`) y hay tests E2E que lo verifican (`api.spec.ts:125,134`); el Embedded Signup lo guarda en un stash server-side single-use (`embeddedSignup.ts:134-162`).

**Por qué es P0 a 50 tenants:** un dump, un backup mal guardado o una credencial de Supabase filtrada entrega **la capacidad de enviar WhatsApp suplantando a los 50 negocios**. El daño es reputacional e irreversible, y afecta a clientes que pagan.

**Trabajo:**

1. Módulo nuevo `src/config/secretos.ts` con `cifrar(texto): string` / `descifrar(blob): string` usando **AES-256-GCM de `node:crypto`** (sin dependencias). Formato `v1:<iv_b64>:<tag_b64>:<ciphertext_b64>` — el prefijo de versión permite rotar de algoritmo después.
2. Clave maestra en `TOKENS_ENCRYPTION_KEY` (32 bytes en hex). **Obligatoria si hay `DATABASE_URL`**, con `throw` al arrancar — mismo patrón fail-closed que `PANEL_SESSION_SECRET` (`auth.ts:14-28`). Agregar a `.env.example`.
3. Cifrar en la escritura (`crearTenant`, `seedTenants.ts`) y descifrar **solo** al construir el caché (`filaATenant`, `tenantStore.ts:99`). El resto del código sigue viendo `tenant.accessToken` en claro: **cero cambios** en `whatsapp/client.ts`.
4. Tolerar valores en claro durante la transición (si no matchea `v1:`, se asume claro) + script `scripts/cifrarTokens.ts` idempotente para migrar los existentes. Quitar la tolerancia en un commit posterior.
5. Documentar la rotación de clave en `DEPLOY.md` (re-cifrado con clave vieja → nueva).

**Aceptación:** tras correr el script, `SELECT access_token FROM wa_tenants` no muestra ningún token legible; el bot sigue enviando mensajes; arrancar sin `TOKENS_ENCRYPTION_KEY` con `DATABASE_URL` presente **falla al arrancar** con mensaje claro; tests de ida y vuelta + tolerancia a claro.

**Estimado: 2 días.** Sin dependencias nuevas.

---

## F3 — Ningún mensaje se pierde: ingesta cruda antes de resolver el tenant

**Severidad: P0.** Hallazgo **nuevo** (relacionado con MEDIO-07 pero distinto: MEDIO-07 es «Meta agota sus reintentos», esto es «respondemos 200 y tiramos el mensaje»).

**Estado real:** si el `phone_number_id` no está en el caché, `ingerirEntrante` devuelve `null` tras un `console.warn` (`handleWebhook.ts:95-101`) y el server responde **200** (`server.ts:109-110`). Meta no reintenta. **Ese mensaje desaparece sin quedar persistido en ningún lado.** El escenario realista no es exótico: si la base está caída o vacía al arrancar, `activarFallback()` deja el caché con **un solo** tenant hardcodeado (`tenantStore.ts:177-187`) → durante toda la ventana, los mensajes de los otros 49 negocios se pierden. También aplica a cualquier evento que `parsearEntrante` no sepa leer (`client.ts:61-105`), que es justo lo que arreglan E9 y E12.

**Trabajo:**

1. Tabla `wa_webhooks_crudos`: `id`, `payload jsonb`, `phone_number_id text`, `wa_message_id text` (único, parcial donde no sea null), `recibido_en`, `estado` (`pendiente|procesado|descartado`), `motivo text`.
2. En Fase 1 del webhook, **antes** de resolver el tenant: persistir el payload ya verificado por firma. Es un `INSERT` con `ON CONFLICT DO NOTHING` dentro de la transacción que ya existe — no agrega un viaje extra al camino feliz si se hace en el mismo `db.transaction`.
3. Cuando el tenant **sí** resuelve y el job se encola → marcar `procesado`. Cuando no resuelve → queda `pendiente` con `motivo`.
4. Reproceso: al recargar el caché de tenants (`tenantStore.recargar()`, ya se llama tras cada alta), barrer los `pendiente` cuyo `phone_number_id` ahora **sí** resuelve y encolarlos. Un negocio recién dado de alta recupera los mensajes que llegaron antes de existir.
5. Alerta: si entran > N eventos `pendiente` en una ventana corta → `capturarError` a Sentry. Es la señal temprana de "el caché está en fallback" o "un cliente configuró mal el webhook".
6. Retención: purgar `procesado` > 7 días (se engancha con F11).

**Aceptación:** test de fiabilidad que simula webhook con `pnid` desconocido → 200 + fila `pendiente`; luego se da de alta el tenant, se llama `recargar()` y el mensaje **se procesa y responde**. Cero filas perdidas.

**Estimado: 2 días.** Sin dependencias nuevas. **Sinergia:** cierra también el agujero forense de E9/E12 (los tipos de mensaje aún no soportados quedan guardados en vez de evaporarse).

---

## F4 — Cerrar las escrituras sin `tenant_id` + probar el aislamiento contra Drizzle

**Severidad: P0 (el test) / P3 (las escrituras).** Corresponde a `AUDIT.md` MEDIO-01 y MEDIO-02, **sin ítem en el ROADMAP**.

**Estado real:** el test de aislamiento existe y es bueno, pero **corre contra `RepositorioEnMemoria`** (`test/tenant/aislamiento.test.ts:3`) — y la implementación de producción es la Drizzle. Las escrituras que no reciben `tenantId`:

| Método | Línea | Riesgo hoy |
|---|---|---|
| `borrarPushSub(endpoint)` | `drizzleRepository.ts:905-907` | **el único con superficie real**: el `endpoint` viene del body del operador (`router.ts:1227`) |
| `registrarRespuestaSeguimiento(citaId,…)` | `:472-482` | `citaId` viene de un botón que enviamos nosotros; uuid ajeno no adivinable |
| `guardarMensaje` / `marcarOptIn` / `marcarOptOut` / `actualizarMediaMensaje` | `:161, :193, :200, :181` | reciben `conversacionId` ya resuelto con filtro |
| `guardarGcalEventId` / `marcarRecordatorio` / `reclamarRecordatorio` / `revertirRecordatorio` | `:246, :424, :434, :457` | `citaId` sale de `citasPorFecha(tenant.id, …)` |
| `agregarAddonACita` | `:382-397` | el SELECT filtra por tenant; el UPDATE no |

Ninguna es explotable hoy. Todas se vuelven P0 el día que uno de esos ids llegue de una fuente no validada — que es exactamente lo que pasa cuando el equipo crece.

**Trabajo:**

1. Agregar `tenantId` a la firma en `types.ts` (interfaz `Repositorio`, `:335-548`) y al `WHERE` en **ambas** implementaciones. Empezar por `borrarPushSub`, que es el que tiene superficie real.
2. Actualizar los call sites (`router.ts:1227`, `handleWebhook.ts:464`, `reminders/scheduler.ts`, `booking/gestionCitas.ts`).
3. **Parametrizar `test/tenant/aislamiento.test.ts` sobre las dos implementaciones**: correr la misma batería contra `RepositorioEnMemoria` y contra `RepositorioDrizzle` sobre PGlite (la infraestructura ya existe: `test/helpers/pgliteDb.ts`). Ojo con `filasDe` entre drivers (ver `[[testing-fiabilidad-pglite]]`).
4. Sumar casos para los 9 métodos de arriba.

**Aceptación:** la batería de aislamiento pasa idéntica contra memoria y contra Drizzle/PGlite; ninguna escritura del repositorio acepta un id sin su `tenantId`.

**Estimado: 1,5–2 días.** Sin dependencias nuevas. **Se recomienda hacerlo ANTES que F1**: es la forma barata de descubrir cualquier fuga que RLS después taparía silenciosamente.

---

## F5 — El token global de WhatsApp deja de ser el fallback silencioso

**Severidad: P0 para la marca.** Corresponde a `AUDIT.md` ALTO-05, **sin ítem en el ROADMAP**.

**Estado real:** `const token = tenant.accessToken ?? process.env.WHATSAPP_ACCESS_TOKEN` (`client.ts:294`, y otra vez en `:447`). Un tenant sin token propio manda mensajes **desde el número de prueba de Meta**, no desde el suyo. El cliente lo ve con sus propios ojos y parece un producto roto.

**Trabajo:** mismo patrón fail-closed que ya se usó en E4 para el calendario (`googleCalendar.ts:61-68`): la env global solo aplica al tenant nombrado en `WHATSAPP_ACCESS_TOKEN_TENANT_ID`. Cualquier otro tenant sin token propio **falla con error claro** y queda registrado, nunca redirigido al número de prueba. Agregar el chequeo al health check de E10 y una advertencia visible en `/panel/admin`.

**Aceptación:** un tenant sin `access_token` y sin ser el nombrado en la env no envía nada y produce un error explícito; el piloto sigue funcionando sin cambios de configuración.

**Estimado: 0,5 días.** Sin dependencias nuevas.

---

## Del Carril E, en esta misma fase (ya especificados en `AUDIT.md` + ROADMAP)

Se incluyen en el cronograma porque son bloqueantes de venta y comparten archivos con lo de arriba:

| Ítem | Qué | Est. |
|---|---|---|
| **E5** | Ráfaga de mensajes (releer historial + coalescing por conversación) | 1 d |
| **E6** | `crypto.scrypt` async + rate limit de login | 0,5 d |
| **E8** | Plantilla de recordatorio **por tenant** — sin esto los recordatorios sirven para 1 solo cliente | 1–1,5 d |
| **E9** | Tap en botón de plantilla aprobada (`type: "button"`) | 0,5 d |
| **E10** | Health check que verifique base + estado del caché de tenants | 0,5 d |
| **E11** | Textos del cliente final configurables por tenant | 2–3 d |
| **E12** | Ubicación / documento / contacto / reacción | 1 d |
| **E13** | Revocación de sesiones (revalidar usuario y rol contra el caché) | 0,5 d |

**Fase 0 total: F1–F5 (10–11,5 d) + E5–E13 (7–8,5 d) ≈ 17–20 días.**

---

# FASE 1 — Capacidad: que un cliente no afecte a los demás

> Todo lo de esta fase ataca el mismo patrón: **recursos globales compartidos sin reparto**. Un proceso, un worker serial, un throttle global, un pool por módulo, cero cuotas.

## F6 — Separar procesos `web` y `worker` + líder para los schedulers

**Severidad: P1.** Hallazgo **nuevo** (adyacente a B4, que trata el escalado horizontal).

**Estado real:** un único proceso Node hace webhook + panel + worker de mensajes + worker de campañas + worker de rescate + scheduler de recordatorios + job de reputación (`server.ts:154-172`), bajo **una instancia de PM2** (`.github/workflows/ci-cd.yml`, `pm2 restart whatsapp-bot`). Sin aislamiento de fallos: un pico del panel degrada el webhook, y un `restart` corta a los 50 a la vez.

**Trabajo:**

1. Flags de arranque por variable de entorno: `ROL=web|worker|todo` (default `todo`, para no romper dev ni el piloto). En `server.ts`, condicionar el `listen` y el arranque de cada loop.
2. Dos apps de PM2 (`whatsapp-web`, `whatsapp-worker`), reload sin downtime para la web.
3. **Elección de líder para los schedulers**: recordatorios, reputación y `activarProgramadas` **no** deben correr en N réplicas. Lock advisory de Postgres (`pg_try_advisory_lock`) tomado por el proceso que corre los schedulers, renovado por tick. Sin dependencias nuevas.
   > Los envíos ya son seguros ante duplicados gracias a `reclamarRecordatorio` (claim atómico `UPDATE … WHERE col IS NULL RETURNING`, `drizzleRepository.ts:434-455`) — el líder evita la carga duplicada sobre la DB, no un bug de correctitud.
4. Actualizar `DEPLOY.md` y el job de deploy.

**Aceptación:** `ROL=web` no arranca ningún loop; `ROL=worker` no escucha HTTP; con dos procesos `worker` levantados, los recordatorios se envían **una sola vez**; el deploy reinicia la web sin cortar el worker.

**Estimado: 3 días.** Sin dependencias nuevas. **Habilitado por F7** (si no, N procesos × 5 pools rompe el pooler).

---

## F7 — Un solo pool de Postgres por proceso

**Severidad: P1.** Hallazgo **nuevo**.

**Estado real:** `crearDb()` construye un pool nuevo en cada llamada (`db/client.ts:12-17`) y hay **5 call sites**, cada uno con su lazy singleton: `server.ts:35`, `tenantStore.ts:144`, `uso.ts:21`, `campaigns/db.ts:11`, `rescate/db.ts:9`. Con el `max` por defecto de postgres.js son ~50 conexiones desde **un** proceso. Al multiplicar por réplicas (F6) se choca con el límite del pooler de Supabase → `too many connections` intermitente y dificilísimo de diagnosticar.

**Trabajo:** convertir `crearDb` en un singleton por proceso (`obtenerDb()` en `db/client.ts`) con `max` explícito por env (`DB_POOL_MAX`, default conservador). Los 4 módulos con su propio singleton pasan a usarlo. Mantener la firma con `url` para los tests que inyectan PGlite.

**Aceptación:** `SELECT count(*) FROM pg_stat_activity WHERE application_name = …` estable y acotado bajo carga; los tests de fiabilidad siguen pudiendo inyectar su propia conexión.

**Estimado: 1 día.** Sin dependencias nuevas. **Hacer antes que F6.**

---

## F8 — Fairness por tenant en las colas de campañas y rescate

**Severidad: P1.** Hallazgo **nuevo** (no está en `AUDIT.md`; ALTO-11/E7 cubre solo el worker de mensajes).

**Estado real:**
- **Campañas:** `reclamarEnvio` toma el envío pendiente más viejo **sin repartir por tenant** (`campaigns/cola.ts:49-56`) y el throttle de 1200 ms es **global** (`campaigns/worker.ts:20, 107`). Una campaña de 5.000 destinatarios monopoliza el worker ~100 minutos: las campañas de los otros 49 esperan.
- **Rescate:** `procesarTenant` hace `while (await procesarToque1(tenant)) await dormir(1200)` (`rescate/worker.ts:161-162`) dentro de un `for` sobre `listarTenants()` (`:170-173`). **Drena por completo** un tenant antes de que el siguiente reciba un solo turno.

**Trabajo:**

1. **Claim con reparto:** en `reclamarEnvio`, elegir primero el tenant con envíos pendientes que hace más tiempo no recibe turno (round-robin sobre `tenant_id`, p. ej. `ORDER BY` sobre el `MIN(enviado_en)` por tenant), y recién dentro de ese tenant el envío más viejo. Mantener `FOR UPDATE OF e SKIP LOCKED`.
2. **Throttle por tenant, no global:** el límite de Meta es por número, así que un mapa `tenantId → próximo envío permitido` en memoria es lo correcto y además **más rápido** (dos tenants pueden enviar en paralelo).
3. **Tope por tick en rescate:** cambiar el `while` que drena por un `for` acotado (`RESCATE_MAX_POR_TICK`, default 5) para que el `for` sobre tenants avance siempre.
4. Test de fiabilidad: 2 tenants, uno con 100 envíos y otro con 1 → el segundo se envía dentro de los primeros N turnos, no al final.

**Aceptación:** con un tenant cargado de trabajo, otro tenant recibe servicio en tiempo acotado y demostrable por test.

**Estimado: 2–3 días.** Sin dependencias nuevas.

---

## F9 — Fotos fuera de Postgres

**Severidad: P1.** Corresponde a `AUDIT.md` ALTO-17, **sin ítem en el ROADMAP**.

**Estado real:** la foto se descarga y se guarda como **data URL base64** (`client.ts:475-478`) en `wa_mensajes.media_url text` (`schema.ts:74`), y se devuelve entera en el payload del chat, que trae hasta 100 mensajes (`drizzleRepository.ts:691-696`). Una foto de 4 MB ≈ 5,4 MB de texto por fila; un chat con 10 fotos ≈ 50 MB de JSON. Tabla, backups y RAM del panel se descontrolan. A 50 tenants es el primer costo que se dispara.

**Trabajo:**

1. Subir el binario a **Supabase Storage** (bucket privado, un prefijo por `tenant_id`) por REST con `fetch` — **sin SDK nuevo**, igual que ya se hace con Google Calendar (`calendar/googleCalendar.ts`). ⚠️ **Decisión abierta D-2** si se prefiere S3.
2. `media_url` pasa a guardar la **ruta del objeto**, no los bytes. El panel recibe una **URL firmada de corta vida** generada al servir la conversación.
3. Mantener compatibilidad de lectura con las filas `data:` existentes + script de migración que las suba y reemplace.
4. La visión de OpenAI sigue recibiendo el data URL **en memoria** (`runAgent.ts:509-514`), sin persistirlo — hoy ya es así.

**Aceptación:** una foto nueva no agrega más de ~200 bytes a `wa_mensajes`; el panel la muestra; las fotos viejas se siguen viendo durante la transición; tras el script, `SELECT max(length(media_url))` es pequeño.

**Estimado: 2–3 días.** Sin dependencias nuevas (variante Supabase Storage por REST).

---

## F10 — Cuotas y rate limit por tenant

**Severidad: P1.** Cierra lo que Carril D 0.2 dejó explícitamente abierto («medir sin bloquear»).

**Estado real:** `wa_uso_mensual` mide y **no bloquea**, declarado en `schema.ts:384-391` y `uso.ts:8-16`. **No hay rate limiting en ninguna capa** (grep exhaustivo). El tope de ~500 conversaciones/mes del plan Básico **no existe en código**: se vende un límite que no se aplica. Y un bucle de otro bot contra el webhook consume la cola global y tu `OPENAI_API_KEY` sin freno.

**Trabajo:**

1. **Rate limit de ingesta por tenant**: token bucket en memoria (sin deps), con techo configurable por plan. Al excederse, el mensaje **se persiste igual** (F3) pero se encola con `ejecutar_despues_de` diferido — se degrada la latencia, no se pierde el mensaje.
2. **Enforcement del tope mensual** con degradación amable: al llegar al 80 % → aviso al dueño en el panel; al 100 % → el bot responde un mensaje configurable y escala a humano en vez de llamar al LLM. Nunca silencio.
3. Exponer consumo y tope en `GET /me` y en `/panel/admin` (la columna `conversacionesEsteMes` ya existe, `router.ts:606`).
4. Interruptor por tenant para desactivar el tope (clientes con contrato especial).

**Aceptación:** un tenant Básico que supera el tope recibe la degradación configurada y el dueño lo ve en el panel; un tenant Pro no se ve afectado; el rate limit no descarta mensajes.

**Estimado: 2 días.** Sin dependencias nuevas. **Depende de F3** (para diferir sin perder).

---

## F11 — Retención y DLQ operable de `wa_jobs`

**Severidad: P1.** Hallazgo **nuevo** en su parte de retención; la parte de DLQ corresponde a MEDIO-07.

**Estado real:** **no hay ninguna purga** (grep de `delete|purgar|limpiar|retencion` sobre `src/queue/` y `src/db/`: sin resultados). Cada mensaje de cada tenant deja una fila con el `payload` JSONB **completo** (`schema.ts:314`), para siempre → el índice de claim se degrada y los backups se inflan. Los jobs agotados quedan en `estado='error'` (`cola.ts:105-111`) con un `capturarError` solo en el último intento (`worker.ts:58-60`): **no hay vista, endpoint, alerta por volumen ni reproceso**. Nadie sabe cuántos mensajes quedaron sin responder.

**Trabajo:**

1. Job de purga (dentro del proceso worker, engancha con F6): borrar `hecho` con `finalizado_en` > `JOBS_RETENCION_DIAS` (default 7). Igual para `wa_webhooks_crudos` procesados (F3) y `wa_campania_envios` de campañas completadas.
2. **DLQ visible:** endpoint `/api/panel/admin/dlq` (superadmin) con los jobs en `error` agrupados por tenant, con su `ultimo_error`, y acción de **reencolar**.
3. Alerta cuando la cantidad de `error` de un tenant supera un umbral en una ventana → Sentry.
4. **Alinear reaper con timeouts** (ALTO-12): el reaper reencola a los 180 s (`worker.ts:24`) mientras el turno del agente puede tardar hasta ~20 s × pasos + envíos; con el worker concurrente de E7 hay que revisar que no reencole trabajo que sigue vivo. Documentar la relación entre `QUEUE_REAPER_UMBRAL_SEG` y `OPENAI_TIMEOUT_MS`.

**Aceptación:** `wa_jobs` deja de crecer sin límite (verificable por conteo); un job en `error` se ve en el admin y se puede reencolar; un pico de errores de un tenant genera alerta.

**Estimado: 2 días.** Sin dependencias nuevas.

---

## F12 — Scheduler: guard de re-entrada y concurrencia acotada

**Severidad: P2.** Hallazgo **nuevo**.

**Estado real:** `setInterval(() => tick().catch(...), INTERVALO_MIN * 60 * 1000)` (`reminders/scheduler.ts:223-230`) **sin guard de re-entrada**, y el `tick` recorre `listarTenants()` **en serie** con varias queries y envíos por tenant (`:210-217`). A 50 tenants un tick puede superar los 5 minutos y **solaparse** con el siguiente, apilando carga sobre la DB. Los envíos duplicados están cubiertos por el claim atómico ✅, pero el apilamiento no.

**Trabajo:** flag `corriendo` (o `setTimeout` recursivo, que es más limpio) + procesar tenants con concurrencia acotada (un `mapConLimite` de ~5, escrito a mano, sin deps) + log de duración del tick y advertencia si supera el intervalo. Mismo tratamiento para `reputacion/places.ts`.

**Aceptación:** con 50 tenants simulados, dos ticks nunca se solapan y la duración queda registrada.

**Estimado: 1 día.** Sin dependencias nuevas.

---

## Del Carril E, en esta misma fase

| Ítem | Qué | Est. |
|---|---|---|
| **E7** | Worker concurrente **+ fairness por tenant en el claim** (la cola ya soporta concurrencia; falta el reparto, mismo criterio que F8) | 3–4 d |

**Fase 1 total: F6–F12 (12,5–15 d) + E7 (3–4 d) ≈ 16–19 días.**

---

# FASE 2 — Operar 50 negocios (y saber si dejan margen)

## F13 — Costo de LLM por tenant + tope de la base de conocimiento

**Severidad: P2.** Hallazgo **nuevo** en su parte de atribución; el tope de KB es ALTO-16 y el costo por conversación es MEDIO-06.

**Estado real:** `res.usage` que devuelve OpenAI **se descarta** (`runAgent.ts:533`); grep de `usage|prompt_tokens|completion_tokens` sobre `src/`: **cero resultados**. `wa_uso_mensual` cuenta mensajes, no tokens (`schema.ts:392-409`). Una sola `OPENAI_API_KEY` sin proyectos ni etiquetas por tenant. Y la KB no tiene tope de tamaño (ALTO-16: hasta ~17.000 tokens por llamada), así que un tenant puede consumir 20× el promedio de forma invisible.

**Por qué importa comercialmente:** hoy **no podés responder** «¿este cliente de ₡35.000/mes me deja margen?». Fijar precio para 50 tenants es a ciegas.

**Trabajo:**

1. Columnas `tokens_entrada`, `tokens_salida`, `costo_estimado` en `wa_uso_mensual`, incrementadas con el mismo `ON CONFLICT DO UPDATE SET x = x + n` que ya usa `incrementarUso` (`uso.ts:45-77`).
2. Leer `res.usage` en el loop del agente (`runAgent.ts:526-534`) y sumar por paso; incluir Whisper (`whatsapp/transcribir.ts`). Tarifas por modelo en una tabla de constantes, por env para poder actualizarlas sin deploy.
3. Exponer costo por tenant en `/panel/admin` junto a `conversacionesEsteMes`.
4. **Tope de KB** (ALTO-16): límite de caracteres validado en `config/validadores.ts` al guardar «Mi negocio», con aviso al dueño de cuánto ocupa su base de conocimiento.
5. Opcional barato: revisar el prompt caching roto por el timestamp con minutos (ALTO-15) — el ahorro es directo.

**Aceptación:** el admin muestra tokens y costo estimado del mes por negocio; guardar una KB gigante rebota con mensaje claro.

**Estimado: 2–2,5 días.** Sin dependencias nuevas.

---

## F14 — Observabilidad por tenant (extiende B5)

**Severidad: P2.** Corresponde a ALTO-13 y **completa B5**, que hoy define métricas sin dimensión de tenant.

**Estado real:** Sentry solo captura errores, `tracesSampleRate: 0` (`sentry.ts:26-33`). Las métricas son 3 contadores **globales en memoria** volcados a `console.log` cada 5 minutos (`metricas.ts:22-24, 46-61`): se pierden en cada restart, no tienen `tenantId`, no hay serie temporal ni alertas. Los logs son `console.log` sueltos sin correlación (`handleWebhook.ts` passim). No podés reconstruir el reclamo de un cliente.

> ⚠️ **Efecto colateral no obvio que hay que conservar:** `Sentry.init()` registra el handler de `unhandledRejection`, que evita que un rechazo sin manejar tumbe el proceso de **los 50 tenants** (`sentry.ts:5-18`). Es decir: **sin `SENTRY_DSN` el sistema es más frágil**. Al tocar esta área, no perder ese comportamiento.

**Trabajo:**

1. Logger estructurado propio (JSON a stdout, sin deps): `log.info({ tenantId, conversacionId, jobId, evento })`. Reemplazar los `console.log` del hot path.
2. **Correlation id** generado en la ingesta y propagado por el `payload` del job hasta el envío — es lo que permite reconstruir «qué pasó con el mensaje de este cliente a las 3pm».
3. Métricas con dimensión de tenant, persistidas (tabla o backend externo) en vez de memoria volátil. ⚠️ **Decisión abierta D-3** (backend de métricas; la opción sin dependencia es exponer `/metricas` en formato Prometheus y que un agente externo lo raspe).
4. Alertas por SLO: profundidad de cola, tasa de error por tenant, jobs en DLQ, latencia p95 del turno.

**Aceptación:** dado un número de cliente y una hora, se puede reconstruir la traza completa desde los logs; existe una alerta que dispara antes de que el cliente reclame.

**Estimado: 4–5 días.** Posible dependencia nueva según D-3.

---

## F15 — Config del tenant versionada y auditada

**Severidad: P2.** Hallazgo **nuevo**.

**Estado real:** `actualizarConfigTenant` es un `UPDATE` **destructivo** de blobs JSONB completos (`tenantStore.ts:340-369`). No hay historial, ni quién cambió qué, ni rollback. A 50 clientes, «el bot empezó a decir otra cosa y nadie sabe quién lo tocó» es imposible de responder — y ya hubo un precedente cercano con `seedTenants` pisando config (E2 ✅).

**Trabajo:** tabla `wa_tenants_historial` (`tenant_id`, `snapshot jsonb`, `usuario_id`, `creado_en`), escrita **en la misma transacción** que el `UPDATE`. Pestaña «Historial» en Mi negocio con diff legible y botón de restaurar (solo dueño). Retención de N versiones.

**Aceptación:** guardar «Mi negocio» crea una versión; se puede ver quién la hizo y restaurarla.

**Estimado: 2 días.** Sin dependencias nuevas.

---

## F16 — Offboarding de tenant y export de datos

**Severidad: P2/P3.** Hallazgo **nuevo**.

**Estado real:** **ningún `tenant_id` es FK** salvo `wa_usuarios.tenant_id` (`schema.ts:183-185, 275-277`), así que no hay cascada. Borrar un negocio que se va deja conversaciones, citas, mensajes, cotizaciones y snapshots huérfanos. Un pedido de «borrá mis datos» se atiende a mano, tabla por tabla — y a 50 clientes con rotación eso pasa.

**Trabajo:** script/endpoint transaccional de baja que recorra las 14 tablas en orden de dependencia, con confirmación explícita y export previo (JSON/CSV) de los datos del negocio. Alternativa complementaria: FKs con `ON DELETE CASCADE` donde el volumen lo permita. Documentar en `DEPLOY.md`.

**Aceptación:** dar de baja un tenant de prueba deja 0 filas suyas en las 14 tablas y produce un export descargable.

**Estimado: 1,5 días.** Sin dependencias nuevas.

---

## F17 — Deploy: `npm ci`, rollback y migraciones online-safe

**Severidad: P2.** Corresponde a MEDIO-09, **sin ítem en el ROADMAP**.

**Estado real:** el pipeline **existe y es bueno** (`.github/workflows/ci-cd.yml`: typecheck + 189 tests + `db:check` + E2E + deploy + smoke de 3 superficies). Los huecos concretos: usa `npm install` en el droplet (no `npm ci`, o sea build no reproducible y riesgo de supply chain), **no tiene rollback**, y `npx tsx scripts/migrar.ts` corre antes del restart sin estrategia expand/contract. Ya está documentado en memoria que tocar el schema sin generar la migración **rompe todo el deploy en silencio** porque `seedTenants` aborta antes del `pm2 restart` (ver `[[deploy-migracion-obligatoria]]`).

**Trabajo:** `npm ci` en el droplet; guardar el SHA anterior y agregar un job de rollback (revert + restart) disparable a mano; protocolo expand/contract documentado para migraciones (agregar columna → desplegar código que la escribe → backfill → hacerla obligatoria), que es justo lo que exigen F1 y F9; y con F6, reload sin downtime de la web.

**Aceptación:** un deploy fallido se revierte con una acción; una migración de columna se aplica sin downtime siguiendo el protocolo.

**Estimado: 2–3 días.** Sin dependencias nuevas.

---

## Del Carril D/C, en esta misma fase

| Ítem | Qué | Est. |
|---|---|---|
| **C4.3** | **Cablear Stripe.** `src/billing/stripe.ts` (114 líneas) **no lo importa ningún archivo** — verificado por grep. No hay ruta de Checkout ni webhook en `panel/router.ts`, y `.env.example` no declara ninguna `STRIPE_*`. El cobro es 100 % manual (`PROCESO-COBRO-MANUAL.md`). Con 50 clientes, cobrar a mano no escala | 3–4 d |

**Fase 2 total: F13–F17 (11,5–14 d) + C4.3 (3–4 d) ≈ 15–18 días.**

---

## 🔗 Camino crítico y dependencias

```
F4 (aislamiento probado vs Drizzle)  ──►  F1 (RLS)
   « hacer F4 primero: barato, y descubre fugas que RLS taparía en silencio »

F7 (pool único)  ──►  F6 (separar web/worker)  ──►  E7 (worker concurrente)
   « sin F7, N procesos × 5 pools revientan el pooler de Supabase »

F3 (ingesta cruda)  ──►  F10 (cuotas: diferir sin perder mensajes)

F17 (expand/contract)  ──►  migraciones grandes de F1 y F9

B5 ──► F14 (observabilidad por tenant extiende B5, no lo reemplaza)
```

**Si solo se pueden hacer 5 cosas antes del cliente N.º 2:** F4 → F1 → F2 → F3 → **E8**.
(E8 es el que menos parece de arquitectura y es el más urgente comercialmente: con la plantilla de recordatorio global, los recordatorios —la feature que más ve el dueño— **funcionan para un solo cliente**.)

## 👥 Paralelización (si hay dos personas)

- **Pista A (datos/seguridad):** F4 → F1 → F2 → F15 → F16
- **Pista B (capacidad/operación):** F7 → F6 → F8 → E7 → F11 → F12
- **Cruce obligado:** F3 y F10 tocan el webhook, que también toca E5 → coordinar o serializar.

---

## ⚠️ Decisiones abiertas (necesitan respuesta antes de arrancar el ítem)

**D-1 · Rol de base de datos para RLS (bloquea F1).** No pude determinar desde el repo con qué rol se conecta producción. Si es el `postgres` de Supabase, tiene `BYPASSRLS` y **las políticas serían decorativas**. Hay que crear un rol `app_wa` sin `BYPASSRLS` y repuntar `DATABASE_URL`. Requiere confirmar que el pooler y las migraciones sigan funcionando con ese rol.

**D-2 · Object storage para las fotos (afecta F9).** Supabase Storage por REST (sin dependencia nueva, misma cuenta ya contratada) vs. S3/R2 (requiere SDK o firmar a mano). Recomiendo Supabase Storage por la política de dependencias.

**D-3 · Backend de métricas (afecta F14).** Opción sin dependencia: exponer `/metricas` en formato Prometheus y raspar desde afuera. Cualquier alternativa con SDK debe pasar las 3 reglas de `CLAUDE.md`.

**D-4 · Alcance del tope del plan Básico (afecta F10).** ¿El tope de ~500 conversaciones/mes se aplica de verdad, se avisa y no se corta, o se cobra el excedente? Es decisión comercial, no técnica, y cambia el trabajo.

---

## ❓ Lo que no se pudo verificar desde el repo

Para no construir sobre supuestos (varios de estos también los lista `AUDIT.md` §«Lo que NO pude determinar»):

1. Si producción tiene aplicadas las 25 migraciones (el ROADMAP lo marca como no verificado).
2. Si el cron de backups corre en el droplet y si el restore se probó alguna vez → es **E14**, y es requisito para tocar el schema en F1/F9.
3. Cuántos tenants hay hoy en producción (el código soporta N; todo indica que el piloto real es 1).
4. Qué variables de entorno están efectivamente seteadas en el droplet: de eso depende si Sentry, Calendar, Push y las plantillas están activos o son no-op.
5. Los límites reales del pooler de Supabase contratado → necesarios para dimensionar `DB_POOL_MAX` en F7.
6. Throughput y latencia medidos: no hay tests de carga ni histórico (las métricas se pierden en cada restart), así que el techo de «12–30 msg/min» citado en el ROADMAP no está verificado de forma independiente.
7. Si el panel React (`web/`) tiene alguna suposición de tenant único: se revisó la API que consume, no el árbol de componentes completo.

---

## ✅ Definición de «listo para 50 tenants»

Se considera cerrado este plan cuando:

- [ ] Un `SELECT` sin `WHERE` sobre cualquier tabla `wa_*` devuelve solo filas del tenant de la sesión (F1).
- [ ] Ningún secreto de cliente está en texto plano en la base (F2).
- [ ] Ningún mensaje entrante puede desaparecer sin dejar fila (F3).
- [ ] La batería de aislamiento corre contra la implementación **de producción** (F4).
- [ ] Un tenant con 5.000 envíos en cola no retrasa a otro más de N minutos, demostrado por test (F8, E7).
- [ ] `wa_jobs` no crece indefinidamente y los mensajes fallidos son visibles y reencolables (F11).
- [ ] Se puede responder, por negocio y por mes: cuántas conversaciones, cuántos tokens, cuánto costó (F13).
- [ ] Dado un teléfono y una hora, se reconstruye la traza completa desde los logs (F14).
- [ ] Dar de baja un cliente es un procedimiento, no una arqueología (F16).
