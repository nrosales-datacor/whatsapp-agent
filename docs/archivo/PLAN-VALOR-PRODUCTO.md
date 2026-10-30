> ✅ **Archivado — plan mayormente ejecutado.** Todo el Carril C (C1.1–C4.4) quedó ✅ en
> `ROADMAP.md`, salvo **C4.3 (Stripe + planes)**, que sigue ⬜, y **C4.5 (= B5 observabilidad/CI)**,
> que está 🔵 en progreso (falta solo la parte operativa de backups). Este documento queda como
> bitácora histórica de la priorización original; el estado ítem por ítem vigente vive en
> `ROADMAP.md` (Carril C y B5).

# PLAN — Valor de producto (que la app destaque y se venda sola)

> **Para quién es esto:** hoja de ruta de **features de producto** (no de arquitectura — eso ya lo
> cubren los carriles A y B del `ROADMAP.md`). Describe qué construir para que la app tenga mucho
> valor para los clientes (los negocios que la compran) y destaque frente a "un bot de WhatsApp
> cualquiera". Cada ítem trae: por qué vale, cómo se hace (a grandes rasgos), y su Done.
>
> **Fuente de verdad de arquitectura:** `ROADMAP.md` (este plan vive ahí como **Carril C**). Al
> completar un ítem, marcá su casilla en el MISMO commit (regla de CLAUDE.md).

**Última actualización:** 2026-07-02

---

## 0. Dónde estamos y cuál es la tesis

**Lo que ya hay es una base fuerte:** bot con IA que responde dudas y agenda citas, Google Calendar,
recordatorios automáticos, escalada a humano, panel React con bandeja + CRM + dashboard + PWA/push,
multi-tenant con onboarding por admin, cola durable y recordatorios multi-instancia. El código es
sólido y la costura `/api/panel/*` es estable.

**La tesis del valor:** un negocio paga (y recomienda) esta app cuando le resuelve **cuatro cosas**:

1. **Que el cliente final tenga una experiencia de primera por WhatsApp** — no un bot que solo
   contesta texto, sino uno que entiende audios, cotiza con fotos, y deja confirmar/mover/cancelar
   la cita con botones. (Carril C1–C2)
2. **Que el dueño maneje TODO desde el panel** — su agenda, sus precios, sus horarios, su equipo —
   sin llamar al proveedor. (C3–C4)
3. **Que la app le genere plata, no solo le ahorre tiempo** — menos no-shows, reseñas de Google,
   campañas a clientes existentes. (C5–C6)
4. **Que se pueda vender como producto** — marca del negocio, alta self-serve, cobro recurrente.
   (C7–C8)

El orden de los ítems ya es la priorización: **valor percibido por colón de esfuerzo**, y cada fase
deja algo demostrable en una venta.

---

## Fase 0 — Cerrar lo que está abierto (antes de empezar nada nuevo)

Poco esfuerzo, y sin esto lo nuevo se construye sobre arena:

- [ ] **A8 Fase 4** — verificación del rediseño (design-verify móvil/desktop, claro/oscuro, PWA,
      regresión admin). Ver `PLAN-REDISENO-PANEL.md` §6.
- [ ] **Contraseña temporal del panel** (pedila a Nathan / está en el gestor de contraseñas) — generar hash y rotar.
- [ ] **Plantilla Utility de recordatorios** — dar seguimiento a la aprobación de Meta y setear
      `WHATSAPP_TEMPLATE_RECORDATORIO`. Los recordatorios fuera de 24h dependen de esto (y C1
      construye encima).

---

## Carril C1 — La cita "viva" por WhatsApp (el diferenciador #1)

> Hoy el bot **solo crea** citas. Todo lo demás (mover, cancelar, confirmar) cae en el operador.
> Cerrar el ciclo completo de la cita por WhatsApp es lo que más valor percibido genera y lo que
> más reduce no-shows — el dolor #1 de cualquier negocio con agenda.

### C1.1 Reprogramar y cancelar cita por el bot — esfuerzo M

- **Qué:** dos herramientas nuevas del agente: `reprogramar_cita` y `cancelar_cita` (además de una
  consulta "¿cuándo es mi cita?"). El bot identifica la cita activa del cliente por su número de
  WhatsApp, ofrece horarios alternativos (reusa `consultar_disponibilidad`) y actualiza/cancela.
- **Cómo:** `src/agent/tools.ts` + ejecución en `runAgent.ts`; repo: buscar cita activa por
  `clienteWa` (ya existe la relación en `FichaCliente`), `actualizarCita`/`cancelarCita` en ambos
  repos; sincronizar el evento de Google Calendar (`googleCalendar.ts` ya crea — falta update/delete,
  guardar el `eventId` en la cita si no se guarda ya). Refuerzos de prompt en `systemPrompt.ts`.
- **Done:** un cliente real mueve y cancela su cita solo por chat; el Calendar y el panel quedan
  consistentes; el recordatorio de la cita vieja no sale.

### C1.2 Mensajes interactivos (botones y listas nativas de WhatsApp) — esfuerzo M

- **Qué:** usar los mensajes `interactive` de la Cloud API: **botones** (hasta 3: "Confirmo ✅ /
  Reprogramar / Cancelar") y **listas** (elegir servicio u horario de una lista desplegable en vez
  de escribirlo). Se siente app nativa, no chat con un robot — es lo primero que impresiona en una
  demo.
- **Cómo:** `src/whatsapp/client.ts`: funciones `enviarBotones()`/`enviarLista()` (solo Graph API,
  cero dependencias nuevas); el webhook ya parsea texto — agregar el parseo de la respuesta
  `interactive` (llega con `id` del botón/fila) y traducirla a texto para el agente o a una acción
  directa. Aplicarlo primero donde más rinde: recordatorios (C1.3) y elección de horario al agendar.
- **Done:** el flujo de agendado ofrece horarios como lista; el cliente confirma con un tap.

### C1.3 Recordatorio con confirmación (anti no-show) — esfuerzo S (depende de C1.2)

- **Qué:** el recordatorio del día antes lleva botones "Confirmo / Necesito moverla". La respuesta
  marca la cita como **confirmada** (visible en el panel y en la agenda C3.1) o dispara el flujo de
  reprogramación (C1.1). Métrica de no-show en el dashboard.
- **Cómo:** `scheduler.ts` envía interactive (o la plantilla Utility con botones, para fuera de
  24h); columna `confirmada_en` en `wa_citas`; badge en el panel.
- **Done:** el dueño ve en su agenda qué citas de mañana están confirmadas y cuáles no.

### C1.4 Notas de voz → el bot las entiende — esfuerzo S

- **Qué:** en CR (y en LatAm en general) la gente **manda audios**. Hoy son "no-texto" y caen al
  operador. Transcribirlas y que el bot responda normal es un "wow" inmediato y baja la carga humana.
- **Cómo:** el webhook ya detecta multimedia; para `audio`: descargar el media de Graph API
  (`GET /media/{id}` con el token, ya se tiene todo) → transcribir con el SDK de OpenAI que ya está
  instalado (`audio.transcriptions`, modelo `whisper-1` o `gpt-4o-mini-transcribe`) → inyectar el
  texto al flujo normal como si fuera mensaje de texto (marcado "[audio]" en el historial del panel).
- **Done:** un cliente pide cita por nota de voz y el bot la agenda sin intervención humana.

### C1.5 Fotos → cotización con visión — esfuerzo M

- **Qué:** el cliente manda la foto del parabrisas/carro y el bot la usa para cotizar o al menos
  para dar contexto al operador ("parabrisas con rayas profundas, lado del conductor"). Para un
  lavacar es EL caso de uso multimedia; para otros rubros (talleres, jardinería…) igual.
- **Cómo:** mismo pipeline de descarga de media que C1.4; pasar la imagen a `gpt-4o-mini` (ya
  soporta visión) con instrucciones del tenant (qué puede cotizar por foto y qué no — va en la
  config JSONB del tenant). Si la confianza es baja → escalar a humano con la foto adjunta en el
  panel (mostrar la imagen en el chat del panel: hoy solo hay texto).
- **Done:** foto de parabrisas → respuesta útil del bot; la imagen se ve en el panel.

---

## Carril C2 — Panel: de bandeja a centro de operaciones

> El operador ya puede chatear; lo que un **dueño** pide apenas ve la demo es "¿y dónde veo mis
> citas?" y "¿cómo cambio un precio?". Sin esto, cada ajuste pasa por el superadmin (vos) — no escala
> y resta valor percibido.

### C2.1 Vista Agenda (citas del día/semana) — esfuerzo M

- **Qué:** tercera tab en el panel (Inbox / **Agenda** / Panel): lista de citas por día con
  navegación de semana, estado (pendiente/confirmada/completada/cancelada/no-show), y acciones:
  **crear cita manual** (cliente que llama por teléfono), editar, cancelar (avisando al cliente por
  WhatsApp con un tap). Es la pantalla que el dueño abre cada mañana.
- **Cómo:** el backend ya tiene `citasPorFecha`; API nueva aditiva `/api/panel/citas` (GET por rango,
  POST/PATCH). UI a mano con el sistema de diseño actual (nada de librerías de calendario — una
  lista agrupada por día basta y luce mejor en móvil). Estados nuevos como columna `estado` en
  `wa_citas` (aditivo).
- **Done:** el dueño gestiona su día completo desde el celular sin tocar Google Calendar.

### C2.2 Configuración self-service del negocio — esfuerzo L

- **Qué:** sección "Mi negocio" en el panel (rol dueño): editar **servicios y precios**, **horario**,
  **feriados/bloqueos** ("el sábado no trabajo", "vacaciones del 10 al 15"), y la **base de
  conocimiento** del bot (preguntas frecuentes en bloques de texto). Cambios en vivo, sin redeploy
  ni superadmin.
- **Cómo:** la config ya vive en JSONB (`wa_tenants`, B2) con recarga on-demand del `tenantStore` —
  el trabajo grande es la **UI de edición** (reusar patrones del formulario de onboarding
  `FormularioNegocio.tsx`) + endpoints `/api/panel/config` (GET/PUT con validación server-side, la
  misma del alta). Los bloqueos alimentan `availability.ts` (hoy solo horario regular).
- **Done:** el dueño sube un precio y el bot cotiza el nuevo en el siguiente mensaje.

### C2.3 Estados de conversación + multi-operador — esfuerzo M

- **Qué:** (a) estado explícito de conversación (**abierta / atendida**) para que "Marcar atendido"
  (ya existe como acción rápida) sea real y la bandeja se pueda filtrar como cola de trabajo;
  (b) **varios usuarios por tenant** con rol (dueño / operador) — hoy es un login por negocio, y
  cualquier negocio con 2+ empleados lo pide de inmediato.
- **Cómo:** columna `estado` en conversaciones + filtro pill nuevo; `wa_usuarios` ya existe (B2) —
  agregar `rol` y CRUD de usuarios en "Mi negocio" (solo dueño). "Mi negocio" (C2.2) se esconde
  para operadores.
- **Done:** dos empleados atienden sin pisarse y el dueño controla quién entra.

---

## Carril C3 — Motor de crecimiento (que la app genere plata visible)

> Aquí es donde el pitch pasa de "te ahorro tiempo" a "te traigo clientes". Es lo que justifica el
> precio mensual y lo que ningún bot básico ofrece.

### C3.1 Seguimiento post-servicio + reseñas de Google — esfuerzo S

- **Qué:** unas horas después de la cita completada, mensaje automático: "¿Cómo quedó el carro? 🚗"
  con botones (bien / mal). Si **bien** → pedir reseña con el link de Google Maps del negocio (el
  activo de marketing más valioso de un negocio local). Si **mal** → escalar a humano ANTES de que
  se convierta en reseña negativa.
- **Cómo:** reusa el scheduler de recordatorios (nuevo tipo `post_servicio`, mismas garantías B4) +
  C1.2 para los botones; `linkReseñas` en la config del tenant. Necesita marcar citas como
  completadas (estado de C2.1) o asumir completada al pasar la hora.
- **Done:** el dueño ve subir sus reseñas y el panel intercepta las malas experiencias.

### C3.2 Campañas / promos segmentadas — esfuerzo L

- **Qué:** ya está en los pendientes del ROADMAP; aquí se le da forma: desde el panel, enviar una
  promo por plantilla MARKETING a un **segmento del CRM** ("los que no vienen hace 60+ días", "los
  que se hicieron pulido hace 6 meses"), con **opt-out obligatorio** ("escribí BAJA"), programación
  de envío y métricas (entregados / respuestas / citas generadas). La cola B1 ya da la
  infraestructura de envío con reintentos (nuevo tipo de job).
- **Cómo:** plantilla MARKETING aprobada + costo por mensaje visible en la UI antes de enviar;
  columna `optOut` en clientes (respetada por TODO envío saliente); segmentos = queries sobre datos
  que ya existen (última cita, último mensaje, servicio). UI: sección "Campañas" con historial.
- **Done:** una campaña real a ≥20 clientes inactivos genera citas medibles y nadie sin opt-in
  recibe spam (cumplimiento Meta).

### C3.3 Dashboard de dueño: plata, no solo mensajes — esfuerzo S

- **Qué:** elevar el dashboard (ya rediseñado en A8) a métricas de negocio: **ingresos estimados por
  período**, tasa de no-show (C1.3), clientes nuevos vs. recurrentes, citas generadas por el bot vs.
  manuales, y "cuánto te ahorró el bot" (mensajes atendidos sin humano). Es el número que renueva la
  suscripción.
- **Cómo:** todo con datos que ya existen o que C1/C2 agregan; `src/panel/metricas.ts` (aditivo).
- **Done:** el dashboard responde "¿me sirve pagar esto?" en una pantalla.

---

## Carril C4 — SaaS vendible (white-label + alta + cobro)

> Con C1–C3 la app **vale**; C4 hace que se pueda **vender y cobrar** sin fricción. Va de último
> porque no agrega valor al piloto, pero es lo que convierte esto en negocio.

### C4.1 White-label real por tenant — esfuerzo S

- **Qué:** que el panel se pinte con la marca de cada negocio: nombre, logo, color de acento y de
  header. La base ya está lista: A8 dejó las variables `--brand-*` en `global.css` pensadas para esto.
- **Cómo:** campos `marca` en la config JSONB del tenant (editable en C2.2 y en el onboarding);
  `/api/panel/me` ya devuelve datos del tenant — agregar la marca y setear las CSS vars al cargar.
  Logo = upload chico o iniciales generadas (como el chip "LR" actual).
- **Done:** dos tenants abren `/panel` y cada uno ve SU marca (demo de venta potentísima).

### C4.2 Conexión de WhatsApp guiada (Embedded Signup) — esfuerzo L

- **Qué:** hoy conectar un número requiere pasos manuales en Meta. El **Embedded Signup** de Meta
  permite que el negocio conecte su WhatsApp Business desde el onboarding con un popup de Facebook.
  Es el paso que separa "consultoría con software" de "SaaS".
- **Cómo:** requiere app de Meta con Embedded Signup aprobado (tramitar temprano: el review toma
  tiempo); el flujo devuelve `phone_number_id` + token → se guardan en el tenant (B2/B3 ya dejaron
  el alta sin redeploy). Mientras se aprueba, mantener el alta asistida por admin como está.
- **Done:** un negocio nuevo queda operativo el mismo día sin que nadie toque `.env` ni Meta a mano.

### C4.3 Facturación (Stripe) + planes — esfuerzo L

- **Qué:** suscripción mensual con planes (p. ej. Básico: bot + panel / Pro: + campañas + multi-
  usuario + white-label), trial, y suspensión suave por impago (el bot avisa, no se apaga de golpe).
- **Cómo:** Stripe Checkout + customer portal (mínima superficie propia: Stripe hace la UI de tarjeta
  y facturas); webhook de Stripe → estado `plan`/`activo` en `wa_tenants`; gates por plan en el panel
  y el backend. **Política de deps aplica** al SDK de Stripe (cumple las 3 reglas de sobra; fijar
  versión +1 mes).
- **Done:** un cliente paga solo, y el estado de su cuenta gobierna qué features tiene.

### C4.4 Landing de venta — esfuerzo S (plan de ejecución: `PLAN-C4.4-LANDING.md`)

- **Qué:** página pública (en el mismo server) que venda el producto: demo del chat, screenshots del
  panel (claro/oscuro), precios, y CTA a WhatsApp ("hablá con nuestro bot" — el producto se demuestra
  a sí mismo: el bot de ventas ES la demo).
- **Cómo:** estática, servida por el Node actual; usar los skills de diseño web para que luzca al
  nivel del panel. El "bot vendedor" es un tenant más del sistema (¡dogfooding!).
- **Done:** un link que se puede mandar a cualquier negocio interesado y convierte.

### C4.5 Observabilidad + CI/CD (= B5 del ROADMAP) — esfuerzo M

- Ya definido como B5; entra aquí como prerequisito de vender a N clientes: Sentry, uptime, alertas,
  deploy automatizado. Sin esto, el primer bug con 10 clientes se convierte en 10 llamadas.

---

## Resumen de priorización

| # | Ítem | Valor para el cliente | Esfuerzo | Depende de |
|---|------|----------------------|----------|------------|
| 0 | Fase 0 (cerrar pendientes) | — | S | — |
| 1 | C1.1 Reprogramar/cancelar por bot | Muy alto | M | — |
| 2 | C1.2 Botones y listas interactivas | Muy alto (demo) | M | — |
| 3 | C1.3 Recordatorio con confirmación | Muy alto (no-shows) | S | C1.2 |
| 4 | C1.4 Notas de voz (Whisper) | Muy alto (LatAm) | S | — |
| 5 | C2.1 Vista Agenda en el panel | Muy alto (dueño) | M | — |
| 6 | C1.5 Fotos → cotización | Alto | M | C1.4 (pipeline media) |
| 7 | C2.2 Config self-service | Alto (escala) | L | — |
| 8 | C3.1 Post-servicio + reseñas | Alto (plata visible) | S | C1.2, C2.1 |
| 9 | C2.3 Estados + multi-operador | Medio-alto | M | — |
| 10 | C3.3 Dashboard de dueño | Medio-alto | S | C1.3, C2.1 |
| 11 | C3.2 Campañas segmentadas | Alto (revenue) | L | plantilla MKT |
| 12 | C4.1 White-label por tenant | Alto (venta) | S | — |
| 13 | C4.5 Observabilidad (B5) | — (interno) | M | — |
| 14 | C4.2 Embedded Signup | Alto (escala) | L | tramitar review ya |
| 15 | C4.3 Stripe + planes | — (negocio) | L | — |
| 16 | C4.4 Landing de venta | Alto (ventas) | S | C4.1 |

**Lectura rápida del orden:** primero todo lo que hace WOW en una demo y reduce no-shows (C1),
en paralelo la Agenda (C2.1) que es lo primero que pide un dueño; después autonomía del dueño (C2.2)
y plata visible (C3); de último la maquinaria de vender (C4) — pero **tramitando el Embedded Signup
de Meta desde ya**, porque su aprobación es lenta y no bloquea nada mientras tanto.

---

## Reglas del juego (no negociables, heredadas del repo)

- **La API `/api/panel/*` es una costura estable** — todos los cambios de contrato son aditivos
  (campos/endpoints opcionales nuevos).
- **Política de dependencias de CLAUDE.md** — casi todo este plan se hace con lo que ya está
  instalado (OpenAI SDK cubre Whisper y visión; los mensajes interactivos son Graph API puro).
  Excepciones esperadas: SDK de Stripe (C4.3). Nada de CDNs.
- **Cumplimiento Meta:** el bot sigue siendo soporte acotado; campañas SOLO con plantilla MARKETING
  aprobada y opt-out respetado en todo envío. No arriesgar el número por marketing agresivo.
- **Todo multi-tenant desde el día uno:** cada feature se configura por tenant (JSONB), nunca
  hardcodeada a Rosales — la regla que ya sigue el repo.
- **ROADMAP.md vivo:** cada ítem completado se marca en el mismo commit (Carril C).
