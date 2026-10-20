# Plan — Reestructura a software de gestión para negocios con cita

**Fecha:** 2026-10-19 · **Estado:** acordado; solo falta elegir el nombre del producto (§8) · **ROADMAP:** Carril I

**Objetivo:** dejar de ser "un agente de WhatsApp con panel" y pasar a ser un **software de gestión para negocios de
servicios con cita** (dentistas, estética, uñas y similares), multi-sucursal, donde **WhatsApp IA es un módulo más**.

---

## 0. Decisiones tomadas

| Tema | Decisión |
|---|---|
| Rubros | Genérico: un núcleo común + **plantillas de rubro** (datos, no código). Ver §3. |
| Planes | **Básico** = el agente de WhatsApp (responde, agenda) + Inicio básico. **Pro** = gestión completa (CRM, cobros, comisiones, reportes, sucursales). Pro también se vende sin agente. Ver §5. |
| Historia clínica | No. Solo notas. |
| Sucursales | Sí, desde el día 1 en el modelo (en el plan Pro). |
| Cobros | Lo más simple: **registrar** pagos y señas. Sin cobro en línea ni factura electrónica (después se ve). |
| Recordatorios | Por **WhatsApp**, con opción de **correo** para el cliente que no quiera WhatsApp. |
| Profesionales | Cada uno entra con su usuario. Se calculan **comisiones sobre lo cobrado**. |
| Estados de cliente | Umbrales **configurables** por negocio. |
| Lavacar | Se elimina. **No hay nada en producción**: esquema base nuevo, sin migrar datos. |
| Repo | Este mismo (conserva historia, CI y secretos). |
| Idioma del código | Identificadores en **inglés** (clases, funciones, variables, archivos, tablas, columnas, rutas). Comentarios, docs, commits y UI en español. Ver §2. |
| Nombres | Las tablas pierden el prefijo `wa_`. El nombre del producto **no vive en el esquema** (así un cambio de marca nunca toca la base). Nombre: ver §8. |

---

## 1. Veredicto de arquitectura

**La plataforma sirve; el modelo de dominio no.** Se conserva la plataforma y se rehace el dominio sobre un esquema
nuevo desde cero (una migración base). No se reescribe todo: lo que costó llegar a producción se queda.

### Se conserva

| Pieza | Dónde | Por qué sirve |
|---|---|---|
| Stack: TS + Node 24 + Postgres/Supabase + Drizzle + React/Vite/React Query/PWA | — | Nada del modelo nuevo pide otro stack. `react-router-dom` ya está instalado. |
| Multi-tenant con RLS por negocio (`conTenant`/`conSistema`) | `src/db/alcance.ts` | Es el modelo correcto para SaaS de pymes; se extiende, no se cambia. |
| Colas durables en Postgres, leases de liderazgo, separación web/worker | `src/queue`, `src/red/liderazgo.ts` | Escalan a cientos de negocios sin Redis. |
| Red y seguridad: timeouts, topes de cuerpo, rate limit, cabeceras, CSRF, apagado ordenado, scrypt, session epoch, TOTP | `src/red`, `src/panel/{auth,totp,rateLimitLogin}` | No dependen del rubro y están probados. |
| Observabilidad: log JSON, Sentry, métricas por tenant, alertas, costo LLM | `src/observabilidad` | Base de lo "medible". |
| Cliente de WhatsApp, ingesta idempotente, ráfagas, ventana de 24 h, transcripción | `src/whatsapp`, `src/queue/cola.ts`, pipeline de `handleWebhook` | Pasa entero al módulo WhatsApp IA. |
| Motor del agente (bucle de tools, prompt multi-mercado, prompt caching) | `src/agent` | Pasa al módulo; cambian las tools. |
| Deploy/CI, backups y restore, PGlite en tests, E2E con Playwright | `.github`, `scripts`, `test/helpers` | Se reusan tal cual. |

### Se rehace

| Hoy | Por qué no sirve para gestión | Cambio |
|---|---|---|
| Servicios, empleados, horario y bloqueos como JSONB dentro de `wa_tenants` | Sin FK: no se puede sumar ingresos por profesional o servicio en SQL, renombrar rompe el histórico, no hay integridad (pendiente H12). | Tablas normalizadas con FK. |
| Caché en memoria de **todos** los negocios y usuarios, recargado cada 60 s en cada proceso (`tenantStore.ts`) | Crece con negocios × sucursales × profesionales; web y worker ven config distinta hasta 60 s; el login depende del caché. | Caché solo para el ruteo del webhook (`phone_number_id → negocio`) y config por negocio bajo demanda con TTL corto. Login contra la base. |
| El cliente es el teléfono de WhatsApp (`wa_conversaciones.cliente_wa`) | Sin WhatsApp no hay cliente; la ficha solo se abre desde un chat. | `clientes` como entidad raíz; la conversación pertenece al módulo WhatsApp. |
| Un `Repositorio` con ~90 métodos y un `types.ts` de 1 000 líneas, organizados por capa técnica | Cada módulo nuevo engorda los mismos archivos; no hay frontera entre el núcleo y WhatsApp. | Módulos por dominio con reglas de dependencia (§2). |
| Reglas de reserva duplicadas: el agente (`runAgent.ts`) y la ruta del panel (`rutas/agenda.ts`) arman cada uno su validación | Con sucursales, horario por profesional, buffers y varios servicios por cita, dos copias divergen. | Un solo servicio `appointments.book()` para panel, agente y rescate. |
| Router a mano (`ruta === "citas" && metodo === "POST"`) y validación de cuerpo a mano | Con ~100 endpoints y permisos por rol × sucursal × módulo, tarde o temprano una ruta se queda sin chequeo. | Router declarativo (§2). |
| Fecha y hora como texto, índice único de hora exacta + advisory lock | No detecta solapes parciales (lo dice el comentario de `schema.ts`). | `inicio`/`fin` `timestamptz` + `EXCLUDE USING gist` por profesional (`btree_gist`; PGlite lo trae en `contrib`). |
| Montos enteros en unidades | USD 45,50 no entra. | `bigint` en céntimos en todo (mismo criterio que `costo_estimado_millonesimos`). |
| Métricas calculadas en memoria trayendo todas las citas, sin rango | No escala ni sirve para reportes por período. | Agregados SQL con rango e índices; rollups diarios cuando haga falta. |
| Restos de lavacar (`placa`, tenant de respaldo hardcodeado) | — | Se borran. |

**Por qué ahora y desde cero:** no hay datos que preservar, así que un esquema base nuevo cuesta menos que ~40
migraciones expand/contract para renombrar y normalizar. Lo que **no** se reescribe es la plataforma: ahí están los
arreglos más caros (ráfagas H1, idempotencia, RLS, apagado ordenado).

---

## 2. Arquitectura objetivo

**Idioma del código:** identificadores en **inglés** (carpetas, archivos, clases, funciones, variables, tablas,
columnas, valores de enums, rutas de la API, nombres de las tools del agente). Comentarios, documentación, commits y
textos de la UI siguen en **español (es-CR)**. La plataforma que se conserva se traduce al portarla (p. ej.
`conTenant` → `withTenant`, `iniciarWorker` → `startWorker`).

```
src/
  platform/     http (router declarativo, sesión, permisos, validación), db (cliente, alcance RLS),
                queue, net, observability, email, storage
  modules/
    business/     negocios, sucursales, plantillas de rubro, campos personalizados, terminología
    team/         usuarios, membresías y roles, profesionales, horarios, ausencias
    catalog/      categorías, servicios, precio/duración por profesional y sucursal
    clients/      clientes, estados, importación CSV
    scheduling/   citas, disponibilidad, recordatorios
    sales/        métodos de pago, pagos, resumen del día
    commissions/  reglas, movimientos, liquidaciones
    reports/      consultas agregadas (solo lectura)
    whatsapp/     canales, conversaciones, mensajes, webhook, agente IA, bandeja, rescate, reseñas
    campaigns/
    billing/      planes, módulos, límites, Stripe
  admin/        superadmin
web/src/
  app/          rutas, layout, sesión, selector de sucursal
  modules/      mismos nombres que el backend
  ui/           componentes compartidos
```

**Reglas de dependencia**
- Cada módulo es dueño de sus tablas. Otro módulo lo usa por sus funciones de servicio, nunca leyendo sus tablas.
- El núcleo (`business`, `team`, `catalog`, `clients`, `scheduling`, `sales`, `commissions`) no importa nada de
  `whatsapp`, `campaigns` ni `billing`. Un test lo verifica, igual que `test/security/rls.test.ts` verifica RLS.
- Panel y agente llaman los mismos servicios (`availability.findSlots()`, `appointments.book()`,
  `clients.findOrCreate()`).
- Efectos internos (completar cita → comisión y caché del cliente) en la misma transacción. Efectos externos
  (WhatsApp, Google Calendar, correo) siempre por la cola.

**Router declarativo, sin framework.** Cada ruta declara método, ruta, roles, módulo del plan y esquema del cuerpo; el
router aplica sesión, CSRF, rol, acceso a la sucursal, módulo y validación antes del handler:

```ts
route({ method: "POST", path: "/appointments/:id/payments", roles: ["owner", "admin", "front_desk"], module: "sales", body: PaymentInput }, recordPayment)
```

- Validación con **Zod** (cumple la política de dependencias; fijar una versión con más de un mes). Los mismos esquemas
  tipan `web/src/api`, que hoy son 722 líneas escritas a mano.
- Se descartó Fastify/Hono: obligaría a rehacer cabeceras, límites, apagado y sus tests; el router son ~200 líneas.
- Se mantiene el prefijo `/api/panel/*` (la costura de `CLAUDE.md`), con recursos en inglés (`/appointments`,
  `/clients`, `/payments`, `/reports/*`, `/whatsapp/*`).

**Sucursal y permisos.** RLS sigue por negocio (`business_id`). La sucursal es un permiso de aplicación: cada request
indica la sucursal y el router valida que el usuario tenga acceso.

**Acceso fácil.** Login por email, invitación por correo para cada profesional, recuperación de clave por correo, PWA
(ya existe) y 2FA opcional para dueños. El envío de correo es un módulo de plataforma (`platform/email`, API HTTP de un
proveedor vía `fetch`, sin SDK nuevo) que también usan los recordatorios por correo.

**Medible.**
- Para el negocio: Reportes (§4 y §7).
- Para vos: `daily_usage(business_id, date, metric, value)` generaliza `wa_uso_mensual` (citas creadas, pagos
  registrados, usuarios activos, conversaciones IA, costo LLM) para medir activación y retención en el superadmin.

---

## 3. Modelo genérico multi-rubro

| Opción | Cómo | Veredicto |
|---|---|---|
| A. Un producto por rubro | Campos y pantallas propios de dental, estética, uñas | No: triplica el mantenimiento. |
| **B. Núcleo común + plantillas de rubro + campos personalizados** | Mismas tablas para todos; el rubro solo precarga datos | **Elegida.** |
| C. Esquema 100 % dinámico | El negocio define sus propias entidades | No: mucha complejidad sin retorno. |

**Cómo funciona B**
- **Núcleo universal:** negocio → sucursales → profesionales → servicios → clientes → citas → pagos → comisiones.
- **Plantilla de rubro:** un JSON en el repo (`src/modules/business/templates/dental.json`, `aesthetics.json`,
  `nails.json`, `generic.json`). Al crear el negocio precarga categorías y servicios de ejemplo (duración, buffer),
  terminología, campos personalizados, reglas de estado de cliente, instrucciones base del agente y textos de
  recordatorio. Sumar un rubro es sumar un JSON, sin código.
- **Terminología:** un diccionario corto por negocio para la UI y el agente (`cliente`/`paciente`,
  `profesional`/`especialista`/`estilista`, `cita`/`turno`).
- **Campos personalizados** para cliente y cita: definiciones en `custom_fields`, valores en `custom_data jsonb`
  validados contra la definición. Ejemplos: dental "alergias", estética "tipo de piel", uñas "forma preferida".
- **Lo que el núcleo ya cubre de cada rubro:** varios servicios en una cita (mani + pedi), buffer de limpieza entre citas
  (dental, estética), precio y duración por profesional (senior vs. junior), responsable de un menor (dental).
- **Fuera de v1, pero el modelo los deja entrar sin romper:** recursos físicos (sillón, cabina, equipo láser), paquetes
  de sesiones (estética), venta de productos.

---

## 4. Modelo de datos

Convenciones: sin prefijo, **nombres en inglés** (tablas en plural, `snake_case`), `id` uuid, `business_id` y política
RLS en toda tabla de negocio, montos `bigint` en céntimos (`*_cents`), instantes `timestamptz`, horarios semanales
como `weekday` + `time`, `created_at`/`updated_at`.

| Módulo | Tabla | Columnas clave |
|---|---|---|
| business | `businesses` | slug, name, industry, plan, extra_modules, status, currency, country, terminology, client_status_rules, reminder_channels, branding, datos de facturación |
| | `locations` | business_id, name, address, phone, timezone, active |
| | `location_hours` | location_id, weekday, opens_at, closes_at (varias filas por día = descansos) |
| | `time_off` | business_id, location_id?, staff_id?, starts_at, ends_at, reason (feriados, vacaciones e incapacidades en una sola tabla) |
| | `custom_fields` | business_id, entity (client/appointment), key, label, type, options, required, position |
| team | `users` | email (único), name, password_hash, totp_secret, session_epoch, active |
| | `memberships` | user_id, business_id, role (owner/admin/front_desk/staff), active |
| | `membership_locations` | membership_id, location_id (sin filas = todas) |
| | `staff` | business_id, membership_id? (puede existir sin usuario), name, color, active |
| | `staff_hours` | staff_id, location_id, weekday, starts_at, ends_at (lunes en una sucursal, martes en otra) |
| catalog | `service_categories` | business_id, name, position |
| | `services` | category_id, name, description, duration_min, buffer_min, price_cents, variable_price, online_booking, active, position |
| | `service_locations` | service_id, location_id |
| | `staff_services` | staff_id, service_id, price_cents?, duration_min? |
| clients | `clients` | business_id, name, phone (E.164, único por negocio), email, birth_date, guardian_id?, notes, tags, source, custom_data, preferred_location_id, preferred_staff_id, preferred_channel (whatsapp/email), marketing_consent_at, marketing_opt_out_at; caché: visit_count, first_visit_at, last_visit_at, total_spent_cents |
| scheduling | `appointments` | business_id, location_id, client_id, staff_id, starts_at, ends_at, status (pending/confirmed/completed/cancelled/no_show), channel (whatsapp_ai/panel/phone/walk_in/web), total_cents, notes, custom_data, created_by, confirmed_at, cancellation_reason · `EXCLUDE` por profesional y rango |
| | `appointment_services` | appointment_id, service_id, name (copia), duration_min, price_cents (copia), position — reemplaza `servicio_id` + `addons` |
| | `reminders` | appointment_id, kind, channel (whatsapp/email), scheduled_for, sent_at, status |
| sales | `payment_methods` | business_id, name, active, position (precargados: efectivo, SINPE, tarjeta, transferencia) |
| | `payments` | business_id, location_id, client_id, appointment_id?, kind (deposit/payment/refund), amount_cents, payment_method_id, recorded_by, note |
| commissions | `commission_rules` | business_id, staff_id?, service_id?, category_id?, kind (percent/fixed), value |
| | `commission_entries` | staff_id, appointment_service_id, base_cents, amount_cents, rule (copia), status (pending/paid), payout_id |
| | `payouts` | staff_id, period_start, period_end, total_cents, paid_at, paid_by |
| whatsapp | `whatsapp_channels` | business_id, location_id? (vacío = todas), phone_number_id (único), token cifrado, templates, status |
| | `ai_settings` | business_id, tone, register, instructions, knowledge, faq, texts, quote_recovery |
| | `conversations`, `messages`, `quotes`, `follow_ups`, `ai_usage_monthly` | lo de hoy, con `client_id` y `channel_id` |
| campaigns | `campaigns`, `campaign_sends` | lo de hoy, con `client_id` |
| platform | `jobs`, `raw_webhooks`, `leader_leases`, `audit_log`, `config_history`, `push_subscriptions`, `daily_usage` | lo de hoy, renombrado |

**Reglas de negocio que salen del modelo**
- **Estado del cliente** (`new` / `active` / `vip` / `at_risk` / `inactive`): se calcula al consultar, desde la caché
  de `clients` y `businesses.client_status_rules`. No se guarda. Etiqueta VIP manual opcional.
- **Saldo de una cita** = `appointments.total_cents − payments`. **Pendientes** = completadas con saldo > 0.
  **Caja** = resumen del día por método (sin apertura ni cierre en v1).
- **Comisión:** se genera al completar la cita, por línea de servicio, sobre lo cobrado. Gana la regla más
  específica: profesional + servicio → servicio → categoría → profesional → regla general del negocio.
- **WhatsApp por sucursal:** un número puede atender todas las sucursales (el agente pregunta cuál) o una sola.
- **Canal del recordatorio:** el preferido del cliente si el negocio lo tiene activo; si no, el default del negocio.
  Correo solo si el cliente tiene email; WhatsApp solo si el negocio tiene un número conectado. Así el Pro sin agente
  puede funcionar incluso sin conectar WhatsApp.

---

## 5. Planes

Dos planes. El **Básico** es el agente de WhatsApp con lo mínimo para operar alrededor de él; el **Pro** es el software
de gestión completo. El Pro se puede contratar **sin agente** para quien no quiere el bot (cubre la venta sin IA).

| | **Básico** — el agente de WhatsApp | **Pro** — gestión completa |
|---|---|---|
| Agente IA de WhatsApp | Responde preguntas (servicios, precios, horarios, ubicación, políticas), agenda, reprograma y cancela, consulta la cita del cliente, entiende audios y fotos, pasa a una persona cuando hace falta | Igual (o sin agente, a menor precio) |
| Bandeja | Ver conversaciones, tomar el control, responder | Igual |
| Recordatorios y confirmación | WhatsApp o correo | WhatsApp o correo |
| Inicio | **Básico:** citas de hoy y próximas, sin confirmar, conversaciones esperando a una persona, citas que agendó el bot esta semana | **Completo:** + cobrado hoy, clientes nuevos, no-show, clientes en riesgo, gráfico de ingresos |
| Agenda | Día y semana, por profesional; crear, mover y cancelar | Igual + varias sucursales |
| Equipo | Profesionales con su horario (el agente los necesita para agendar bien); 2 usuarios (dueño y recepción) | Usuario propio por profesional, roles, "Mi agenda" |
| Clientes | Ficha automática: nombre, teléfono, historial de citas y notas | CRM: estados configurables, visitas, gasto total, campos personalizados, etiquetas, filtros, importar CSV |
| Ventas y cobros | — | Pagos, señas, métodos de pago, pendientes, resumen del día |
| Comisiones | — | Reglas, cálculo sobre lo cobrado, liquidaciones, "Mis comisiones" |
| Reportes | Métricas básicas del agente (conversaciones, citas agendadas por el bot) | Servicios, profesionales, canales, ingresos, ocupación, export CSV + métricas completas del agente |
| Crecimiento | — | Campañas, rescate de cotizaciones, upsell, reseñas de Google, marca propia |
| Límites | 1 sucursal, hasta 3 profesionales, tope mensual de conversaciones del agente | Sucursales y profesionales por cantidad |

- **Por qué este corte:** el Básico es lo que hoy ya se sabe vender (el bot), sobre la base nueva; el salto al Pro es
  "ahora manejá el negocio entero acá" (clientes, plata, equipo, números). Lo que separa los planes es lo que más
  valor percibido tiene: cobros, comisiones y reportes.
- **Precio:** Básico como el de hoy; Pro con base por sucursal y profesionales incluidos, más un extra por profesional
  o sucursal adicional. Referencia de mercado: AgendaPro ya vende agenda + recordatorios por WhatsApp + IA en LatAm;
  el diferencial es la calidad del agente.
- **En código:** `PLANS: Record<Plan, { modules, tier, limits }>` en `modules/billing`; cada ruta declara su módulo y
  el router lo chequea; `businesses.extra_modules` permite extras sueltos (p. ej. Básico + Campañas) y apagar el agente
  en un Pro.

---

## 6. Navegación

```
[Selector de sucursal: Todas / Sucursal X]      ← dueño y admin; recepción y profesional quedan fijos a las suyas

Inicio
Agenda           Día · Semana · Por profesional
Clientes         Lista · Ficha (/clientes/:id)
Ventas           Cobros · Pendientes · Resumen del día · Comisiones
Reportes         Ventas · Servicios · Profesionales · Clientes · Canales
── Módulos ──
WhatsApp IA      Bandeja · Métricas del bot · Configuración del bot     (🔒 si el plan no lo incluye)
Campañas         Campañas · Segmentos                                   (🔒)
──
Configuración    Negocio · Sucursales · Servicios · Equipo (profesionales, horarios, comisiones)
                 · Campos personalizados · Métodos de pago · Usuarios y permisos · Plan
```

- **Plan Básico:** Inicio · Agenda · Clientes (ficha) · WhatsApp IA · Configuración. Ventas, Reportes y Campañas se ven
  con 🔒 y abren "Disponible en Pro" (el upsell vive en el menú).
- **Pro sin agente:** WhatsApp IA desaparece del menú; los recordatorios se configuran en Configuración.
- **Profesional:** Mi agenda · Mis clientes · Mis comisiones.
- **Recepción:** Inicio · Agenda · Clientes · Ventas (sin comisiones) · WhatsApp IA.
- **Globales:** botón "+ Nuevo" (cita, cliente, cobro), buscador de clientes (Ctrl+K), contador de no leídos en
  WhatsApp IA. Rutas por URL para poder enlazar una cita o una ficha desde una notificación push.

---

## 7. Fases

Horas con la vara actual del repo (tests, RLS, migraciones, E2E). Semanas: a 20 h/sem – a 10 h/sem.

Ordenadas para vender el **Básico** lo antes posible y después ir sumando el Pro.

| Fase | Contenido | Horas | Semanas |
|---|---|---|---|
| **I0 · Cimientos** | Tag del estado actual, proyecto nuevo de Supabase, estructura por módulos, router declarativo + Zod + permisos, esquema base con RLS (rol de app nuevo), caché nuevo, correo de plataforma, login por email y recuperación de clave, borrar lavacar y prefijos, identificadores de la plataforma traducidos al inglés, CI y arnés de tests portados | 80–105 | 4–10,5 |
| **I1 · Núcleo del Básico** | Disponibilidad nueva (horario por profesional, buffers, varios servicios por cita, `EXCLUDE`), Agenda por profesional, profesionales y horarios, ficha automática del cliente, navegación nueva, Inicio básico, plantillas de rubro | 65–90 | 3,5–9 |
| **I2 · Agente y lanzamiento del Básico** | Agente y tools sobre los servicios del núcleo, bandeja, recordatorios por WhatsApp y correo, métricas básicas del agente, superadmin + alta de negocios + Embedded Signup portados, planes y límites, cobro manual | 60–80 | 3–8 |
| **I3 · CRM y equipo (Pro)** | Estados configurables, gasto y visitas, campos personalizados, etiquetas y filtros, importar CSV, usuario por profesional con roles, varias sucursales (UI y el agente pregunta la sucursal) | 50–65 | 2,5–6,5 |
| **I4 · Ventas y comisiones (Pro)** | Métodos de pago, pagos y señas, pendientes, resumen del día, reglas de comisión sobre lo cobrado, liquidaciones, "Mis comisiones" | 50–65 | 2,5–6,5 |
| **I5 · Reportes e Inicio completo (Pro)** | Rango de fechas; por sucursal, profesional, servicio y canal; ingresos reales; ocupación; export CSV; `daily_usage` en el superadmin | 30–40 | 1,5–4 |
| **I6 · Crecimiento** | Campañas, rescate de cotizaciones, upsell y reseñas portados; marca propia; Stripe; alta self-service | 40–55 | 2–5,5 |
| **Total** | | **375–500** | **≈ 25–33 a 15 h/sem** |

**Hitos de venta**
- Tras **I2** (205–275 h, unas **14–18 semanas a 15 h/sem**): se vende el **Básico**.
- Tras **I5** (335–445 h, unas **22–30 semanas a 15 h/sem**): se vende el **Pro**, con o sin agente.
- **I6** suma lo de crecimiento al Pro mientras ya hay clientes pagando.

**Riesgo:** varios meses sin vender. Mitigación: si aparece un cliente antes de I2, se atiende con la versión congelada
(solo bot) y se migra con un script al terminar I2.

Frente a la primera versión de este plan (335–445 h) suma ~40–55 h: el canal de correo, portar el alta de negocios
antes de vender el Básico y traducir al inglés los identificadores de la plataforma que se conserva.

---

## 8. Nombre del producto

**Nombre provisional: Selyon CRM.** El definitivo se elige cuando el producto esté terminado, entre las opciones de
abajo u otras. Arranca en un subdominio de `selyon.app` (ya es nuestro) y se compra dominio propio cuando el nombre esté
validado. En el código el nombre vive en una sola constante de marca (más `package.json`, manifest, landing y correos):
cambiarlo después es barato.

**Con búsqueda rápida** (no apareció un software de agenda o citas con ese nombre; no reemplaza verificar la marca):

| Nombre | Idea | Ojo con |
|---|---|---|
| **Atiendo** (recomendado) | Lo que hace el agente y lo que hace el negocio; sirve para cualquier rubro | — |
| **Recepta** | Recepcionista virtual + la recepción del negocio | Se puede confundir con "receta" |
| **Puntual** | Igual en español e inglés; citas a tiempo, menos no-shows | Palabra común: difícil de registrar sola; el `.com` seguramente está ocupado |
| **TuHora** | "Tu hora" = tu cita; suena natural | En CR se dice más "cita" que "hora" |
| **Cupo** | "Llená tus cupos"; muy corto | Palabra común, igual que Puntual |
| **Cítame** | Dice directo qué resuelve | El dominio va sin tilde (`citame`) |
| **Chatcita** | Chat + cita: describe exacto el Básico | Suena informal para el Pro |

**Sin verificar todavía:** Turnia (turno), Atenta (atención), Kairo (del griego *kairós*, el momento justo), Vuelve
(que el cliente vuelva), Citto (cita, corto y de marca). **Opción de costo cero:** Selyon (mezcla la empresa con el
producto).

**Descartados:** Kalena (ya existe un software de reservas), Fluye (FluyApp ya hace turnos y citas por WhatsApp en
LatAm). Antes de decidir: verificar dominio, marca en el Registro Nacional y el nombre en Instagram y WhatsApp Business.

---

## 9. Qué cambia en el ROADMAP

- Se agrega el **Carril I** con las fases I0–I6.
- Quedan obsoletos los pendientes operativos del piloto (contraseña, plantillas de Meta del lavacar).
- C4.3 (Stripe) pasa a I6, sobre el modelo nuevo.
- F1 (activar el rol RLS en producción) y H6/E14 (restore verificado) se rehacen sobre el proyecto nuevo de Supabase
  en I0; el código y los scripts se reusan.

---

## 10. I0 paso a paso

Se trabaja en la rama **`carril-i`**: el CI corre los tests en cada push y el deploy solo sale de `main`. `main` queda
con la versión congelada (tag `whatsapp-agent-final`) hasta que I2 esté lista para vender el Básico; ahí se fusiona.

| Paso | Qué | Listo cuando |
|---|---|---|
| **I0.1** | Congelar y renombrar: tag, rama, nombre provisional "Selyon CRM" en los paquetes y la PWA | Typecheck en verde |
| **I0.2** | Corte limpio: el dominio viejo (agente, webhook, panel, booking, campañas, rescate, config de tenants) y sus tests pasan a `legacy/`, fuera del build, solo como referencia para portar en I1–I2; se borra al cerrar I2 | El build ya no compila nada de `legacy/` |
| **I0.3** | La plataforma pasa a `src/platform/` traducida al inglés: db (cliente, `withTenant`/`withSystem`), net, observability, motor de colas, storage, arranque del servidor; sus tests portados | Tests de plataforma en verde |
| **I0.4** | Router declarativo + Zod (versión verificada con la política) + permisos por rol, sucursal y módulo | Tests del router en verde |
| **I0.5** | Esquema base nuevo (`business`, `team`, `catalog`, `clients`, `scheduling`) con RLS y `btree_gist`; se borran las migraciones viejas y nace una 0000; caché de config por negocio con TTL; test de RLS y test de dependencias entre módulos | La migración aplica en PGlite y los tests pasan |
| **I0.6** | Identidad: `users`/`memberships`, login por email, sesión con epoch, TOTP, recuperación de clave con `platform/email`; superadmin mínimo para crear un negocio | E2E de login en verde |
| **I0.7** | Panel web: shell con rutas (`react-router-dom`, ya instalado), login, layout con el menú nuevo; CI y E2E ajustados a la rama | CI en verde en `carril-i` |
| **Vos** | Crear el proyecto nuevo de Supabase y el rol de la app (para staging; dev y tests usan PGlite) | Antes de I2 |
