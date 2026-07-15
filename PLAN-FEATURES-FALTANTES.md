# Plan de Ejecución — Selyon: Básico + Pro (2 planes)

**Fecha:** 2026-07-14 · **Stack:** TypeScript/node:http · Drizzle + Postgres (Supabase) · React + TanStack Query (PWA) · Meta Cloud API · OpenAI · Google Calendar

**Objetivo:** Poder vender **dos planes** con las features prometidas, sin bloquear el lanzamiento comercial:

- **Plan Básico (₡35.000)** — el producto que ya existe: agente IA, bandeja, agenda, CRM, recordatorios, dashboard, Mi negocio, usuarios. Al Básico solo hay que **quitarle** cosas (con el gating, no ve Campañas ni las features Pro).
- **Plan Pro (₡60.000)** — Básico + **Campañas** (ya construida, solo se gatea), **Rescate de cotizaciones**, **Upsell al agendar** y **Motor de reseñas completo**.

> **Cambio de alcance (2026-07-14):** este plan pasó de 3 planes (Básico/Pro/**Premium ₡95.000**) a **2 planes**. Las features que eran exclusivas de Premium (CTWA, paquetes prepagados, membresías, Instagram, multi-empleado) **ya no forman parte de un plan vendible**: quedan en el **Backlog / futuro** al final, para construir solo cuando un cliente concreto lo pida y pague. No se venden como "Premium".

**Regla de oro:** La Fase 0 (gating) es lo único bloqueante para vender los dos planes. Las 3 features Pro se construyen *mientras ya hay clientes pagando*.

---

## 📅 Resumen del cronograma

| Fase | Contenido | Duración | Al finalizar podés... |
|---|---|---|---|
| **0** | Gating de 2 planes + hardening pre-venta | Semanas 1–2 | Vender Básico y Pro hoy |
| **1** | Las 3 features del plan Pro | Semanas 3–6 | Entregar Pro completo y demostrable |
| **Backlog** | Ex-Premium + varios | Cuando un cliente lo pida/pague | Expandir sin especular |

---

# FASE 0 — Gating de 2 planes + hardening pre-venta (Semanas 1–2) 🔴 BLOQUEANTE

## 0.1 Gating de features por plan (cablear lo que ya existe)

**Estado real del código (importante):** el modelo de 2 planes ya está a medio cablear y NO hay que crearlo de cero:
- `wa_tenants.plan` (`"basico" | "pro"`, default `"pro"` para grandfathering), `stripeCustomerId`, `stripeSubscriptionId`, `estadoFacturacion` (`"trial"|"activo"|"atrasado"|"cancelado"`) y `facturacionPeriodoFin` ya existen en `src/db/schema.ts` (por C4.3, aún sin migración generada).
- `src/billing/planes.ts` ya expone `tenantPuede(tenant, feature)` con un mapa `plan → features`.
- **El hueco:** ese gating **no se aplica en ningún endpoint todavía**. Campañas, Usuarios y White-label están construidos y hoy quedan abiertos a cualquier plan.

**Objetivo:** que el Básico deje de ver/usar las features Pro, respetado en panel **y** backend.

**Backend:**
- Extender el mapa de `src/billing/planes.ts` con las features Pro nuevas de este plan:
  ```
  Feature = "campanias" | "multiUsuario" | "whiteLabel"
          | "rescateCotizaciones" | "upsell" | "resenasPro"
  basico: todo false
  pro:    todo true
  ```
- Aplicar `tenantPuede()` como guard en los endpoints Pro que hoy están abiertos: `/api/panel/campanias/*`, `/api/panel/usuarios/*` y los de white-label en `/api/panel/config`. Rechazo uniforme `403 { error: "plan_requerido", plan: "pro" }`.
- `GET /me` expone `plan` + un objeto `features` derivado, para que el panel muestre/oculte sin adivinar (mismo patrón con que ya expone `marca`/`servicios`).

**Panel:**
- Pestañas Pro (Campañas + las nuevas de Fase 1) se muestran con 🔒 para Básico → modal "Disponible en el plan Pro — contactanos". Es el vendedor silencioso dentro del producto.

**Admin (`/panel/admin`):** en la lista de negocios, columna `plan` + dropdown para cambiar plan (Básico↔Pro) sin redeploy. La suspensión/estado fino de facturación se resuelve con C4.3 (Stripe) — acá basta con el cambio de plan manual.

**Aceptación:** un dueño Básico no ve Campañas ni las features Pro, y si pega el POST directo igual le rebota 403; cambiar el plan a Pro desde el admin las habilita sin redeploy.

**Estimado: 2–3 días.**

---

## 0.2 Contadores de uso por tenant (para el tope del Básico)

**Objetivo:** medir cuántas conversaciones consume cada cliente — habilita el **límite de ~500 conversaciones/mes del Básico** que se mencionó, y saber qué te cuesta cada cliente (Meta cobra por conversación).

**Datos:** tabla `wa_uso_mensual` (`tenant_id, anio_mes, conversaciones_iniciadas, mensajes_entrantes, mensajes_salientes, plantillas_marketing, plantillas_utilidad`). Incremento atómico (`INSERT ... ON CONFLICT DO UPDATE`) desde el webhook y desde cada envío. Conversación "iniciada" = primer mensaje tras 24 h de silencio (aproxima el modelo de cobro de Meta).

**Admin:** columna "Conversaciones este mes" por negocio.

**Decisión de producto:** **medir sin bloquear.** Podés lanzar los 2 planes hoy sin enforcement del tope y solo monitorear; definís el número exacto y activás el bloqueo cuando tengas 1–2 meses de datos reales. El enforcement es un cambio chico encima de esto cuando lo quieras.

**Aceptación:** el admin muestra números que cuadran (±5%) con el billing de Meta Business Manager.

**Estimado: 2 días. (Opcional para lanzar — no bloquea la venta.)**

---

## 0.3 Indicador de ventana de 24 horas en la bandeja

**Objetivo:** que el operador NUNCA escriba a ciegas fuera de la ventana de sesión de WhatsApp (el bug operativo más caro que podés prevenir).

**Backend:** exponer `ventana_abierta` y `ventana_cierra_en` en el API de conversaciones (la conversación ya conoce el timestamp del último entrante). Si el operador envía fuera de ventana → el endpoint rechaza con error claro.

**Panel:** chip en el header del chat (🟢 "cierra en 5h 12m" / 🔴 "cerrada"). Con sesión cerrada, el input de texto se deshabilita y se reemplaza por selector de plantillas de utilidad ("Reabrir conversación").

**Aceptación:** es imposible enviar texto libre fuera de ventana desde el panel; también cubierto a nivel API.

**Estimado: 2–3 días.**

## 0.4 Pulido de bandeja y ficha

- **Nombres en vez de números** cuando la ficha tiene nombre (1 día).
- **Tooltip del lead score** (ⓘ con leyenda corta) (0.5 día).
- **Fechas unificadas** dd/mm/yyyy con un formateador central; "Vehículos" → "Vehículo / Placa" (0.5 día).
- **`<ErrorState>`** (icono + mensaje + Reintentar) reemplaza los textos planos en Usuarios/Campañas/queries fallidas (1 día).
- **Botón Guardar de Nueva cita** con contraste pleno cuando el form es válido (0.5 día).

**Estimado total: 3–4 días.**

## 0.5 Reset de contraseña desde el admin

- `POST /admin/usuarios/:id/reset-password` → clave temporal de un solo uso (expira 24 h) + flag `debe_cambiar_clave`; el panel fuerza el cambio al primer login. Botón "Resetear clave" en el detalle del negocio.

**Estimado: 1–2 días.**

## 0.6 Proceso de cobro manual (operativo, no código)

- Documento interno: día de facturación, plantilla de factura, recordatorio de pago por WhatsApp al dueño, política de gracia. Checklist mensual de 15 min usando el admin de 0.1.

**Estimado: medio día. Ya podés VENDER los 2 planes al terminar la Fase 0.** ✅

---

# FASE 1 — Las 3 features del plan Pro (Semanas 3–6)

> **Cada feature se gatea a `pro` en el MISMO commit que la construye** (agregar al mapa de `planes.ts` + guard en su endpoint), y **toda tabla/columna nueva lleva su migración Drizzle generada en ese mismo commit** — sin migración el deploy rompe en silencio (`seedTenants` aborta antes del `pm2 restart`).

## 1.1 Rescate de cotizaciones abandonadas 💰 (la feature más vendedora)

**Objetivo:** cotización sin cita en ~3 h → seguimiento automático → cita recuperada → métrica visible en ₡.

**Patrón obligado:** mini-cola propia estilo `src/campaigns/` — **NO** tocar `wa_jobs`/B1. Módulo nuevo `src/rescate/` (`db.ts` con su pool propio, `cola.ts` con `FOR UPDATE SKIP LOCKED`, `worker.ts` con throttling), copiado/adaptado de `src/campaigns/`.

**Datos (migración aditiva):**
```
wa_cotizaciones:
  id, tenant_id, conversacion_id, cliente_wa,
  servicio_id, monto, creada_en,
  estado: 'pendiente' | 'agendada' | 'toque1' | 'toque2' | 'recuperada' | 'descartada' | 'opt_out',
  cita_id nullable, monto_recuperado nullable
```

**(a) Marcar "cotización enviada":**
- Tool nueva `registrar_cotizacion(servicioId, monto)` en `src/agent/tools.ts` + ejecución en `runAgent.ts`; el modelo la invoca al dar un precio con intención de venta (regla nueva en `systemPrompt.ts`).
- Fallback: si el modelo no la llamó pero luego hay cita para ese teléfono+servicio, se marca `agendada` igual.
- Al crearse una cita (bot o manual) para ese teléfono+servicio → `agendada` (o `recuperada` si ya hubo toque).

**(b) Job cada X min** (`src/rescate/worker.ts`): cotizaciones `pendiente` con `creada_en < now() - RESCATE_HORAS` (default 3 h, env acelerable a minutos para demo/QA) y sin cita.

**(c) Envío del seguimiento:**
- **Toque 1 (dentro de 24 h):** texto libre con lista tocable de horarios (reusa `ofrecer_horarios`/`enviarLista` de C1.2): *"¿Te guardo el espacio para el {servicio} ({monto})? Me quedan {n} horarios libres."*
- **Toque 2 (día siguiente, fuera de 24 h):** plantilla Utility/Marketing aprobada por Meta con `{nombre, servicio, monto}`, exactamente como envía campañas (`src/campaigns/worker.ts`, `enviarPlantilla`). **Tramitar esa plantilla en Meta desde la Semana 1** (el review tarda).

**(d) Reglas duras:** máx 2 toques por cotización; respeta `optOutEn` (mismo chequeo que campañas); no dispara si la conversación está en modo humano; no dos rescates activos al mismo teléfono.

**(e) Dashboard:** tarjeta **"₡ recuperados"** (mes actual) + enviados/recuperados/tasa (nuevo campo en `Metricas` de `src/panel/metricas.ts` + tarjeta en `Dashboard.tsx`). *Esta tarjeta es tu demo de venta.*

**Config (Mi Negocio, sección "Rescate de ventas"):** on/off, horas de espera, textos editables de los 2 toques, nombre de la plantilla Meta del toque 2.

**Aceptación:** flujo E2E en `SEED_DEMO`: bot cotiza → 3 h sin cita (acelerable por env) → toque 1 → cliente agenda → la tarjeta suma el monto.

**Estimado: 1.5–2 semanas.**

---

## 1.2 Upsell inteligente al agendar

**Objetivo:** al confirmar una cita, el bot ofrece UN add-on relevante; el dashboard demuestra el aumento de ticket. Es mayormente prompt engineering + 2 campos de config. Sin cola.

**Datos:**
```
Service (JSONB de wa_tenants — editable en "Mi negocio", sin migración de tabla):
  + addonSugeridoId?    -- qué ofrecer con este servicio
  + addonPrecioPromo?   -- precio ancla ("en vez de X")
  + addonActivo?

wa_citas (migración aditiva):
  + addons jsonb        -- [{servicioId, precio}]
  + monto_total         -- base + addons

ficha del cliente (CRM):
  + upsells_rechazados jsonb  -- [{addonId, fecha}] para no insistir <60 días
```

**Bot (prompt + tools):**
- Regla en `systemPrompt.ts`: *después* de que el cliente confirma día/hora y *antes* del cierre, si el servicio tiene add-on activo y el cliente no lo rechazó hace <60 días → ofrecerlo UNA vez, casual, con precio ancla. Nunca insistir tras un "no".
- Tool `agregar_addon_a_cita(citaId, addonId)` al aceptar; registrar el rechazo cuando declina.

**Panel:**
- Mi Negocio (`MiNegocio.tsx`): selector de add-on + precio promo por servicio.
- Agenda/ficha: la cita muestra add-ons y monto total.
- Dashboard: tarjeta **"Ticket promedio"** + tasa de aceptación de upsell + ₡ extra del mes por add-ons.

**Aceptación:** el bot ofrece el add-on tras confirmar, lo agrega si aceptan, no lo re-ofrece al mismo cliente, y el dashboard refleja el ₡ extra.

**Estimado: 1 semana.**

---

## 1.3 Motor de reseñas de Google (completo)

**Objetivo:** pedir reseña SOLO a clientes satisfechos y mostrarle al dueño cómo sube su reputación. **Ya tenés el ~60%** (C3.1): el "¿Cómo te fue?" con botones y el link de Google viven en `src/reminders/scheduler.ts` (`enviarPostServicio`) y el protocolo `postbien|`/`postmal|` en `src/whatsapp/client.ts`.

**Datos:**
```
wa_seguimientos (migración aditiva):
  cita_id, tenant_id, enviado_en,
  sentimiento: 'positivo' | 'neutral' | 'negativo' nullable,
  resena_solicitada boolean, respuesta_texto text

wa_tenants: + google_place_id nullable
snapshot_reputacion: tenant_id, fecha, rating numeric, total_resenas int
```

**(a) Estructurar la respuesta** — pasar de 2 botones a **3**: `Excelente 😃 / Bien 🙂 / Mal 😞` (`botonesPostServicio` + `respuestaPostServicio` en `client.ts`). Enrutamiento en `handleWebhook.ts` (acción directa, ya existe el patrón):
- **Excelente** → agradecer + link de reseña (`tenant.linkResenas`), marcar `resena_solicitada`.
- **Bien** → agradecer, NO pedir reseña (opcional: cupón simple de texto configurable).
- **Mal** → flujo actual de intercepción + escalada al operador (ya existe).

**(b) Contador de solicitudes enviadas** — derivado de `wa_seguimientos`; tarjeta en el dashboard: solicitudes enviadas vs. reseñas conseguidas.

**(c) Google Places API (opcional pero valioso):** `tenant.googlePlaceId` (config en Mi Negocio) + job diario que lee `rating` + `user_ratings_total` → `snapshot_reputacion`. 1 llamada/día/tenant (dentro del free tier de Places). **Dependencia externa:** API key de Google Places (+ decisión de cargar esa dep/costo). Dashboard sección "Reputación": rating con estrellas + gráfico de evolución con ≥2 snapshots.

**Aceptación:** solo "Excelente" recibe el link; el contador sube; con Places, el dashboard grafica la evolución.

**Estimado: 1 semana** (3–4 días sin Places API; +2–3 días con ella).

**✅ Fin de Fase 1: plan Pro completo y demostrable con números.**

---

# BACKLOG / FUTURO (fuera de los 2 planes — construir por demanda)

> Estas features **ya no se venden como un plan** (eran el ex-Premium). Se construyen solo cuando un cliente concreto lo pida y pague. Se conservan aquí como referencia de alcance, no como compromiso.

**Ex-Premium (mayor esfuerzo):**
- **Paquetes prepagados** ("5 servicios por el precio de 4", compra → confirmación manual SINPE → consumo por cita → aviso de renovación). ~5–7 días.
- **Membresías recurrentes** (extiende paquetes con ciclo/renovación + recordatorio de pago + MRR en dashboard). ~2 semanas.
- **Atribución Click-to-WhatsApp (CTWA)** (objeto `referral` del webhook → origen de conversación/cita → ROI de la pauta en el dashboard). ~3–5 días.
- **Multicanal Instagram DM** (mismo agente, requiere App Review de Meta — trámite largo). ~2 semanas + revisión.
- **Agenda multi-empleado** (slots por empleado, retrocompatible con negocio de 1 empleado). ~2–3 semanas.

**Otros por demanda:** WhatsApp Flows (formularios nativos), fila virtual, señas por SINPE, lista de espera, recompra por ciclo, campañas de cumpleaños, rescate de clientes en riesgo, programa de referidos, promos de horas valle, tarifas B2B/flota, rescate de llamadas perdidas, botón Reservar en Google Maps, panel multi-sucursal. Cada uno se arranca solo con un disparador de negocio real que lo justifique.

---

# Notas transversales

**Gating + migraciones (OBLIGATORIO por commit):** cada feature Pro se agrega al mapa de `planes.ts` y se gatea en su endpoint en el mismo commit; cada tabla/columna nueva lleva su migración Drizzle generada en ese commit (ver `deploy-migracion-obligatoria`).

**Colas independientes:** el rescate (1.1) usa su propia mini-cola estilo `src/campaigns/`, nunca `wa_jobs`/B1 (ver el patrón acordado en el ROADMAP, C3.2).

**Plantillas de Meta a tramitar ANTES de necesitarlas** (el review tarda días): rescate toque 2 (Utility/Marketing), reapertura de conversación (Utility, para 0.3), y la de recordatorio fuera de 24 h que sigue pendiente. Crearlas en la Semana 1.

**Testing en demo:** cada feature nueva debe funcionar en `SEED_DEMO` con datos ficticios — de ahí salen tus capturas y demos de venta. Agregar cotizaciones y add-ons de ejemplo al seed.

**Métricas = ventas:** cada feature de ingresos DEBE terminar en una tarjeta del dashboard con ₡. Si el dueño no ve cuánta plata le generó, la feature no está terminada.

**Flags de aceleración:** env vars para acortar tiempos (rescate a 3 min en vez de 3 h) — imprescindible para demos y QA.

---

## Checklist de arranque

- [x] 0.1 Extender `planes.ts` con las features Pro + guards en Campañas/Usuarios/White-label + 🔒 en el panel
- [x] 0.1 Cambio de plan Básico↔Pro desde `/panel/admin`
- [x] 0.2 Tabla `wa_uso_mensual` + incrementos (medir sin bloquear)
- [x] 0.3 Ventana 24 h: API + chip + bloqueo de input
- [x] 0.4 Pulido de bandeja y ficha (nombres, tooltip lead score, fechas dd/mm/yyyy, `<ErrorState>`; contraste del botón Guardar verificado OK)
- [ ] Enviar a aprobación las plantillas de Meta (rescate toque 2, reapertura)
- [ ] 0.6 Documento de proceso de cobro
- [ ] Definir precio fundador (ej. Pro con descuento vitalicio, primeros 5)
