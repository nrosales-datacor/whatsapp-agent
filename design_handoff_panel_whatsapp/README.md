# Handoff: Rediseño UX/UI — Panel del agente de WhatsApp IA (white-label)

## Estado de implementación
**Leyenda:** ✅ hecho · ⬜ pendiente · 🔶 parcial

- ✅ **Bandeja / Inbox** — medidor de interés, señal "necesita respuesta", header de chat simplificado. Ver ROADMAP A9.
- ✅ **Panel / Dashboard** — hero de rescate, KPIs agrupados (Dinero/Actividad/Riesgo), gráfico vertical. Ver ROADMAP A9.
- ✅ **Mi negocio — editor de servicios** — tarjetas por servicio con grip de arrastre (reordena de verdad), chip de slug editable, pill "Agendable", switches alineados con ayuda, campos de add-on condicionales. Ver ROADMAP A9.
- ✅ **Agenda — línea de tiempo** — timeline por hora (bloques posicionados por hora+duración del servicio), pills Confirmada/Pendiente/Sin confirmar·riesgo (derivadas en el cliente, sin campo nuevo de backend), rail "Resumen del día" + aviso de riesgo, lista simple hora+tarjeta en móvil, modal de detalle con las acciones (antes inline en la fila). Ver ROADMAP A9.
- ✅ **Ficha del cliente (modal)** — header propio (avatar + nombre + pill "Cliente frecuente" + teléfono) sobre el `.ficha-head` genérico; datos clave en tiles 2×2; historial de servicios como timeline vertical con puntos de color por estado; notas privadas en bloque cálido diferenciado. Ver ROADMAP A9d.
- ✅ **Login** — layout de dos paneles en desktop (marca a la izquierda, form a la derecha) que colapsa a un bloque de marca compacto en móvil; ojo para mostrar/ocultar contraseña; "¿La olvidaste?" y "¿Problemas para entrar? Escribinos" apuntan al WhatsApp de soporte real (no hay backend de recuperación de contraseña). Ver ROADMAP A9e.
- ✅ **Estados vacíos y de error** — `EstadoVacio`/`ErrorState` (creados en A9c) extendidos a todo el panel: vacío de "sin conversación" con CTA a la que necesita respuesta, `ErrorState` con ícono cloud-off + tono cálido + reintentar con ícono, y vacíos ad-hoc (bandeja, usuarios, campañas, servicios) migrados al mismo patrón. Ver ROADMAP A9f.
- 🔶 **Design Tokens** — color (white-label + dark mode) y números tabulares adoptados sobre el sistema de tokens ya existente en `global.css` (de un rediseño previo, A8). NO se igualaron 1:1 los valores de este doc: tipografía body (pide Roboto, el codebase usa Noto Sans + Inter), radios (pide 6/8/12/18px, el codebase usa 10/16/999px) ni sombras en 3 capas (el codebase tiene 2, `--shadow`/`--shadow-overlay`).

---

## Overview
Rediseño visual/UX del panel web de administración de un **agente de WhatsApp con IA para lavacars**, vendido como SaaS **white-label multi-tenant**. El panel es donde el negocio supervisa las conversaciones que lleva el bot, las citas, las métricas y la configuración.

Dos roles: **Operador** (vive en la Bandeja) y **Dueño** (además ve Panel, Agenda, Mi negocio, Usuarios, Campañas).

El objetivo del rediseño es que el panel se sienta **premium** (referencia: Linear, Stripe Dashboard, Vercel): jerarquía tipográfica fuerte, neutrales sofisticados, elevación en capas, acento por tokens (configurable por negocio), números tabulares. Copy en **español de Costa Rica (voseo)**.

## About the Design Files
El archivo de este bundle (`Rediseño Panel WhatsApp.dc.html`) es una **referencia de diseño creada en HTML** — un prototipo que muestra el look y el comportamiento deseados, **no código de producción para copiar tal cual**. La tarea es **recrear estos diseños en el entorno existente del codebase** (React/Vue/etc.) usando sus patrones y librerías. Si no hay entorno todavía, elegí el framework más apropiado e implementá ahí.

Es un **rediseño solo visual/UX**: la estructura de datos y las acciones ya existen. No inventes features de backend. Podés reorganizar, jerarquizar, agrupar y mejorar el microcopy.

El HTML de referencia usa Design Components (`.dc.html`) solo como formato de prototipado; **ignorá ese runtime** y traducí el marcado + estilos inline a componentes del codebase. Los estilos están inline y todo el color/tipografía/elevación sale de variables CSS declaradas en el `:root` del contenedor raíz — esa es la fuente de verdad de los tokens (ver **Design Tokens**).

## Fidelity
**Alta fidelidad (hifi).** Colores, tipografía, espaciado y estados son finales. Recreá la UI de forma fiel usando las librerías/patrones del codebase. Las medidas y hex de abajo son las de referencia.

## Restricciones que NO se pueden romper
1. **White-label:** `--accent` y `--header` son **configurables por negocio** (hoy verde). Nada puede depender de un color fijo: definí todo con tokens; cambiar el acento debe repintar todo con coherencia. El acento se usa **con moderación** (CTAs, estado activo, un dato clave), no en bloques grandes.
2. **Tema claro y oscuro** deben quedar bien ambos. Este bundle entrega **claro**; el oscuro debe ser intencional (no un claro invertido) — usar el mismo set de tokens con valores oscuros.
3. **Mobile-first / responsive:** móvil = **bottom nav** (6 ítems); desktop = **tabs segmentadas** en el header. Anchuras de referencia 390px y 1440px.
4. Es una **PWA**: densidad táctil, áreas de toque ≥ 44px.
5. Copy en **español de Costa Rica (voseo):** "agendá", "escribí", "cotización", "¿La olvidaste?".

---

## Design Tokens
Declarados como variables CSS en el contenedor raíz del prototipo. El acento y el header derivan del prop de tenant; el resto son fijos del sistema.

### Color — neutrales (tema claro)
| Token | Hex | Uso |
|---|---|---|
| `--bg-page` | `#F4F6F6` | Fondo de página / zonas sutiles |
| `--surface` | `#FFFFFF` | Tarjetas y superficies elevadas |
| `--surface-2` | `#FAFBFB` | Chrome de ventana / barras |
| `--fg-1` | `#132320` | Texto principal / títulos (near-black frío) |
| `--fg-2` | `#54655F` | Texto secundario |
| `--fg-3` | `#8A9691` | Texto terciario / labels / timestamps |
| `--fg-4` | `#AAB4B0` | Íconos desactivados / hints |
| `--border` | `#E7ECEA` | Borde sutil (1px) |
| `--border-strong` | `#D6DDDA` | Borde de inputs / separadores fuertes |

### Color — acento (white-label; default tenant "Lavacar Rosales")
Derivados en runtime desde `--accent` mezclando con negro/blanco.
| Token | Hex default | Derivación |
|---|---|---|
| `--accent` | `#0F7A66` | color base del tenant |
| `--accent-hover` | `#0C6353` | mix(accent, #000, 16%) |
| `--accent-active` | `#0A5446` | mix(accent, #000, 30%) — texto sobre soft |
| `--accent-soft` | `#E4F2EE` | mix(accent, #fff, 86%) — fondos tint |
| `--accent-softer` | `#F0F8F5` | mix(accent, #fff, 93%) — fila activa |
| `--header` | `#0F3D34` | color del encabezado (configurable aparte) |

Presets white-label ofrecidos en el prototipo (acento / header): verde `#0F7A66`/`#0F3D34`, azul `#248DE3`, violeta `#7A3FF2`, terracota `#C7513B`. Header alterno: `#103050`, `#1E1B2E`, `#2A2A2E`.

### Color — semántico (sobrio)
| Token | Hex | Soft |
|---|---|---|
| `--success` | `#1F9D57` | `--success-soft` `#E7F4EC` |
| `--warning` | `#B5730A` | `--warning-soft` `#FAF0DC` |
| `--danger` | `#C72B3F` | `--danger-soft` `#FBEAEC` |
| `--info` | `#248DE3` | `--info-soft` `#E6F0FB` |

Uso semántico: **éxito**=completada; **warning/ámbar**=riesgo (no-show, sin confirmar, "necesita respuesta"); **danger**=error de carga; **info**=cita pendiente.

### Tipografía
- **Display / títulos / números clave:** `Noto Sans` (700–800, letter-spacing -0.015 a -0.02em).
- **Cuerpo / UI / datos:** `Roboto` (400–600).
- **Números tabulares:** en TODA métrica, dinero, hora, teléfono, placa y fecha → `font-variant-numeric: tabular-nums; font-feature-settings:"tnum"`.
- Escala usada: display 44px · h2 30px · h3 24–26px · valor KPI 30px (héroe 52px) · body 14px · label 12–13px · caption 11–12px. Eyebrow 12px uppercase +0.14em.

### Espaciado
Base 4px. Escala: 4, 8, 12, 16, 24, 32, 48, 64. Padding de tarjeta 16–22px; gap de grilla 16–20px.

### Radios
`--r-sm` 6px · `--r-md` 8px · `--r-lg` 12px · `--r-xl` 18px (frames). Pills/avatares 50%/999px. La mayoría de la UI usa 8–9px.

### Elevación (sombras en capas)
- `--sh1` (tarjeta en reposo): `0 1px 2px rgba(16,32,28,.05), 0 1px 3px rgba(16,32,28,.05)`
- `--sh2` (destacado / KPI héroe): `0 4px 14px rgba(16,32,28,.07), 0 2px 5px rgba(16,32,28,.05)`
- `--sh3` (modal / menú / frame): `0 18px 44px rgba(14,30,26,.16), 0 5px 12px rgba(14,30,26,.07)`
Preferir bordes finos + sombras suaves sobre bordes duros. Sin acentos de borde izquierdo de color en tarjetas KPI.

### Iconografía
**Lucide** (stroke 1.5px), tamaños 12/16/20/22px, `currentColor`. Íconos usados: message-square, bar-chart-2, calendar, settings, users, send, moon, log-out, search, bot, user, alarm-clock, clock, calendar-plus, file-text, check-check, hand, paperclip, send-horizontal, shield-check, trending-up, banknote, receipt, plus-circle, messages-square, calendar-check, target, alert-triangle, star, hash, grip-vertical, trash-2, chevron-down/left/right, x, lock, eye, cloud-off, rotate-cw, calendar-days, message-square-dashed, bell, plus, signal, wifi, battery-full.

---

## Screens / Views

### 1. Bandeja / Inbox (PRIORITARIA) — desktop (lista + chat) y móvil ✅ HECHO
**Propósito:** el operador ve las conversaciones que lleva el bot y decide cuándo intervenir.

**Layout desktop (1440):** header 64px + body flex. Lista izquierda 372px (`--surface`, borde derecho) + chat flex.

**Lista:**
- Búsqueda (input con ícono search, `--bg-page`, radio 9px).
- Filtros segmentados (pills): "Todos 16" (activo = fondo `--accent`, texto blanco), "Bot 15", "Vos 1", y **"Necesita respuesta 1"** (fondo `--warning-soft`, texto `--warning`, con punto ámbar).
- **Fila de conversación:** avatar 42px (iniciales en `Noto Sans`; teléfonos muestran ☎), nombre (Noto Sans 14.5 semibold) + hora (fg-3, tabular), preview truncado (fg-2), y a la derecha: badge sin-leer (círculo `--accent`) + pill de canal ("Bot" gris con ícono bot / "Vos" ámbar con ícono user).
- **Medidor de interés** (reemplaza el "lead score" críptico 90/75/65…): 3 barras ascendentes + etiqueta "Interés alto/medio/bajo". Bucket: ≥80 alto (3 barras acento), 60–79 medio (2 acento), <60 bajo (1 acento); resto `--border-strong`.
- **Señal "necesita que intervengás":** barra ámbar de 3px en el borde izquierdo de la fila + fondo `--warning-soft` + chip ámbar ("Sin responder 22m" o "Pidió hablar con vos"). Fila activa: fondo `--accent-softer`.

**Chat:**
- Header en **una sola línea de estado**: avatar, nombre, pill "Lo atiende el bot", y meta (teléfono · "Ventana cierra en 23 h 52 m" · link "Ver ficha del cliente").
- **Acciones con jerarquía:** primaria "Agendá cita" (fondo `--accent`), secundarias "Cotización" y "Atendido" (outline), separador, y "Atender yo" (fondo `--fg-1`, oscuro) a la derecha.
- **Burbujas:** bot = fondo `--accent-soft`, sin borde, esquina 4px arriba-izq, etiqueta "AGENTE IA" arriba; cliente = `--surface` con borde, alineada a la derecha. Timestamps tabulares. Barra "Hoy" centrada.
- Composer: adjuntar + input + botón enviar (44px, `--accent`).

**Layout móvil (390):** header de marca (LR + nombre + moon/salir) sobre `--header`; búsqueda + filtros scrollables; lista con las mismas filas (avatar 40px); **bottom nav** de 6 ítems (Bandeja activo con badge 2). Barra de estado iOS simulada 9:41.

**Cambios clave:** score→medidor con leyenda; señal ámbar de intervención; avatar con iniciales; "Vos" en vez de "HUMANO"; acciones jerarquizadas.

### 2. Panel / Dashboard (PRIORITARIA) — desktop y móvil ✅ HECHO
**Propósito:** el dueño ve el rendimiento del bot; el dato #1 es **plata rescatada por el bot**.

**Layout desktop:** header + contenido con título "Panel · Lavacar Rosales", subtítulo "Resumen de los últimos 30 días" y selector de rango segmentado (7 días / 30 días activo / Año).

- **KPI héroe — "Plata rescatada por el bot":** tarjeta full-width, `--sh2`. Número grande 52px `Noto Sans` en `--accent-active` con ₡ discreto. Texto de contexto en lenguaje del dueño ("El bot recuperó 4 conversaciones que se iban a perder…"). Fila de sub-métricas (Tasa de rescate 67% · Sin intervención humana 94% · +18% vs. mes). **Sparkline** SVG (área + línea `--accent`) a la derecha.
- **Grupos** (los 12 KPIs planos ahora agrupados, con separador de sección eyebrow):
  - **Dinero** (grid 3 col): Ingresos estimados ₡180 000, Ticket promedio ₡17 818, Extra por add-ons ₡16 000. Cada uno con ícono en chip `--accent-soft`, número 30px tabular, y delta con flecha + color semántico (▲ verde sube).
  - **Actividad del bot** (grid 2 col): Conversaciones 16, Citas agendadas 11, Conversión 69%, Ahorro del bot 94%. Ícono en chip neutro.
  - **Riesgo y calidad** (grid 2 col): Tasa de no-show 50% (ícono danger), Tasa de rescate 67% (success), Aceptación de upsell 67% (success), Reseñas enviadas 2. Chip de ícono coloreado por tono.
- **Gráfico "Citas por día":** barras verticales con aire (10 días), altura proporcional, valor arriba, última barra en `--accent`, resto `--accent-soft`.

**Layout móvil:** héroe compacto (40px) + grupos Dinero y Actividad en grid 2 col; bottom nav (Panel activo). (El gráfico se omite en móvil, es aceptable.)

**Cambios clave:** agrupación en 3 secciones; héroe de rescate; deltas semánticos; gráfico con aire.

### 3. Mi negocio — editor de servicios — desktop y móvil ✅ HECHO
**Propósito:** configurar qué puede cotizar/agendar el bot. Corrige el editor apretado actual.

**Layout desktop:** contenido centrado 920px. Título "Servicios" + subtítulo + botón "Nuevo servicio" (`--accent`).
- **Tarjeta por servicio** (`--surface`, `--sh1`): cabecera con handle de arrastre (grip-vertical), nombre visible (Noto Sans 17 semibold), chip de slug monospace (`#hash`), pill "Agendable", botón borrar.
- Cuerpo en grid 1.4fr / 1fr:
  - Izquierda: "Nombre visible" (input) y "Nota de precio" (textarea, "según vehículo…").
  - Derecha: "Precio base" (con ₡, tabular) + "Duración"; luego un bloque `--bg-page` con **3 switches** alineados, cada uno con título + ayuda: **Precio variable**, **Agendable**, **Ofrecer add-on**. El add-on solo muestra sus campos ("Add-on sugerido" select + "Precio promo") **cuando el switch está activo**.
- **Switch:** pista 42×24 (on = `--accent`, off = `--border-strong`), knob 20px blanco con `--sh1`, translate a 20px/2px.

**Layout móvil:** una tarjeta apilada, campos a ancho completo, switches ocupando el ancho; bottom nav (Negocio activo).

**Cambios clave:** tarjetas que respiran; switches alineados con ayuda; campos del add-on condicionales; sin inputs truncados.

### 4. Agenda — día con línea de tiempo — desktop y móvil ✅ HECHO
**Propósito:** ver las citas del día. Corrige el vacío/poca densidad actual.

**Layout desktop:** header + toolbar (segmentado Día/Semana, ‹ Hoy ›, "Viernes 18 de julio", botón "Nueva cita"). Grid 1fr / 300px.
- **Timeline** (`--surface`): cabecera "Citas del día · 5 citas · 8 a.m. – 4:30 p.m.". Contenedor relativo: filas de hora (7 a.m.–6 p.m., 64px cada una, borde superior, label en el gutter de 72px) + capa absoluta con **bloques de cita** posicionados por `top`/`height` calculados desde la hora de inicio (1h = 64px). Cada bloque: borde izquierdo de 3px con color de estado, nombre + hora tabular, "servicio · vehículo" truncado, pill de estado.
- **Estados de cita:** Confirmada (`--accent`/`--accent-soft`), Pendiente (`--info`/`--info-soft`), Sin confirmar · riesgo (`--warning`/`--warning-soft`).
- **Resumen del día** (rail derecho): Citas 5, Ingreso estimado ₡89 000 (acento), Sin confirmar → chip "1 en riesgo". Debajo, tarjeta ámbar de aviso ("Rafael no confirmó las 3:30 p.m." + "Enviar recordatorio →").

**Layout móvil:** lista de citas con hora a la izquierda y tarjeta con borde de estado a la derecha; bottom nav (Agenda activo).

**Notas de implementación:**
- El schema de `Cita` no tiene un estado explícito para Confirmada/Pendiente/Riesgo — se derivan en el cliente desde `confirmadaEn`/`recordatorioMismoDiaEn` (ver `estadoVisual()` en `Agenda.tsx`), sin agregar campos nuevos de backend. "Riesgo" = ya se envió el recordatorio del mismo día y el cliente no confirmó.
- El rango de horas del timeline es dinámico (7–18 por default, se expande si alguna cita cae fuera) en vez de fijo, para no recortar citas tempranas/tardías.
- Sin endpoint de "reenviar recordatorio" (no existe en el backend y no se inventó uno): el CTA del aviso de riesgo ("Ver en la agenda →") hace scroll + resalta el bloque correspondiente en vez de disparar un envío.
- Las acciones por cita (Confirmar/Reprogramar/Completar/No se presentó/Cancelar), antes siempre visibles en la fila, ahora viven en un modal de detalle que se abre al tocar el bloque/fila — el timeline de referencia no tiene lugar para botones inline.

### 5. Ficha del cliente (modal) ✅ HECHO
**Propósito:** ver datos, historial y notas de un cliente.

**Layout:** overlay `rgba(19,35,32,.55)` + modal 560px centrado, `--sh3`, radio 16px.
- Header: avatar 52px, nombre (Noto Sans 20), pill "Cliente frecuente" (star), teléfono tabular, botón cerrar (x).
- **Datos clave:** grid 2×2 de tiles (`--bg-page`): Vehículo·Placa (Toyota Hilux · C 162345), Total de citas (2), Última visita (18/07/2026), Cliente desde (17/07/2026). Números tabulares.
- **Historial de servicios:** línea de tiempo vertical con puntos de color por estado (success=completada, accent=agendada), nombre del servicio + fecha/hora tabular + estado.
- **Notas privadas:** bloque diferenciado con fondo cálido `#FBF7EE`, borde `#EEE3CC`, título con candado, texto y botón "Guardar notas" (`--accent`).

**Cambios clave:** 3 bloques jerárquicos; datos en tiles; historial como timeline; notas separadas visualmente.

**Notas de implementación:**
- El componente ya existía (`FichaModal.tsx`, cableado a `GET/POST /api/panel/conversaciones/:id/ficha|notas` desde A4) — este paso fue **solo el rediseño visual**, sin tocar la capa de datos.
- **"Cliente frecuente"** no es un campo de backend: se deriva en el cliente (`totalCitas >= 3`), mismo criterio que `estadoVisual()` en Agenda. El seed de demo no genera ningún cliente con 3+ citas (el máximo es 2), así que el pill no se pudo verificar contra datos reales — igual que pasó con el estado "riesgo" en A9c.
- Colores de la tarjeta de notas y del pill "Cliente frecuente" son **tokens fijos** (`--notas-bg/--notas-border/--notas-fg`, `--frecuente/--frecuente-soft`), no derivados de `--accent`: son bloques semánticos (privacidad, reconocimiento), no deben cambiar de color al cambiar el acento del tenant. Modo oscuro con valores propios (cálido oscuro intencional, no un claro invertido).
- El historial reusa las clases `badge-estado`/`.completada`/`.cancelada`/`.no_show` que ya existían para Agenda, en vez de crear un set de badges paralelo.

### 6. Login (desktop y móvil) ✅ HECHO
**Propósito:** acceso white-label.

**Layout desktop (900×600):** panel de marca izquierdo (360px, fondo `--header`, texto blanco): logo LR + nombre arriba, titular "Tu asistente atiende, cotiza y agenda por vos." + subtítulo al medio, footer discreto. Panel derecho (`--surface`): tarjeta 320px con "Ingresá a tu panel", campo Correo, campo Contraseña (con "¿La olvidaste?" y ojo), botón "Entrar" (`--accent`), y "¿Problemas para entrar? Escribinos".

**Layout móvil:** logo LR 56px, nombre, subtítulo, campos, botón "Entrar", link "Recuperala" abajo.

**Notas de implementación:**
- **Campo "Correo" → se mantuvo "Usuario".** El backend loguea con un campo `usuario` (slug tipo `lavacar-rosales`, `POST /api/panel/login`), no un email — cambiar la etiqueta a "Correo" sin cambiar el backend habría sido mentirle al operador sobre qué tiene que escribir. Se respetó el resto del layout (dos paneles, ojo, links) tal cual el mock.
- **"¿La olvidaste?" y "¿Problemas para entrar? Escribinos" no llaman a ningún backend** (no existe recuperación de contraseña self-service ni un canal de soporte por email) — ambos apuntan al mismo número de WhatsApp de soporte (`wa.me`) que ya usa la landing para ventas/demo, con un mensaje precargado distinto cada uno. Es el reflejo honesto del proceso real hoy (alguien del equipo resetea el hash a mano), no una promesa de un flujo que no existe.
- `#login` se mantiene como el formulario centrado de siempre (reusado tal cual por `CambiarClaveObligatorio.tsx`, sin el panel de marca); `Login.tsx` lo envuelve en un `.login-shell` nuevo que agrega el panel izquierdo — así no hubo que tocar la pantalla de cambio de clave obligatorio.

### 7. Estados vacíos y de error ✅ HECHO
- **Vacío — sin conversación:** ícono en chip `--accent-soft` (message-square-dashed), "Elegí una conversación", ayuda cálida, y CTA secundaria "Ver la que necesita respuesta" (con ícono ámbar).
- **Error de carga:** ícono danger (cloud-off), "No pudimos cargar las campañas", tono tranquilo ("Tus datos están a salvo…"), CTA "Reintentar" (`--accent`, rotate-cw).
- **Vacío — agenda sin citas:** ícono acento (calendar-days), "Sin citas para este día", ayuda, CTA "Agendá la primera" — ya hecho en A9c.

Patrón: chip de ícono 56px + título Noto Sans 18 + ayuda fg-2 (máx ~290px) + una acción clara. Contenedor `--bg-page` radio 12px, centrado.

**Notas de implementación:**
- `ErrorState.tsx` (ícono fijo `alert`, sin chip) se rediseñó para compartir el mismo contenedor `.estado-vacio` que `EstadoVacio.tsx` — mismo look, solo cambia el tono del chip de ícono (`.estado-vacio-icono-danger`, rojo) y el ícono (`cloudoff`). La ayuda "Tus datos están a salvo…" quedó fija DENTRO del componente (no repetida en cada una de las 9 pantallas que lo usan) — los mensajes específicos por pantalla ("No se pudieron cargar las citas.", etc.) ya existían de antes y no hacía falta tocarlos.
- El vacío de "sin conversación" (`Chat.tsx`) ahora sabe si hay una conversación que necesita respuesta (calculado en `Panel.tsx` con el mismo `necesitaRespuesta()` que ya usaba la Bandeja para el filtro/chip) y muestra la CTA solo si existe una; al tocarla abre esa conversación (reusa `abrir()`).
- De paso se migraron al mismo patrón `EstadoVacio` los vacíos "a mano" que ya existían sin ícono/CTA: lista de conversaciones filtrada (con CTA "Ver todos" que limpia el filtro/búsqueda), tabla de usuarios, historial de campañas, y la lista de servicios de "Mi negocio" (que **no tenía ningún mensaje** — un hueco vacío sin ningún indicio). Y se agregó el `ErrorState` que faltaba para el listado de conversaciones de la Bandeja (antes un fetch fallido se veía igual que "no tenés conversaciones", sin distinguir error de vacío real).
- El pill "Cliente frecuente" (A9d) ya había dejado precedente de que el seed de demo no alcanza para forzar todos los estados; acá pasó de nuevo con "Mi negocio sin servicios" (el seed siempre trae servicios) — no se pudo verificar por captura contra datos reales, solo por revisión de código. En cambio, el `ErrorState` de "Usuarios"/"Campañas" SÍ se verificó contra un error real (esas rutas devuelven 503 en modo memoria porque requieren Postgres), no forzado.

---

## Interactions & Behavior
- **Navegación:** tabs (desktop) / bottom nav (móvil) cambian de vista; ítem activo = fondo blanco+texto header (desktop) o color acento (móvil bottom nav).
- **Bandeja:** clic en fila abre el chat; filtros acotan la lista; "Atender yo" pasa la conversación de bot a humano y habilita el composer; "Atendido" marca la conversación.
- **Chat:** "Agendá cita" / "Cotización" abren sus flujos existentes (no cambian en este rediseño).
- **Agenda:** ‹ › cambian de día; Día/Semana cambian de vista; "Nueva cita" abre creación; "Enviar recordatorio" dispara el recordatorio al cliente en riesgo.
- **Mi negocio:** switches conmutan flags; activar "Ofrecer add-on" revela los campos de add-on; arrastrar reordena servicios.
- **Ficha:** "Guardar notas" persiste las notas privadas.
- **Transiciones:** `--ease-standard cubic-bezier(.2,0,0,1)`, duraciones 120/180/280ms; fades + translateY 4–8px. Sin bounces ni scale.
- **Focus:** ring 3px `rgba(36,141,227,.35)` accesible.
- **Estados de carga/error:** ver sección Estados; usar el patrón vacío/error para listas sin datos y fallos de red.

## State Management
Recrear con el estado/datos que ya existen en el codebase — **no** crear backend nuevo. Estado de UI necesario: vista activa (tab/nav), conversación seleccionada, filtro activo de bandeja, control bot↔humano por conversación, tema (claro/oscuro), tokens de tenant (accent, header, logo), rango del dashboard (7/30/año), vista de agenda (día/semana) y fecha, apertura del modal de ficha, y valores de formulario de servicios. Datos: conversaciones, mensajes, KPIs, citas, servicios, ficha de cliente — desde las fuentes actuales.

## Design Tokens
Ver la sección **Design Tokens** arriba (color, tipografía, espaciado, radios, sombras). Todos deben implementarse como variables/tema; `--accent` y `--header` son per-tenant. El modo oscuro reusa los mismos nombres de token con valores oscuros (pendiente de definir; que sea intencional, no un claro invertido).

## Assets
- **Fuentes:** Noto Sans + Roboto (Google Fonts en el prototipo; en producción, self-host si importa el offline).
- **Íconos:** Lucide (lista arriba). Reemplazar por el set de íconos del codebase si existe.
- **Logo del tenant:** cuadrado; si no hay, se muestran las iniciales ("LR"). No hay imágenes propietarias en el prototipo.
- **Emoji:** aparecen solo dentro de mensajes de chat de ejemplo (contenido del cliente), no en el chrome de la UI.

## Files
- `Rediseño Panel WhatsApp.dc.html` — prototipo hifi con las 7 pantallas (desktop + móvil), tema claro, y tokens en el `:root` del contenedor raíz. Es referencia visual, no código a copiar.
