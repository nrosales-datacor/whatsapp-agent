> ✅ **Archivado — plan ejecutado.** Es A8 en `ROADMAP.md` (Carril A), completo incluida la Fase 4
> de verificación. Este documento queda como bitácora histórica; el estado vigente vive en `ROADMAP.md`.

# PLAN — Rediseño visual del panel (mockup Lavacar → producción React)

> **Para quién es esto:** este documento es un **handoff ejecutable por otro modelo/dev**. Describe
> cómo aplicar el diseño del mockup (`LavacarApp.dc.html` de Claude Design) al panel React real,
> **sin romper la costura API `/api/panel/*`** ni la PWA. Trabajá fase por fase, en orden.
>
> **Fuente de verdad de arquitectura:** `ROADMAP.md`. Al terminar fases que muevan el ROADMAP,
> actualizá su casilla en el MISMO commit (ver CLAUDE.md).

## Estado de avance (2026-07-02)

| Fase / Sección | Estado |
|---|---|
| **Fase 1** — Tokens verde + dark mode + fuentes Noto Sans | ✅ Hecho |
| **Fase 2** — Backend: leadScore, deltas KPI, tieneCita/servicio | ✅ Hecho |
| **§5.1** — Rediseño Login | ✅ Hecho |
| **§5.2** — Header + tabs Inbox/Panel + dark toggle | ✅ Hecho |
| **§5.3** — Bandeja: buscador, filtros pill, score tile | ✅ Hecho |
| **§5.4** — Chat: burbujas, acciones rápidas | ✅ Hecho |
| **§5.5** — Dashboard: KPI cards con delta, horas pico verticales | ✅ Hecho |
| **§5.6** — Iconos.tsx + Toast.tsx | ✅ Hecho |
| **Fase 4** — Verificación (design-verify, PWA, regresión admin) | ✅ Hecho (2026-07-03; 3 fixes: marca header en móvil, `color-scheme` dark, toast no-optimista) |

---

## 0. Contexto en una línea

El panel **ya está 100% en React + TS** (Vite + TanStack Query, servido en `/panel`). Las 4 pantallas
(Login, Bandeja, Chat/ficha, Dashboard) funcionan contra la API real. Esto **NO es construir el panel
desde cero**: es **redecorar los componentes existentes** para que luzcan y se comporten como el mockup,
más un poco de backend para los datos nuevos que el mockup muestra.

**Regla de oro:** la API JSON `/api/panel/*` es una costura estable. Los cambios de backend de este plan
son **aditivos** (campos nuevos opcionales), nunca rompen los contratos actuales.

## 0.1 El mockup de referencia

- Archivo canónico: **`LavacarApp.dc.html`** (componente único con Inbox + Panel, prop `variant`).
- Ábranlo en un navegador: es interactivo (filtros, envío, toggle bot/humano, dark mode, toasts).
- **Antes de empezar:** copiá `LavacarApp.dc.html` a `web/design-ref/LavacarApp.dc.html` en el repo para
  tenerlo a mano como referencia visual (no se compila; es solo consulta). El `README.md` del mockup
  aclara que **NO se copia el HTML tal cual** — se recrea en nuestro stack.

## 0.2 Decisiones ya tomadas (no re-preguntar)

| Tema | Decisión |
|---|---|
| **Paleta** | Tema **verde** por defecto, pero la marca (acento + header) queda como **variables personalizables** para white-label futuro (ver §3.1). |
| **Datos nuevos** | **Sí hacer backend**: lead score por conversación, deltas en KPIs, y servicio/cita por conversación (ver §4). |
| **Fuentes** | Cambiar a **Noto Sans (display) + Roboto (body)**, self-hosted, **sin CDN** (política de deps de CLAUDE.md). |
| **Modo oscuro** | **Incluirlo** (toggle + persistencia). El mockup ya define todos los tokens dark. |

---

## 1. Archivos que vas a tocar (mapa)

Frontend (`web/`):
- `web/src/global.css` — **el grueso del trabajo**: reemplazar el sistema de tokens Swiss-minimal por el del mockup (verde light + dark), fuentes, y estilos de todos los componentes.
- `web/src/App.tsx` — hoy alterna Login/Panel por ruta. Sin cambios grandes.
- `web/src/components/Panel.tsx` — layout general; hoy Dashboard es overlay. Migrar a **tabs Inbox/Panel** en un header compartido (§5.2).
- `web/src/components/Lista.tsx` — sidebar: agregar **buscador + filtros pill + score tile + badges** (§5.3).
- `web/src/components/Chat.tsx` — burbujas con tag Bot/Agente, header con score/badge/cita, **acciones rápidas**, composer, empty state (§5.4).
- `web/src/components/Dashboard.tsx` — **KPI cards con ícono + delta**, barras, ranking de servicios, horas pico verticales (§5.5).
- `web/src/components/Login.tsx` — reestilizar con el look del mockup (§5.1).
- `web/src/components/BotonNotif.tsx` — campana; integrarla al header nuevo.
- **Nuevos:** `web/src/components/Iconos.tsx` (sprite SVG del mockup), `web/src/components/Toast.tsx` (toasts), `web/src/lib/tema.ts` (modo claro/oscuro + persistencia).

Backend (`src/`) — solo §4 (datos nuevos):
- `src/types.ts` — extender `ResumenConversacion`, `Conversacion`, `Metricas` con campos opcionales.
- La(s) función(es) del repositorio/servicio que arman esos objetos (buscar con `listarConversaciones`, `obtenerMetricas`).
- `web/src/api.ts` — reexportar los tipos extendidos (probablemente sin cambios de lógica).

Fuentes:
- **`src/panel/fonts/`** — el backend sirve `/panel/fonts/*` desde ahí (hoy tiene Inter + Space Grotesk).
  Agregá ahí los `.woff2` de Noto Sans + Roboto (y quitá los que dejen de usarse). El proxy de dev en
  `web/vite.config.ts` ya reenvía `/panel/fonts/*` al backend.

---

## 2. Inventario mockup → estado actual → acción

| Feature del mockup | ¿Existe hoy? | Dato disponible | Acción |
|---|---|---|---|
| Header con logo "LR" + nombre negocio + subtítulo | Parcial (solo nombre) | sí | Rediseñar header (§5.2) |
| Tabs segmentadas **Inbox / Panel** con badge no leídos | No (botón "Panel" abre overlay) | `sinLeer` por conv | Unificar en tabs; badge = suma de `sinLeer` |
| Campana notificaciones | Sí (`BotonNotif`) | sí | Reubicar en header nuevo |
| Toggle **modo claro/oscuro** | No | n/a (cliente) | Nuevo (§3.3) |
| Botón Salir | Sí | sí | Reestilizar |
| Buscador de conversaciones | No | client-side sobre `clienteWa` + `ultimoMensaje` | Nuevo, 100% frontend |
| Filtros pill (Todos/Bot/Humano/Sin resp.) | No | `modo`, `sinLeer` | Nuevo, 100% frontend |
| **Lead score** tile (0-100, color por rango) | No | **falta backend** | §4.1 |
| Badge BOT/HUMANO por conv | Sí (`pill`) | `modo` | Reestilizar |
| Preview truncado del último mensaje | Sí | `ultimoMensaje` | Reestilizar |
| Burbujas con tag "Bot"/"Agente" | Sí (`quien`) | `porHumano` en cada msg | Reestilizar |
| Badge "Cita agendada" + servicio en header del chat | No | **falta backend** | §4.3 |
| **Acciones rápidas** (Agendar cita / Cotización / Marcar atendido) | No | Cita/Cotización = mensaje canned vía `responder`; "atendido" = limpiar `sinLeer` | Frontend (canned) + confirmar semántica de "atendido" |
| Composer auto-resize + botón enviar | Sí | sí | Reestilizar |
| Empty state elegante | Sí (`#vacio`) | n/a | Reestilizar |
| Toast de confirmación | No | n/a (cliente) | Nuevo (§5.6) |
| Dashboard KPI cards con **ícono + delta** | Parcial (sin ícono/delta) | valores sí, **deltas faltan** | §4.2 |
| Citas por día (barras horizontales) | Sí | `citasPorDia` | Reestilizar |
| Servicios más pedidos (ranking + barras) | Sí | `serviciosTop` | Reestilizar con ranking |
| Horas pico (barras **verticales**) | Sí (horizontales) | `horasPico` | Rehacer como verticales |

---

## 3. FASE 1 — Fundaciones de diseño (frontend, sin backend) ✅

Hacé esto primero: es lo que hace que todo lo demás "se vea bien" y desbloquea las fases visuales.

### 3.1 Tokens de color (verde) + variables personalizables

En `web/src/global.css`, reemplazá el bloque `:root { ... }` actual por los tokens del mockup.
Estructurá así para el white-label futuro: un puñado de **variables de marca** (que un día vendrán de la
config del tenant) y el resto derivado de ellas.

**Tokens verde — modo claro** (copiar del mockup `[data-app][data-variant="verde"]` default):

```css
:root, [data-tema="claro"] {
  /* ── Marca (personalizable por tenant en el futuro) ── */
  --brand-accent: #0b7d72;      /* acento principal */
  --brand-accent-fg: #ffffff;
  --brand-header-bg: #0b5c56;   /* header */
  --brand-header-fg: #eafcf6;

  /* ── Derivados / superficie ── */
  --bg: #e9efec; --surface: #ffffff; --surface-2: #f4f8f6; --elevated: #ffffff;
  --text: #0f2723; --text-2: #5e716c; --text-3: #9aaaa4;
  --border: #e3ebe7; --border-2: #eef3f0;
  --accent: var(--brand-accent); --accent-fg: var(--brand-accent-fg); --accent-soft: #d6efe9;
  --bubble-in: #ffffff; --bubble-out: #d4f2e7; --bubble-out-fg: #0f2723;
  --header-bg: var(--brand-header-bg); --header-fg: var(--brand-header-fg); --header-sub: #9fd8cf;
  --bot: #0b7d72; --bot-soft: #d6efe9; --human: #b5620a; --human-soft: #fbe6cf;
  --active: #eef7f4; --chat-bg: #e5ece9;
  --danger: #C72B3F; --success: #58BE4D; --warning: #FA8500;
  --radius: 16px; --radius-sm: 10px; --av: 13px;
  --shadow: 0 1px 2px rgba(15,39,35,.05), 0 10px 30px rgba(15,39,35,.06);
}
```

**Tokens verde — modo oscuro** (copiar de `[data-variant="verde"][data-mode="dark"]`):

```css
[data-tema="oscuro"] {
  --bg:#0a1614; --surface:#0f1f1c; --surface-2:#0c1a18; --elevated:#132825;
  --text:#e7f1ee; --text-2:#9db4ae; --text-3:#5f7772;
  --border:#1c302c; --border-2:#162925;
  --brand-accent:#37b3a3; --brand-accent-fg:#04211d; --accent-soft:#12332e;
  --bubble-in:#17302b; --bubble-out:#0f463f; --bubble-out-fg:#dff5ef;
  --brand-header-bg:#0b201d; --brand-header-fg:#e7f1ee; --header-sub:#6fada4;
  --bot:#37b3a3; --bot-soft:#123330; --human:#e0902f; --human-soft:#3a2a13;
  --active:#16302b; --chat-bg:#0a1917;
  --shadow:0 1px 2px rgba(0,0,0,.4), 0 12px 34px rgba(0,0,0,.5);
}
```

> El mockup pinta los tokens sobre `[data-app]`. Nosotros los ponemos en `:root`/`[data-tema]` para que
> apliquen a toda la app. **Mantené los nombres de alias legacy** que usan los componentes aún sin migrar
> (`--verde`, `--panel`, `--texto`, `--gris`, `--linea`, `--rojo`) apuntando a los tokens nuevos, para no
> romper nada a medio camino. Andá quitándolos a medida que refinás cada componente.

### 3.2 Fuentes Noto Sans + Roboto (self-hosted, sin CDN)

1. Conseguí los `.woff2` (Google Webfonts Helper o descarga oficial). Pesos necesarios:
   - **Noto Sans**: 400, 500, 600, 700, 800, 900 (el mockup usa 700–900 para display).
   - **Roboto**: 300, 400, 500, 700.
2. Colocalos en la carpeta que sirve `/panel/fonts/*` (verificá el handler del backend).
3. En `global.css`, reemplazá los `@font-face` de Inter/Space Grotesk por los de Noto Sans/Roboto, y
   actualizá `--font-display: 'Noto Sans', system-ui, sans-serif;` y `--font-body: 'Roboto', 'Noto Sans', sans-serif;`.
4. **Política de dependencias:** las fuentes no son un `npm install`, pero igual: nada de `<link>` a
   Google Fonts (rompe offline/PWA y la política no-CDN). Todo self-hosted.

### 3.3 Modo claro/oscuro

- Nuevo `web/src/lib/tema.ts`: leer/escribir `localStorage["panel-tema"]` (`"claro"|"oscuro"`), setear
  `document.documentElement.dataset.tema`, y exponer un hook `useTema()` con `{tema, alternar}`.
- Inicializar el tema **antes del primer render** (en `main.tsx` o un script inline) para evitar flash.
- El toggle vive en el header nuevo (§5.2), con ícono luna/sol (§5.6).

**Done de la Fase 1:** `npm run web:build` OK; el panel carga con los colores/fuentes del mockup; el toggle
alterna claro/oscuro y persiste al recargar. Todavía con el layout viejo — está bien.

---

## 4. FASE 2 — Backend: datos nuevos (aditivo, no rompe contratos) ✅

Todos los campos nuevos son **opcionales** en los tipos → el front viejo y el nuevo conviven.

### 4.1 Lead score por conversación

- Extender `ResumenConversacion` y `Conversacion` en `src/types.ts`:
  ```ts
  /** 0–100. Heurística de prioridad del lead (ver plan §4.1). Opcional: si falta, la UI no muestra tile. */
  leadScore?: number;
  ```
- **No hay ML.** Definí una **heurística determinística** y documentala. Propuesta inicial (ajustar con el
  negocio): base 40, +25 si tiene intención de compra/cita detectada, +15 si el último mensaje es del
  cliente (pendiente de respuesta), +10 por recencia (<24h), +10 si ya tiene cita agendada, clamp 0–100.
  Implementala donde se arma el `ResumenConversacion` (buscá la función que hoy llena `ultimoMensaje`/`sinLeer`).
- **Marcá esto como "fórmula tentativa"** en un comentario; el valor exacto se calibra después.

### 4.2 Deltas en los KPIs

- Extender `Metricas` en `src/types.ts`:
  ```ts
  deltas?: {
    conversaciones?: string; citas?: string; conversion?: string; ingresos?: string;
  };
  ```
- El cálculo de KPIs vive en **`src/panel/metricas.ts`** — agregá ahí la variación vs. el período anterior
  (7 días previos). Si no hay período comparable, omitir (la UI oculta el delta).

### 4.3 Servicio y cita por conversación

- Extender `ResumenConversacion`/`Conversacion`:
  ```ts
  servicio?: string | null;   // nombre del servicio de interés/última cita
  tieneCita?: boolean;        // hay una cita agendada activa
  ```
- Derivar de las citas del cliente (ya existen `crearCita`/`citasPorFecha` y `FichaCliente.totalCitas`).
- La UI: `servicio` va en el subtítulo del header del chat; `tieneCita` pinta el badge "Cita agendada".

### 4.4 "Marcar atendido" (acción rápida)

- Semántica mínima: limpiar `sinLeer` de la conversación. Verificá si abrir el chat ya lo hace (endpoint de
  lectura). Si sí, "Marcar atendido" puede ser un atajo al mismo efecto + toast. Si se quiere un estado
  explícito "atendido/cerrado", eso es **fuera de alcance** de este plan (proponer al ROADMAP aparte).

**Done de la Fase 2:** `npm run typecheck` OK (front + back comparten tipos); los endpoints devuelven los
campos nuevos; el panel viejo sigue funcionando (campos opcionales).

---

## 5. FASE 3 — Rediseño de componentes

Recreá cada pantalla contra el mockup (`LavacarApp.dc.html`). Recomendación: **CSS por clases en
`global.css`** (como hoy), no inline styles — el mockup usa inline por ser prototipo; nosotros mantenemos
el patrón del repo. Mapear 1:1 los estilos del mockup a clases.

### 5.1 Login (`Login.tsx` + CSS `#login`) ✅
- Logo chip "LR", título grande (Noto Sans 900), inputs con focus de acento, botón lleno.
- Es el cambio más chico; buen primer PR para validar tokens/fuentes.

### 5.2 Header + tabs Inbox/Panel (`Panel.tsx`)
- Header 60px, `--header-bg`: logo "LR" + nombre + subtítulo ("WhatsApp Business · <ubicación>").
- **Tabs segmentadas** Inbox/Panel en contenedor `rgba(255,255,255,.10)`; activa = fondo `--header-fg`.
  Badge naranja de no leídos en Inbox = suma de `sinLeer`.
- Derecha: campana (`BotonNotif`), toggle modo (luna/sol), botón Salir.
- **Cambio estructural:** hoy el Dashboard es un overlay (`dashAbierto`). Migralo a **vista por tab**
  (`view: 'inbox' | 'panel'` en estado, como el mockup) manteniendo el mismo componente `Dashboard`.
  El layout móvil (una columna) y las safe areas del CSS actual **deben preservarse**.

### 5.3 Lista / sidebar (`Lista.tsx`)
- Buscador (input con ícono lupa) — filtra en cliente por teléfono/último mensaje.
- Fila de 4 **filtros pill** (Todos/Bot/Humano/Sin resp.) con contador en vivo; activo = fondo acento.
- Cada fila: **score tile 44px** (color por rango: ≥80 acento sólido, 55–79 acento suave, <55 neutro —
  ver `scoreColors` del mockup), teléfono (700 si no leído), hora (acento si no leído), preview truncado
  (~34 chars), badge BOT/HUMANO, badge de no leídos. Fila activa: borde izq 3px acento + `--active`.
- Si `leadScore` viene `undefined`, no pintar el tile (o usar avatar de iniciales como fallback actual).

### 5.4 Chat (`Chat.tsx`)
- Header del chat: score tile 42px, teléfono, badge bot/humano, **badge "Cita agendada"** si `tieneCita`,
  subtítulo (`servicio · Lead score N/100`), botón toggle canal (bot↔humano) a la derecha.
- Mensajes: burbujas máx 74%. Cliente izq (`--bubble-in`), negocio der (`--bubble-out`) con tag
  "Bot"/"Agente" arriba (color según `porHumano`). Timestamp 10px. Separador "Hoy".
- **Acciones rápidas** (barra sobre el composer): **Agendar cita** (lleno), **Enviar cotización** (outline),
  **Marcar atendido** (outline, check verde). Cita/Cotización → mensaje canned vía `responder(id, texto)`
  + toast. Atendido → §4.4 + toast.
- Composer: textarea auto-resize (44–96px) + botón enviar circular. Ya existe la lógica; solo reestilizar.
- Empty state: card 96px con ícono chat + copy invitando a elegir conversación.

### 5.5 Dashboard (`Dashboard.tsx`)
- **4 KPI cards** grid `repeat(4,1fr)`: label + ícono en badge cuadrado (fondo acento suave), valor grande
  (Noto Sans 900, 34px), **delta** con ícono tendencia (verde) si viene de `metricas.deltas`.
  KPIs: Conversaciones, Citas agendadas, Conversión %, Ingresos estimados (`colones()`).
- **Citas por día**: barras horizontales (label 84px + track + número).
- **Grid 2 col**: Servicios más pedidos (ranking numerado + barra, intensidad decreciente por rank) /
  Horas pico (**barras verticales**, altura proporcional, etiqueta rotada -32°, número arriba).
- Responsive: en móvil el grid de KPIs cae a 2 o 1 columna; el grid 2-col a 1 columna.

### 5.6 Íconos + Toasts (nuevos)
- `Iconos.tsx`: portá el sprite SVG del mockup (símbolos `i-search, i-send, i-cal, i-quote, i-check2,
  i-bell, i-moon, i-sun, i-chat, i-dash, i-out, i-bot, i-user, i-x, i-trend, i-money, i-clock`). Exponé un
  `<Icono id="..." size sw />` o un `<defs>` global + `<use>`. Trazo 1.6–2.2px, redondeado.
- `Toast.tsx`: toast abajo-centro, auto-descarte ~3.2s + botón X. **No** uses animaciones de entrada que
  dependan de opacity-0 inicial (el README del mockup advierte que dejaban contenido invisible tras
  re-render). Un contexto/estado simple `{toast, flash(text, icon)}` a nivel `Panel`.

---

## 6. FASE 4 — Verificación (obligatoria antes de dar por hecho)

1. `npm run typecheck` (front + SW) y `npm run web:build` — ambos verdes.
2. Levantar el panel servido por el backend (no solo `web:dev`) y probar el **flujo real**: login →
   bandeja → abrir chat → responder → toggle bot/humano → acciones rápidas → dashboard → toggle claro/oscuro.
3. Usá el skill **`design-verify`** para screenshot + crítica en **móvil y desktop**, en **claro y oscuro**.
   Revisar: overflow horizontal, contraste (dark), áreas táctiles ≥44px, que el layout móvil de una columna
   siga funcionando.
4. PWA: confirmar que el SW sigue registrando y la campana/push no se rompió (fuentes self-hosted, sin CDN).
5. Regresión: el área **admin/onboarding** (`/panel/admin`) usa los mismos tokens — verificá que no quedó
   fea con la paleta nueva (reestilizar si hace falta, es aditivo).

---

## 7. Qué respetar / NO romper

- **No cambiar los contratos de `/api/panel/*`.** Solo agregar campos opcionales (§4).
- **No introducir CDNs** (fuentes, íconos, CSS). Todo self-hosted (política de deps + offline/PWA).
- **No `npm install`** sin cumplir las 3 reglas de CLAUDE.md (ampliamente usado, publisher conocido,
  versión con +1 mes, versión fijada exacta). Este plan **no requiere paquetes nuevos**: React + CSS bastan.
  Si aparece la tentación de una librería de íconos/charts, primero evaluá hacerlo a mano (el mockup ya es
  SVG/CSS puro).
- **Preservar** el layout móvil de una columna, las safe areas (`env(safe-area-inset-*)`) y el auto-scroll
  del chat que ya existen en `global.css`/`Chat.tsx`.
- **Preservar** la compuerta de sesión (401 → login) de `main.tsx`/`App.tsx`.

## 8. Orden de commits sugerido (PRs chicos)

1. `feat(panel): tokens verde + dark mode + fuentes Noto/Roboto` (Fase 1) — se puede mergear solo.
2. `feat(api): leadScore + deltas + servicio/cita en panel` (Fase 2) — backend aditivo.
3. `feat(panel): rediseño Login` (5.1)
4. `feat(panel): header + tabs Inbox/Panel + dark toggle` (5.2)
5. `feat(panel): rediseño bandeja (buscador, filtros, score)` (5.3)
6. `feat(panel): rediseño chat + acciones rápidas + toasts` (5.4, 5.6)
7. `feat(panel): rediseño dashboard (KPI cards, horas pico)` (5.5)

Cada PR: typecheck + build verdes y, para los visuales, una pasada de `design-verify`.

## 9. Actualizar el ROADMAP

Este rediseño no está como ítem en `ROADMAP.md`. **Agregalo** al Carril A (p. ej. "A8 — Rediseño visual
del panel según mockup Lavacar (dark mode, lead score, dashboard rico)") y andá marcando el avance en el
mismo commit que hace el trabajo. Actualizá la fecha de "Última actualización".

---

### Anexo: dónde está cada cosa (rutas verificadas)

- Componentes React: `web/src/components/*.tsx` · estado/orquestación: `web/src/components/Panel.tsx`
- Estilos: `web/src/global.css` (233 líneas hoy)
- API tipada del front: `web/src/api.ts` · tipos compartidos: `src/types.ts` (líneas 126–178)
- Formato (colones, hora, número): `web/src/lib/formato.ts`
- Mockup de referencia: `LavacarApp.dc.html` (copiar a `web/design-ref/`)
