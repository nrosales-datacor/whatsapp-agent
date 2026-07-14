# Plan de Ejecución — Selyon: Features Faltantes

**Fecha:** 2026-07-13 · **Stack:** TypeScript/node:http · Drizzle + Postgres (Supabase) · React + TanStack Query (PWA) · Meta Cloud API · OpenAI · Google Calendar

**Objetivo:** Poder vender los 3 planes (Básico ₡35.000 / Pro ₡60.000 / Premium ₡95.000) con las features prometidas, sin bloquear el lanzamiento comercial.

**Regla de oro:** La Fase 0 es lo único bloqueante para vender. Todo lo demás se construye *mientras ya hay clientes pagando*.

---

## 📅 Resumen del cronograma

| Fase | Contenido | Duración | Al finalizar podés... |
|---|---|---|---|
| **0** | Hardening pre-venta + infraestructura de planes | Semanas 1–2 | Vender los 3 planes hoy |
| **1** | Features del plan Pro | Semanas 3–6 | Entregar Pro completo |
| **2** | Premium quick-wins (CTWA + prepagados) | Semanas 7–8 | Entregar Premium "v1" |
| **3** | Premium grande (membresías, Instagram, multi-empleado) | Semanas 9–14 | Premium completo + vender a salones/barberías |
| **4** | Backlog por demanda | Cuando un cliente lo pida/pague | Expandir sin especular |

---

# FASE 0 — Hardening pre-venta (Semanas 1–2) 🔴 BLOQUEANTE

## 0.1 Infraestructura de planes y suspensión

**Objetivo:** Cada tenant tiene plan y estado; el sistema los respeta en backend y panel.

**Datos (Drizzle):**
```
tenants:
  + plan: enum('basico','pro','premium') default 'basico'
  + estado: enum('trial','activo','moroso','suspendido') default 'trial'
  + trial_hasta: date nullable
  + proximo_cobro: date nullable
  + notas_facturacion: text nullable   -- "paga SINPE el 5 de cada mes", etc.
```

**Backend:**
- Helper central `hasFeature(tenant, feature)` con un mapa plan→features:
  - `basico`: agente, bandeja, agenda, crm, recordatorios, dashboard, mi_negocio, usuarios
  - `pro`: básico + campanias, rescate_cotizaciones, upsell, resenas
  - `premium`: pro + membresias, prepagados, ctwa, instagram, multi_empleado
- Middleware en `/api/panel/*`: endpoints gateados devuelven `403 { error: 'plan_requerido', plan: 'pro' }`.
- **Webhook:** si `estado = 'suspendido'`, el bot responde UNA sola vez un mensaje neutro configurable ("Por el momento escribinos directamente al negocio 🙏") y no procesa más. Los mensajes se siguen guardando (no perder historial). Si `moroso`: el bot funciona normal pero el panel muestra banner de pago pendiente al dueño.

**Panel:**
- Pestañas gateadas se muestran con 🔒 y modal "Disponible en el plan Pro — contactanos" (tu vendedor silencioso).
- Banner de estado `moroso`/`trial` (días restantes) en el header del panel.

**Admin (`/panel/admin`):**
- En la lista de negocios: columna plan + estado, dropdown para cambiar plan, botón Suspender/Reactivar, campo próximo cobro.

**Aceptación:** cambiar un tenant a `suspendido` desde el admin apaga el bot en <1 min sin redeploy; un dueño Básico ve Campañas bloqueada y el API se lo rechaza aunque llame directo.

**Estimado: 3–4 días.**

---

## 0.2 Contadores de uso por tenant

**Objetivo:** Saber cuánto te cuesta cada cliente (Meta cobra por conversación) y habilitar límites futuros.

**Datos:**
```
uso_mensual:
  tenant_id, anio_mes ('2026-07'),
  conversaciones_iniciadas int, mensajes_entrantes int,
  mensajes_salientes int, plantillas_marketing int, plantillas_utilidad int
```
- Incremento atómico (`INSERT ... ON CONFLICT DO UPDATE`) desde el webhook y desde cada envío.
- Conversación "iniciada" = primer mensaje tras 24h de silencio (aproxima el modelo de cobro de Meta).

**Admin:** columna "Conversaciones este mes" por negocio + vista de detalle con los últimos 6 meses.

**No hacer todavía:** enforcement de límites. Solo medir. Definís los topes por plan cuando tengas 2–3 meses de datos reales.

**Aceptación:** el admin muestra números que cuadran (±5%) con el billing de Meta Business Manager.

**Estimado: 2 días.**

---

## 0.3 Indicador de ventana de 24 horas en la bandeja

**Objetivo:** Que el operador NUNCA escriba a ciegas fuera de la ventana de sesión de WhatsApp.

**Backend:**
- La conversación ya conoce el timestamp del último mensaje entrante → exponer `ventana_abierta: boolean` y `ventana_cierra_en: timestamp` en el API de conversaciones.
- Si el operador envía fuera de ventana: el endpoint rechaza con error claro (no fallo silencioso).

**Panel:**
- Chip en el header del chat: 🟢 "Sesión abierta · cierra en 5h 12m" / 🔴 "Sesión cerrada".
- Con sesión cerrada: el input de texto se deshabilita y se reemplaza por selector de plantillas de utilidad aprobadas ("Reabrir conversación"). Enviada la plantilla y respondido el cliente, la ventana se reabre sola.

**Aceptación:** es imposible que un operador intente enviar texto libre fuera de ventana desde el panel; el caso está cubierto también a nivel API.

**Estimado: 2–3 días.** *Este es el bug operativo más caro que podés prevenir — prioridad máxima dentro de la Fase 0.*

---

## 0.4 Pulido de bandeja y ficha

- **Nombres en vez de números:** si la ficha tiene nombre, la bandeja muestra "Diego Ramírez" y el número en secundario. (1 día)
- **Tooltip del lead score:** icono ⓘ junto al score con leyenda corta ("Probabilidad de que esta conversación termine en cita"). (0.5 día)
- **Fechas unificadas:** todo dd/mm/yyyy con un formateador central. Renombrar "Vehículos" → "Vehículo / Placa" o mostrar "Hilux · C 162345". (0.5 día)
- **Estados de error reales:** componente `<ErrorState>` (icono + mensaje + botón Reintentar) reemplaza los textos planos "No se pudieron cargar..." en Usuarios, Campañas y cualquier query fallida. (1 día)
- **Botón Guardar de Nueva cita:** estado habilitado con contraste pleno cuando el form es válido. (0.5 día)

**Estimado total: 3–4 días.**

## 0.5 Reset de contraseña desde el admin

- Endpoint superadmin `POST /admin/usuarios/:id/reset-password` que genera clave temporal de un solo uso con expiración 24h y flag `debe_cambiar_clave`.
- Al primer login con clave temporal, el panel fuerza pantalla de cambio.
- Botón "Resetear clave" en el detalle del negocio en el admin.

**Estimado: 1–2 días.**

## 0.6 Proceso de cobro manual (operativo, no código)

- Documento interno: día de facturación, plantilla de factura TicoFactura (ya dominás el flujo), recordatorio de pago por WhatsApp al dueño, política de gracia (7 días → `moroso`, 15 días → `suspendido`).
- Checklist mensual de 15 minutos usando el admin de 0.1.

**Estimado: medio día. Ya podés VENDER al terminar la Fase 0.** ✅

---

# FASE 1 — Plan Pro (Semanas 3–6)

## 1.1 Rescate de cotizaciones abandonadas 💰 (la feature más vendedora)

**Objetivo:** Cotización sin cita en 3h → seguimiento automático → cita recuperada → métrica visible en ₡.

**Datos:**
```
cotizaciones:
  id, tenant_id, conversacion_id, cliente_telefono,
  servicio, monto, creada_en,
  estado: enum('pendiente','agendada','rescate_1_enviado','rescate_2_enviado','descartada','recuperada'),
  cita_id nullable, monto_recuperado nullable
```

**Detección (bot):**
- El agente ya sabe cuándo cotiza. Agregar tool/función interna `registrar_cotizacion(servicio, monto)` que el modelo invoca al dar un precio con intención de venta. Fallback: regex de montos (₡ + número) sobre mensajes salientes del bot marcados como cotización por el propio prompt.
- Si luego se crea cita para ese teléfono con ese servicio → `estado = 'agendada'`.

**Job de rescate (usa tu cola durable en Postgres):**
- Cada 15 min: cotizaciones `pendiente` con `creada_en < now() - 3h` y sin cita.
- **Toque 1 (dentro de ventana 24h):** mensaje libre del bot, tono natural, referencia concreta: "¿Te guardo el espacio de mañana para el {servicio} ({monto})? Me quedan {n} horarios libres." Incluye lista tocable de horarios (ya tenés mensajes interactivos).
- **Toque 2 (día siguiente, probablemente fuera de ventana):** plantilla de utilidad/marketing aprobada por Meta con variables {nombre, servicio, monto}. Reutiliza tu infra de plantillas de Campañas.
- **Reglas duras:** máximo 2 toques por cotización; respeta opt-out "BAJA"; no dispara si la conversación está en modo humano; no dispara dos rescates activos al mismo teléfono.
- Si el cliente agenda después de un toque → `recuperada` + `monto_recuperado`.

**Configuración (Mi Negocio, sección nueva "Rescate de ventas"):** on/off, horas de espera (default 3), textos editables de los 2 toques, nombre de la plantilla Meta del toque 2.

**Dashboard:** tarjeta **"₡ recuperados por el bot"** (mes actual) + contadores enviados/recuperados + tasa. *Esta tarjeta es tu demo de ventas.*

**Aceptación:** flujo E2E en demo: bot cotiza → 3h sin cita (acelerable por env var) → toque 1 → cliente agenda → tarjeta suma el monto.

**Estimado: 6–8 días.**

---

## 1.2 Upsell inteligente al agendar

**Objetivo:** Al confirmar una cita, el bot ofrece UN add-on relevante; el dashboard demuestra el aumento de ticket.

**Datos:**
```
servicios (Mi Negocio):
  + addon_sugerido_id nullable      -- qué ofrecer con este servicio
  + addon_precio_promo nullable     -- precio ancla ("en vez de X")
  + addon_activo boolean

citas:
  + addons jsonb    -- [{servicio_id, precio}]
  + monto_total     -- base + addons

clientes:
  + upsells_rechazados jsonb  -- [{addon_id, fecha}] para no insistir <60 días
```

**Bot (prompt + tools):**
- Regla en el system prompt del agente: *después* de que el cliente confirma día/hora y *antes* del mensaje de cierre, si el servicio tiene add-on activo y el cliente no lo rechazó hace <60 días: ofrecerlo UNA vez, casual, con precio ancla. Nunca insistir tras un "no".
- Tool `agregar_addon_a_cita(cita_id, addon_id)` cuando acepta; registrar rechazo cuando declina.

**Panel:**
- Mi Negocio: selector de add-on + precio promo por servicio.
- Agenda/ficha: la cita muestra add-ons y monto total.
- Dashboard: tarjeta **"Ticket promedio"** + tasa de aceptación de upsell + ₡ extra del mes por add-ons.

**Aceptación:** en demo, el bot ofrece el add-on tras confirmar, lo agrega si aceptan, no lo re-ofrece al mismo cliente, y el dashboard refleja el ₡ extra.

**Estimado: 4–5 días.**

---

## 1.3 Motor de reseñas de Google (completo)

**Objetivo:** Pedir reseña SOLO a clientes satisfechos y mostrarle al dueño cómo sube su reputación.

**Datos:**
```
seguimientos:
  cita_id, tenant_id, enviado_en,
  sentimiento: enum('positivo','neutral','negativo') nullable,
  resena_solicitada boolean, respuesta_texto text

tenants: + google_place_id nullable
snapshot_reputacion: tenant_id, fecha, rating numeric, total_resenas int
```

**Bot:**
- El "¿Cómo te fue?" existente se estructura: botones nativos **Excelente 😃 / Bien 🙂 / Mal 😞** (mensajes interactivos que ya usás).
- Enrutamiento: Excelente → agradecer + link de reseña (`resena_solicitada = true`). Bien → agradecer, opcional cupón simple de texto configurable, NO pedir reseña. Mal → flujo actual de intercepción + alerta al operador (ya existe).

**Google Places API (opcional pero potente):**
- Job diario: `rating` + `user_ratings_total` del `place_id` → snapshot. Costo ínfimo (1 llamada/día/tenant, dentro del free tier de Places).

**Dashboard, sección "Reputación":** rating actual con estrellas, gráfico de evolución, reseñas nuevas/mes, solicitudes enviadas vs. reseñas conseguidas, y la línea que vende: *"Cada estrella extra = 5–9% más ingresos (Harvard Business School)"*.

**Aceptación:** solo respuestas "Excelente" reciben el link; el dashboard grafica evolución con ≥2 snapshots.

**Estimado: 5–6 días** (3–4 sin Places API).

**✅ Fin de Fase 1: plan Pro completo y demostrable con números.**

---

# FASE 2 — Premium quick-wins (Semanas 7–8)

## 2.1 Atribución de anuncios Click-to-WhatsApp (3–5 días)

**Objetivo:** "Este anuncio generó 12 citas y ₡96.000" — ROI real de la pauta del cliente.

- **Webhook:** cuando el mensaje entrante trae objeto `referral` (viene de CTWA), guardar en la conversación: `source_type, source_id, headline, ad_url`.
- **Datos:** `conversaciones: + origen jsonb nullable`. Las citas heredan el origen de su conversación.
- **Dashboard, sección "Origen de clientes":** tabla por anuncio → conversaciones → citas → ₡ estimados; total orgánico vs. pagado.
- **Aceptación:** un mensaje de prueba con referral simulado aparece atribuido de punta a punta.

## 2.2 Paquetes prepagados (versión simple de membresías) (5–7 días)

**Objetivo:** "5 servicios por el precio de 4", pagado por adelantado — flujo de caja inmediato para el cliente.

**Datos:**
```
paquetes: id, tenant_id, nombre, servicio_id, cantidad_usos, precio, activo
paquetes_cliente: id, paquete_id, cliente_id, usos_restantes, comprado_en, vence_en nullable,
                  estado: enum('pendiente_pago','activo','agotado','vencido')
```

**Flujo:**
- Mi Negocio: sección "Paquetes" (crear/editar/activar).
- Bot: conoce los paquetes (base de conocimiento estructurada); si el cliente quiere comprar → instrucciones de SINPE + aviso al operador; el operador confirma pago en la ficha → `activo`.
- Al completar una cita de un cliente con paquete activo del servicio: descontar uso automáticamente + mensaje "Te quedan 3 lavados de tu paquete ✨".
- `usos_restantes = 1` → el bot avisa; `= 0` → ofrece renovar (semilla de la membresía completa de Fase 3).
- Dashboard: paquetes vendidos, ₡ prepagados, usos consumidos.

**Aceptación:** ciclo completo compra → confirmación manual → consumo por cita → aviso de renovación.

**✅ Fin de Fase 2: ya podés entregar Premium "v1" (CTWA + prepagados) y cobrarlo.**

---

# FASE 3 — Premium grande (Semanas 9–14)

*Regla: cada item de esta fase arranca solo cuando haya al menos un cliente Premium (o prospecto firmado) que lo necesite.*

## 3.1 Membresías recurrentes (2 semanas)

Extiende 2.2 con renovación por ciclo:
- `membresias: + ciclo enum('mensual'), renovacion_en date, usos_por_ciclo`
- Job diario: 3 días antes de `renovacion_en` → recordatorio de pago (plantilla utilidad); confirmado el pago (manual en ficha u orden admin) → resetear usos y correr fecha; sin pago tras X días de gracia → `vencida` + aviso.
- Bot vende la membresía detectando recurrencia: cliente con ≥3 visitas/mes → "Con el plan mensual hubieras ahorrado ₡X" (job semanal que marca candidatos + oferta en la siguiente conversación).
- Dashboard: MRR del negocio, miembros activos, churn de membresías.

## 3.2 Multicanal: Instagram DM (2 semanas + revisión de permisos de Meta)

- Misma app de Meta: suscribirse al webhook de Instagram Messaging; solicitar permisos `instagram_manage_messages` (App Review — **iniciar el trámite al comienzo de la fase, tarda**).
- Normalizador de mensajes: unificar WhatsApp/Instagram al modelo interno de conversación con campo `canal`.
- Bandeja: badge de canal (logo WA/IG) + filtro por canal. El agente responde igual en ambos; las plantillas/ventanas difieren (Instagram usa ventana de 24h con tag HUMAN_AGENT en vez de plantillas) → abstraer la regla de "puedo enviar libre?" por canal (reutiliza 0.3).
- Onboarding: en el admin, campo para vincular la cuenta de Instagram del negocio.

## 3.3 Agenda multi-empleado (2–3 semanas — el más invasivo)

- **Datos:** `empleados (id, tenant_id, nombre, activo, horario jsonb nullable)`; `citas: + empleado_id nullable`; `servicios: + empleados_habilitados jsonb nullable`.
- **Disponibilidad:** el cálculo de slots pasa de "por negocio" a "por empleado" (negocio de 1 empleado = comportamiento actual intacto → retrocompatible; ese es el criterio de diseño clave).
- **Bot:** si el tenant tiene >1 empleado habilitado para el servicio: "¿Con quién preferís? Luis, María o el primero disponible" (lista tocable). "Primero disponible" = asignación automática al de menor carga.
- **Panel:** Agenda con filtro/columnas por empleado; Nueva cita con selector; Mi Negocio → sección Empleados; Dashboard → ingresos y citas por empleado.
- **Google Calendar:** un calendario por empleado (o colores/etiquetas si el negocio usa uno solo — configurable).

**✅ Fin de Fase 3: Premium completo. Selyon vendible a salones, barberías y clínicas.**

---

# FASE 4 — Backlog por demanda (construir cuando un cliente lo pida)

Orden sugerido si tuvieras que elegir hoy, con el disparador que justifica construirlo:

| # | Feature | Estimado | Construilo cuando... |
|---|---|---|---|
| 4.1 | **WhatsApp Flows** (formularios nativos de agendado) | 1–2 sem | Notes >15% de abandono en el flujo de agendado conversacional |
| 4.2 | **Fila virtual** (orden de llegada) | 1 sem | Un negocio walk-in (barbería, tu propio lavacar) lo pida — diferenciador LATAM único |
| 4.3 | **Señas por SINPE** para confirmar citas | 3–4 días | Un cliente sufra no-show >30% |
| 4.4 | **Lista de espera** (cancelación → ofrecer espacio) | 3–4 días | Un cliente tenga agenda llena recurrentemente |
| 4.5 | **Recompra por ciclo de servicio** | 4–5 días | Tengas 3+ meses de historial de servicios por cliente |
| 4.6 | **Campañas de cumpleaños** | 2–3 días | Quick-win: cualquier momento post-Fase 1 |
| 4.7 | **Rescate de clientes en riesgo** (frecuencia individual) | 4–5 días | Junto con 4.5 (comparten análisis de frecuencia) |
| 4.8 | **Programa de referidos** con códigos | 1 sem | Un cliente pregunte "¿cómo consigo más clientes nuevos?" |
| 4.9 | **Promos de horas valle** | 3–4 días | El dashboard de un cliente muestre huecos sistemáticos |
| 4.10 | **Tarifas B2B/flota** | 3–4 días | Llegue el segundo chofer de Uber preguntando |
| 4.11 | **Rescate de llamadas perdidas** | 1 sem + telco | Tengas un prospecto que "pierde llamadas" como dolor principal |
| 4.12 | **Botón Reservar en Google Maps → bot** | 1–2 días (link) | Quick-win: cualquier momento |
| 4.13 | **NPS estructurado con enrutamiento** | Ya cubierto en 1.3 | Evolucionarlo con puntaje 1–10 si un cliente corporativo lo pide |
| 4.14 | **Panel multi-sucursal** | 2–3 sem | Firmes la primera cadena/franquicia (que pague onboarding) |

---

# Notas transversales

**Plantillas de Meta a crear/aprobar ANTES de necesitarlas** (el review tarda días): rescate toque 2, recordatorio de renovación de membresía, reapertura de conversación (utilidad, para 0.3). Crearlas en la Semana 1 aunque las uses en la 4.

**Testing en demo:** cada feature nueva debe funcionar en modo `SEED_DEMO` con datos ficticios — tus capturas y demos de venta salen de ahí. Agregar cotizaciones, paquetes y empleados de ejemplo al seed.

**Métricas = ventas:** cada feature de ingresos DEBE terminar en una tarjeta del dashboard con ₡. La regla: si el dueño no puede ver cuánta plata le generó, la feature no está terminada.

**Flags de aceleración para pruebas:** env vars para acortar tiempos (rescate a 3 min en vez de 3h, renovación a 1 día) — imprescindible para demos y QA.

**Con Claude Code:** atacá cada numeral como una sesión independiente en tu workspace multi-proyecto. El orden dentro de cada fase ya está pensado para que cada item deje el sistema deployable.

---

## Checklist de arranque (esta semana)

- [ ] 0.1 Migración de `plan`/`estado` + helper `hasFeature` + gating
- [ ] 0.1 Controles de plan/suspensión en `/panel/admin`
- [ ] 0.2 Tabla `uso_mensual` + incrementos en webhook
- [ ] 0.3 Ventana 24h: API + chip + bloqueo de input
- [ ] Enviar a aprobación las 3 plantillas de Meta
- [ ] 0.6 Documento de proceso de cobro SINPE
- [ ] Definir precio fundador (ej. Pro ₡45.000 de por vida, primeros 5)
- [ ] 📣 Agendar las primeras 5 conversaciones de venta para la Semana 3
