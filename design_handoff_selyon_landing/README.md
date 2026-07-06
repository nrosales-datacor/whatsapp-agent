# Handoff: Selyon marketing landing (brand home + WhatsApp agent product)

## Overview
This is a redesign of the existing public landing page (currently a single-product page for
"Recepcionista IA" — a WhatsApp AI agent). The redesign repositions it as **Selyon**, an
umbrella brand that will sell multiple AI products. This page is the **Selyon home that leads
into the WhatsApp agent product**, and previews the second product (Menú Digital IA) as a
card that links to a page you will build later.

Goal: a premium, motion-rich, "agency-grade" marketing page that builds confidence in the
company. Copy is in **neutral LatAm Spanish**.

## About the Design Files
The file in this bundle — `Selyon.dc.html` — is a **design reference created in HTML**. It is a
prototype showing the intended look, layout, copy, and behavior. It is **not production code to
paste in directly**: it was authored in a sandboxed environment that requires all styles to be
**inline** and wraps the markup in a custom `<x-dc>` component with a small logic class. When
recreating it in the real codebase you should:

- Move the inline styles into `landing/assets/estilos.css` as classes (the existing site already
  uses BEM-ish Spanish class names like `.hero`, `.feature`, `.plan` — extend that convention).
- Drop the `<x-dc>`/`support.js`/`renderVals()` scaffolding entirely — none of it is needed.
- Reimplement the two pieces of JS behavior (scroll-reveal + chat replay) as a small vanilla
  `<script>` using `IntersectionObserver` (details below).

The **current site is a single static HTML file** (`landing/index.html` + `landing/assets/estilos.css`),
so the target environment is **plain HTML/CSS/vanilla JS — no framework, no build step**. Keep it
that way unless told otherwise.

## Fidelity
**High-fidelity (hifi).** Final colors, typography, spacing, copy, and interactions are all
specified below and in the reference file. Recreate the UI faithfully. Exact hex values, font
sizes, and spacing are given in the Design Tokens section — use them verbatim.

---

## Brand identity (new — did not exist before)
Selyon is a **new brand** proposed in this design. There is no official logo yet, so the design
ships a **placeholder wordmark + mark** that the developer should keep until a real logo exists.

- **Wordmark:** the text `selyon`, all-lowercase, Noto Sans weight 800, letter-spacing `-0.02em`,
  white on dark / navy on light. Font-size 22px in nav and footer.
- **Mark (SVG, 36×36):** a rounded square (`rx=10`) filled with a diagonal gradient from
  `#248DE3` (top-left) to `#103050` (bottom-right); on top, a "rising path" polyline
  `M10 24.5 L18 8 L26 24.5` stroked `#7AFAFC` at 2.4px (round caps/joins); a `#FFC517` filled
  circle (r=3) at the apex `(18,8)`, and two `#7AFAFC` circles (r=2.4) at the base points
  `(10,24.5)` and `(26,24.5)`. It reads as a network of connected AI agents.

Full SVG source is in the reference file (search for `logoMark`). Reproduce it as a static
inline `<svg>` in the nav and footer.

**Note:** The visual style is grounded in the attached design system (Datacor tokens). Selyon is
NOT Datacor — do not use any Datacor logo. Only the color palette, type pairing, spacing, radii,
and motion values are borrowed.

---

## Screens / Views
Single long scrolling page. Sections top-to-bottom:

### 1. Sticky nav
- **Layout:** full-width sticky header, `z-index:60`. Inner row `max-width:1240px`, centered,
  `padding:15px 24px`, `display:flex; align-items:center; justify-content:space-between`.
- **Background:** `rgba(7,26,48,.72)` with `backdrop-filter: blur(14px)`; bottom border
  `1px solid rgba(122,250,252,.12)`.
- **Left:** logo mark + `selyon` wordmark (white), links to `#top`.
- **Right:** nav links — `Productos` (#productos), `Agente WhatsApp` (#agente),
  `Cómo funciona` (#como), `Precios` (#precios) — Noto Sans 600, 14.5px, color `#c3d6ee`.
  Each link has an animated yellow underline that wipes in left→right on hover
  (`#FFC517`, 2px, transition `right .25s`). **Then** a yellow pill CTA "Ver demo".
  - NOTE: in the reference the text links have `display:none` inline (they were hidden for a
    narrow preview). In the real site **show them** on desktop (`display:inline-flex` / `flex`)
    and collapse to a hamburger or hide below ~720px.
- **CTA button:** text `Ver demo`, Noto Sans 700 14px, color `#0a2038`, background `#FFC517`,
  padding `11px 20px`, radius `999px`, shadow `0 6px 20px -6px rgba(255,197,23,.6)`.
  Hover: `translateY(-2px)` + stronger shadow.

### 2. Hero (dark)
- **Background:** `radial-gradient(120% 90% at 78% 8%, #124a86 0%, #0c2c50 42%, #071a30 78%)`.
- **Ambient layers (decorative, pointer-events:none):**
  - Animated grid overlay: two 1px `rgba(122,250,252,.05)` line gradients at `56px` cell size,
    keyframe `syGridPan` translating background-position `0 0` → `0 -560px` over 22s linear
    infinite, masked with a radial `mask-image` so it fades at edges.
  - Two blurred glow blobs (cyan `rgba(122,250,252,.28)` top-right; blue `rgba(36,141,227,.3)`
    bottom-left), `filter:blur(20–24px)`, keyframe `syGlow` (opacity .55↔.9, scale 1↔1.08) 8–10s.
- **Layout:** `max-width:1240px`, `padding:76px 24px 96px`, CSS grid `1.05fr .95fr`, gap `56px`,
  `align-items:center`. Collapses to 1 column below 900px.
- **Left column:**
  - Eyebrow pill: `● Plataforma de agentes de IA` — bordered pill `1px rgba(122,250,252,.3)`,
    bg `rgba(122,250,252,.08)`, Noto Sans 600 12.5px uppercase +.04em, text `#7AFAFC`; the dot is
    a 7px `#58BE4D` circle with a glow.
  - H1: Noto Sans **900**, `clamp(38px,5.2vw,68px)`, line-height 1.03, letter-spacing -.025em,
    white. Text: **"El equipo de IA que atiende tu negocio, día y noche."** — the phrase
    **"día y noche."** uses a gradient text fill
    `linear-gradient(100deg,#7AFAFC,#58CDF7 45%,#FFC517)` (background-clip:text).
  - Sub-paragraph: Roboto `clamp(16px,1.5vw,19px)`, line-height 1.6, color `#a9c2e0`, max 46ch:
    "Selyon crea agentes de inteligencia artificial que responden, cotizan, agendan y venden por
    vos. Empezá con el agente de WhatsApp que ya atiende a clientes reales."
  - CTAs: primary yellow pill "Probá la demo en vivo →" (same style as nav CTA but 16px /
    `padding:16px 30px`); secondary ghost pill "Ver productos" (bg `rgba(255,255,255,.06)`,
    border `1px rgba(122,250,252,.28)`, text `#eaf4ff`, hover raises bg + border alpha).
  - Avatar cluster: three 34px overlapping circles (`#5BB0A2` "LR", `#58CDF7` "MC",
    `#FFC517` "+"), each `border:2px solid #0c2c50`, `margin-left:-11px` overlap; caption
    "Negocios que ya atienden con Selyon" (Roboto 13.5px `#9fb8d6`).
- **Right column — floating phone:**
  - Behind it, a blurred cyan radial glow (`syGlow` animation).
  - Phone body: `width:300px`, `background:linear-gradient(160deg,#16324f,#0a1f38)`, radius 44px,
    padding 12px, big shadow + `0 0 0 1px rgba(122,250,252,.15)` ring, `animation:syFloat 7s`
    (translateY 0↔-14px).
  - Screen: `#dfeae4`, radius 33px, height 600px, column flex.
  - Chat header: bg `#0b5c56`, text `#eafcf6`; 34px round avatar "LR" (`#d4f2e7` bg,
    `#0b5c56` text); title "Lavacar Rosales" (Noto Sans 700 14.5px) + subtitle "en línea ·
    agente IA" (11px `#a7e6d8`).
  - Chat body (`.sy-chat-live`): 6 message bubbles, incoming left / outgoing right. Incoming =
    white, `border-bottom-left-radius:4px`; outgoing = `#d4f2e7`, text `#0f2723`,
    `border-bottom-right-radius:4px`. 13px text. Bubble 4 contains three tappable-looking time
    "buttons" (white, `1px #cfe4dc` border, radius 9px, `#0b5c56` 12.5px 600): 9:00 a.m. /
    11:30 a.m. / 2:00 p.m.
  - Conversation (exact copy): (1) "🎤 Nota de voz · 0:08" (2) "¡Hola! Por lo que me cuentas es
    lavado completo + encerado para un sedán: ₡18.000, dura ~1h. ¿Te reservo un espacio?"
    (3) "Sí, ¿qué horarios hay mañana?" (4) "Mañana miércoles tengo:" + the 3 time chips
    (5) "11:30 a.m." (6) "Listo ✅ Cita confirmada mañana 11:30 a.m. — lavado + encerado, sedán.
    Te recuerdo un día antes."
  - Two floating white chip cards over the phone edges (each `syFloat`/`syFloat2` animated):
    top-left "✓ Cita agendada / sin intervención humana"; bottom-right "**69%** conversión /
    chat → cita".
- **Client marquee strip** at the bottom of the hero: horizontally scrolling business names
  (Roboto 700 15px `#5f7ba0`), keyframe `syMarquee` translateX 0→-50% over 30s linear infinite,
  edge-faded with a horizontal `mask-image`. Names (duplicated once for seamless loop):
  Lavacar Rosales · Clínica Dental Vega · Estética Mare · Barbería Nómada · Taller Motorsport CR
  · Spa Aurora. **These are placeholder names — swap for real clients or remove.**

### 3. Metrics band
- **Background:** `#0a2038`, bottom border `1px rgba(122,250,252,.08)`.
- **Layout:** `max-width:1160px`, `padding:52px 24px`, grid `repeat(4,1fr)` gap 22px
  (→ 2 columns below 900px). Each cell centered.
- **4 metrics:** value in Noto Sans 900 `clamp(30px,3.4vw,44px)`, label Roboto 14px `#8ba6c6`:
  - `24/7` (white) — "Atención sin pausas"
  - `<10s` (`#7AFAFC`) — "Tiempo de respuesta"
  - `69%` (`#FFC517`) — "Chats que terminan en cita"
  - `0` (`#58CDF7`) — "Clientes sin responder"
- **Honesty note:** 69% comes from one client's dashboard (Lavacar Rosales). Keep or reframe as
  aggregate only if it's true; `<10s`, `24/7`, `0` are product claims — verify before shipping.

### 4. Productos (the suite)
- **Background:** `#f4f7fb`, `padding:100px 0`.
- **Header (centered, max 660px):** eyebrow "LA SUITE SELYON" (Noto Sans 700 13px +.08em uppercase
  `#248DE3`); H2 Noto Sans 800 `clamp(28px,3.4vw,44px)` `#103050` "Un producto para cada punto de
  contacto con tu cliente."; sub Roboto 17px `#5a728d`.
- **Layout:** grid `1fr 1fr` gap 26px (→ 1 col below 900px).
- **Card shell:** white, `1px #e2e9f1` border, radius 22px, subtle shadow, hover
  `translateY(-6px)` + `0 30px 60px -24px rgba(16,48,80,.3)` (transition 250ms `cubic-bezier(.2,0,0,1)`).
- **Card A — Recepcionista IA (available):**
  - Header block height 210px, bg `linear-gradient(135deg,#0b7d72,#0b5c56)`, decorative circle
    top-right. Icon tile (WhatsApp-ish chat glyph, stroke, in a translucent white tile) + a
    "Disponible" pill (uppercase, `#bff0e2` text on `rgba(255,255,255,.12)`).
  - A mini chat preview docked bottom-right (two small bubbles).
  - Body: H3 Noto Sans 800 23px `#103050` "Recepcionista IA"; description Roboto 15px `#5a728d`;
    three teal chips (`#e7f6f1` bg / `#0b5c56` text): "Agenda automática", "Notas de voz",
    "Recordatorios"; CTA pill "Ver producto →" (bg `#0b7d72`, white, hover `#0b5c56`),
    links to `#agente`.
- **Card B — Menú Digital IA (available):**
  - Header block bg `linear-gradient(135deg,#248DE3,#103050)`. Icon tile (menu/list glyph) +
    status pill whose text and background come from config (see Interactions). Default:
    "Disponible" on `#7AFAFC`.
  - Mini phone preview docked bottom-right showing a dish "video" card: orange gradient tile with
    a ▶ play circle, a `720 kcal` chip top-left, then "Burger Selyon" / "Res 200g · queso · papas".
  - Body: H3 "Menú Digital IA"; description "Menú con video de cada plato, calorías y detalles
    sobre la imagen, y un mesero de IA que recomienda, resuelve dudas y toma el pedido."; three
    blue chips (`#e8f2fc` / `#1b5a94`): "Videos de platos", "Mesero IA", "Calorías"; CTA pill
    "Ver menú →" (bg `#248DE3`, white, hover `#1b6fc0`) linking to the **menu page URL**
    (configurable; default `menu.html`). This is the page you'll build later.

### 5. Agente deep-dive (WhatsApp agent features)
- **Background:** white, `padding:100px 0`, `max-width:1160px`.
- **Header (left-aligned, max 680px):** eyebrow "PRODUCTO DESTACADO · RECEPCIONISTA IA" (`#0b7d72`);
  H2 "Todo lo que hoy hacés a mano por WhatsApp, ahora lo hace el agente."; sub "Nada de esto es
  promesa a futuro: son funciones corriendo hoy con clientes reales."
- **Feature grid:** `repeat(3,1fr)` gap 20px (→ 1 col below 900px). 6 cards, white, `1px #e2e9f1`,
  radius 18px, `padding:28px 26px`. Each: a 48px rounded icon tile (alternating teal `#e7f6f1`/`#0b7d72`
  and blue `#e8f2fc`/`#248DE3`), H3 Noto Sans 800 18px `#103050`, description Roboto 14.5px `#5a728d`.
  Add the same hover-lift as the product cards.
- **The 6 features (title — icon — copy):**
  1. "Responde al instante, 24/7" (chat bubble) — "Dudas, precios y horarios contestados con IA —
     entendiendo la pregunta, no un menú de opciones."
  2. "Agenda, reprograma y cancela sola" (calendar-check) — "Sincronizada con Google Calendar: el
     agente maneja los cambios de cita sin que intervengas."
  3. "Botones y listas nativas" (list) — "El cliente elige tocando, como en cualquier chat de
     WhatsApp — nada de escribir horarios a mano."
  4. "Recordatorios con confirmación" (bell) — "Un día antes y el mismo día, pidiendo confirmar —
     así los no-shows dejan de comerte la agenda."
  5. "Entiende notas de voz" (microphone) — "El cliente manda un audio explicando lo que necesita y
     el agente lo transcribe y lo entiende igual."
  6. "Panel para tu equipo" (dashboard/monitor) — "Bandeja con takeover humano, CRM y métricas —
     instalable en el celular, con notificaciones."
  - Exact icon SVG paths are in the reference file's feature markup (`#agente article`). Or swap for
    Lucide equivalents (message-circle, calendar-check, list, bell, mic, layout-dashboard) at 22px,
    1.8px stroke, `currentColor`.

### 6. Panel showcase (dark)
- **Background:** `radial-gradient(120% 80% at 50% 0%, #0f3560 0%, #0a2038 55%, #071a30 100%)`,
  `padding:100px 0`, with a large blurred blue glow behind the header.
- **Header (centered, max 640px):** eyebrow "EL PANEL DE CONTROL" (`#7AFAFC`); H2 white "Tu equipo
  ve todo y toma el control cuando quiera."; sub `#a9c2e0`.
- **Dashboard in a browser frame:** rounded 16px container, big drop shadow + cyan ring. Fake browser
  chrome bar (`#0c2c50`): red/amber/green 11px dots + a URL pill "panel.selyon.app/lavacar-rosales".
  Then the screenshot `panel-dashboard-oscuro.webp` full width.
- **Mobile pair:** grid `1fr 1fr` gap 24px (max 760px, centered). Two framed screenshots
  `panel-bandeja-claro.webp` and `panel-bandeja-oscuro.webp`, each with caption
  ("Bandeja + chat · claro" / "· oscuro", Roboto 13.5px `#8ba6c6`).

### 7. Cómo funciona
- **Background:** `#f4f7fb`, `padding:100px 0`. Centered header, eyebrow "CÓMO FUNCIONA" (`#248DE3`),
  H2 "En marcha en días, no en meses."
- **3 step cards:** grid `repeat(3,1fr)` gap 22px (→ 1 col below 900px). White, `1px #e2e9f1`,
  radius 18px, `padding:32px 28px`. Each has a 46px rounded-square number badge
  (`#103050` bg, `#FFC517` number, Noto Sans 900 20px), H3 Noto Sans 800 19px, body Roboto 15px.
  1. "Configuramos tu negocio" — "Servicios, precios y horarios. Lo que hoy tenés en la cabeza,
     ahora lo sabe el agente."
  2. "Conectamos tu WhatsApp" — "Tu mismo número, sin cambios para tus clientes."
  3. "El agente atiende, vos supervisás" — "Cada conversación y cada cita queda en el panel, en
     tiempo real."

### 8. Testimonial
- **Background:** white, `padding:90px 0`, inner `max-width:900px`.
- **Card:** `linear-gradient(135deg,#103050,#0b2947)`, radius 26px, `padding:52px 48px`, a giant
  decorative `"` quotation mark in `rgba(122,250,252,.09)` top-right. Five `#FFC517` stars.
- **Quote (Noto Sans 600 `clamp(20px,2.4vw,28px)` `#eaf4ff`):** "Antes perdíamos clientes por no
  contestar a tiempo. Ahora el agente responde al instante y llena la agenda solo. Dejé de vivir
  pegado al teléfono."
- **Attribution:** 48px `#5BB0A2` "LR" avatar + "Lavacar Rosales" (white 16px) / "San José, Costa
  Rica · en producción con Selyon" (`#8ba6c6` 14px).
- **Note:** the quote is a plausible placeholder — replace with a real client statement before
  shipping.

### 9. Precios
- **Background:** `#f4f7fb`, `padding:100px 0`, inner `max-width:900px`. Centered header, eyebrow
  "PLANES", H2 "Precios de lanzamiento.", sub "Escribinos y los vemos juntos según tu negocio."
- **Two plan cards:** grid `1fr 1fr` gap 24px, `align-items:start`.
  - **Básico** (white, `1px #e2e9f1`, radius 20px, `padding:34px 32px`): title Noto Sans 800 26px
    `#103050`, tagline "Para empezar a atender solo.", 4 checklist rows (teal `#0b7d72` ✓,
    Roboto 15px `#41566e`): "Agente de WhatsApp con IA", "Agenda con Google Calendar",
    "Recordatorios con confirmación", "Panel de bandeja y CRM". Ghost CTA "Consultar precio"
    (white, `1.5px #cdd9e6` border, hover border+text `#248DE3`).
  - **Pro** (highlighted: `linear-gradient(160deg,#0f3560,#0a2038)`, `1px rgba(122,250,252,.2)`
    border, radius 20px, big shadow): a "RECOMENDADO" yellow pill top-right; title white; tagline
    `#8ba6c6` "Para equipos y marca propia."; 4 rows (cyan `#7AFAFC` ✓, text `#d5e3f3`): "Todo lo
    del plan Básico", "Campañas por WhatsApp", "Multi-usuario para tu equipo", "Marca propia en
    panel y agente". Yellow CTA "Consultar precio" (`#FFC517`, `#0a2038` text, hover lift+shadow).
  - Footnote (centered, `#8296ac` 13px): "Precios de lanzamiento — escribinos y armamos el plan a
    tu medida."
- No prices shown by design (launch pricing handled via WhatsApp) — matches the current site.

### 10. FAQ
- **Background:** white, `padding:100px 0`, inner `max-width:800px`. Centered H2 "Preguntas
  frecuentes".
- **6 `<details>` accordions** (`#f4f7fb` bg, `1px #e2e9f1`, radius 12px). Summary: Noto Sans 700
  16.5px `#103050`, `list-style:none`, flex space-between with a `+` marker (`#248DE3` 22px) that
  rotates 45° when open (CSS `details[open] summary span:last-child{transform:rotate(45deg)}`).
  Body: Roboto 15px `#5a728d`.
  1. "¿Necesito cambiar mi número de WhatsApp?" — "No. Conectamos el agente a tu número actual; tus
     clientes siguen escribiendo al mismo lugar de siempre."
  2. "¿Y si el agente no sabe algo?" — "Te avisa y pasa la conversación a un humano — nunca inventa
     una respuesta."
  3. "¿Puedo responder yo directamente?" — "Sí. Desde el panel podés tomar cualquier conversación y
     contestar vos mismo cuando quieras."
  4. "¿Qué pasa con los datos de mis clientes?" — "Se usan solo para atender su consulta y su cita.
     Los detalles están en la política de privacidad." (link the phrase to `/privacidad`.)
  5. "¿Cuánto tarda en estar funcionando?" — "Días, no meses — la configuración inicial es cargar
     tus servicios, precios y horarios."
  6. "¿Sirve para mi tipo de negocio?" — "Sirve para cualquier negocio que agenda citas o atiende
     pedidos: lavacares, talleres, clínicas, salones, restaurantes y similares."

### 11. Final CTA
- **Background:** page `#071a30`; inner rounded (30px) panel `max-width:1080px`,
  `background:radial-gradient(120% 130% at 80% 0%, #1a5aa0, #0f3560 45%, #0a2038 100%)`,
  `padding:72px 48px`, with a masked grid overlay (48px cells, `rgba(122,250,252,.06)`).
- **Content (centered, max 640px):** H2 Noto Sans 900 `clamp(30px,4vw,50px)` white "Dejá que Selyon
  atienda por vos."; sub Roboto 18px `#a9c2e0` "Probá la demo en vivo ahora mismo, sin compromiso ni
  instalar nada."; two CTAs — yellow "Probá la demo en vivo →" and ghost "Hablar con ventas".

### 12. Footer
- **Background:** `#071a30`, top border `1px rgba(122,250,252,.1)`, `padding:56px 24px 44px`.
- **Layout:** `max-width:1160px`, grid `1.4fr 1fr 1fr` gap 40px.
  - Col 1: logo + wordmark, then Roboto 14px `#7f9bbd` "Agentes de IA que atienden, agendan y venden
    por tu negocio. Hecho en Costa Rica."
  - Col 2 "PRODUCTOS": links "Recepcionista IA" (#agente), "Menú Digital IA" (menu URL), "Precios"
    (#precios). Roboto 14.5px `#a9c2e0`, hover `#7AFAFC`.
  - Col 3 "SELYON": "Política de privacidad" (/privacidad), "Términos del servicio" (/terminos),
    "Contacto" (WhatsApp ventas link).
- **Bottom bar:** top border, "© 2026 Selyon. Todos los derechos reservados." (`#5f7ba0` 13px).

---

## Interactions & Behavior

### Scroll reveal
Every element marked `data-reveal` starts at `opacity:0; translateY(30px)` and transitions to
`opacity:1; translateY(0)` over `.7s cubic-bezier(.2,0,0,1)` when it enters the viewport. Implement
with a single `IntersectionObserver` (threshold ~0.12, `rootMargin:"0px 0px -8% 0px"`), adding an
`is-visible` class and unobserving once shown. **Respect `prefers-reduced-motion: reduce`** — when
set, reveal everything immediately and skip the ambient animations.

### Chat replay
The hero chat bubbles animate in as a staggered sequence (each bubble fades/rises via `syChatIn`,
delays roughly: .15s, .9s, 1.7s, 2.4s, 3.4s, 4.1s). Use an `IntersectionObserver` on the chat
container: when it scrolls into view, **restart** the sequence (remove the play class, force reflow,
re-add) so it replays each time; when it scrolls out, reset. Under reduced-motion, just show all
bubbles.

### Hover states
- Buttons: yellow/primary buttons raise `translateY(-2px)` + deepen shadow; ghost buttons raise
  bg/border alpha; secondary buttons shift border+text to blue. Transitions 150–180ms `cubic-bezier(.2,0,0,1)`.
- Cards (product + feature): `translateY(-5/-6px)` + elevation shadow, 250ms.
- Nav links: underline wipe-in.
- FAQ: `+` marker rotates to `×`.

### Config / variants (were "tweaks" in the prototype)
Two values should be easy to change (expose as simple constants/attributes, not a UI):
- **Menú status** — `"Disponible"` (badge bg `#7AFAFC`) or `"Próximamente"` (badge bg `#FFC517`).
- **Menú link** — the URL the "Ver menú" CTA and footer link point to (default `menu.html`).

### Links / CTAs
All conversion CTAs are WhatsApp deep links to **`https://wa.me/50683658231`** with a prefilled
`?text=` (URL-encoded). Keep this number. The messages used:
- Ver demo / Probá la demo → "Hola, quiero ver la demo de Selyon"
- Hablar con ventas / Contacto → "Hola, quiero hablar de Selyon para mi negocio"
- Plan Básico → "Hola, quiero consultar el precio del plan Básico"
- Plan Pro → "Hola, quiero consultar el precio del plan Pro"
Internal anchors: `#top`, `#productos`, `#agente`, `#como`, `#precios`. Set
`html{scroll-behavior:smooth; scroll-padding-top:88px}` so the sticky nav doesn't cover anchors.

### Responsive
Desktop-first, single breakpoint at ~900px (and a smaller cleanup ~720px for the nav):
- Hero grid → 1 column; phone centers under the copy.
- Metrics 4-col → 2-col.
- Product/pricing 2-col → 1-col; feature/step 3-col → 1-col.
- Nav text links hide below ~720px (add a menu button if desired).
Font sizes already fluid via `clamp()`.

---

## State Management
Minimal — this is a static marketing page. Only two bits of client state, both handled by the
browser natively:
- `IntersectionObserver` instances for scroll-reveal and chat replay (no app state).
- `<details>`/`<summary>` handle FAQ open/close natively (no JS).
No data fetching. No forms (all conversions go to WhatsApp).

---

## Design Tokens

### Color — brand / dark surfaces
| Role | Hex |
|---|---|
| Deepest bg (page/footer/hero base) | `#071a30` |
| Dark surface (metrics, cards-dark) | `#0a2038` |
| Anchor navy (headings on light, badges) | `#103050` |
| Navy gradient partner | `#0b2947` / `#0f3560` / `#0c2c50` |
| Action blue (primary/link) | `#248DE3` (hover `#1b6fc0`) |
| Electric/cyan (accents, glows) | `#7AFAFC` |
| Light blue | `#58CDF7` |
| Safety yellow (primary CTA/accent) | `#FFC517` |
| Teal/green bridge (WA product, avatars) | `#5BB0A2` / `#0b7d72` (hover `#0b5c56`) |
| WA header green | `#0b5c56` |
| Success dot | `#58BE4D` |

### Color — light surfaces & text
| Role | Hex |
|---|---|
| Page light bg | `#f4f7fb` |
| Card/white surface | `#ffffff` |
| Border (light) | `#e2e9f1` (softer `#cdd9e6`) |
| Border (dark) | `rgba(122,250,252,.08–.2)` |
| Heading on light | `#103050` |
| Body on light | `#5a728d` / `#41566e` |
| Muted on light | `#7089a3` / `#8296ac` |
| Text on dark | `#eaf4ff` / `#a9c2e0` |
| Muted on dark | `#8ba6c6` / `#7f9bbd` / `#5f7ba0` |
| Chip teal bg/text | `#e7f6f1` / `#0b5c56` |
| Chip blue bg/text | `#e8f2fc` / `#1b5a94` |
| Chat incoming / outgoing | `#ffffff` / `#d4f2e7` (text `#0f2723`) |

These map to the Datacor design-system tokens: `--datacor-blue #103050`, `--medium-blue #248DE3`,
`--electric-blue #7AFAFC`, `--light-blue #58CDF7`, `--safety-yellow #FFC517`, `--light-green #5BB0A2`,
`--ui-green #58BE4D`. Use the token names if the target codebase imports `colors_and_type.css`.

### Typography
- **Display / headings:** `'Noto Sans'` (weights 400/500/600/700/800/900). Self-hosted TTFs — see Assets.
- **Body / UI:** `'Roboto'` (400/500/700), from Google Fonts
  (`https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700`). The current site self-hosts
  Inter as body; either keep the design-system Roboto (recommended, matches the system) or leave Inter
  — do not mix three families.
- Heading letter-spacing: `-0.02em` (display tightens to `-0.025em`). Eyebrows: 12–13px uppercase
  +0.06–0.08em.
- Key sizes (fluid): H1 `clamp(38px,5.2vw,68px)`/900; section H2 `clamp(28px,3.4vw,44px)`/800;
  H3 18–23px/800; body 14.5–19px; eyebrow 12.5–13px.

### Spacing
Section vertical rhythm: **100px** top/bottom for most light/dark sections (`padding:100px 0`),
52–90px for bands/testimonial. Container `max-width:1160–1240px`, side padding 24px. Card padding
26–34px. Gaps: grids 20–26px. Base 4px scale (4/8/12/16/24/32/48/64), matching the design system.

### Radius
Pills `999px`; large panels 22–30px; cards 18–20px; small tiles/chips 8–12px; browser-chrome dots
50%. (Design-system ladder is 4/8/12/999; this marketing page relaxes the larger radii — fine for
marketing surfaces.)

### Shadow
- Card resting: `0 1px 3px rgba(16,48,80,.06)`.
- Card hover: `0 30px 60px -24px rgba(16,48,80,.3)` (feature `0 24px 50px -22px rgba(16,48,80,.28)`).
- Yellow CTA: `0 6px–12px 20px–30px -6px/-8px rgba(255,197,23,.55–.6)`.
- Phone: `0 40px 90px -30px rgba(0,0,0,.8)` + `0 0 0 1px rgba(122,250,252,.15)` ring.
- Big framed screenshots: `0 50px 100px -30px rgba(0,0,0,.7)` + cyan ring.

### Motion
- Easing: `cubic-bezier(.2,0,0,1)` (the design system's `--ease-standard`).
- UI transitions 150–280ms. Reveal 700ms. Ambient loops: `syFloat` 7s, `syFloat2` 6s, `syGlow`
  7–10s, `syGridPan` 22s, `syMarquee` 30s.
- Keyframes to port: `syFloat`, `syFloat2`, `syGlow`, `syGridPan`, `syChatIn`, `syMarquee`
  (definitions in the reference file's `<style>` block). `syBlink`/`syShine` exist but are unused —
  can be dropped.

---

## Assets
Live in the current repo already (`landing/assets/`), reused as-is:
- `panel-dashboard-oscuro.webp` (1600×960) — dark dashboard, shown in the browser frame.
- `panel-bandeja-claro.webp` (800×1000) — light inbox, mobile.
- `panel-bandeja-oscuro.webp` (800×1000) — dark inbox, mobile.
- (`panel-dashboard-claro.webp` exists too — not used in this layout, optional.)
- `favicon.svg`, `og.png` — keep; update `og.png` art to the new brand when possible.

Fonts (Noto Sans TTFs) are already served by the backend at `/panel/fonts/*` (the current CSS
references them). Reuse those `@font-face` URLs, or self-host the weights 400/500/600/700/800/900.

**No image/icon was hand-drawn that needs recreating** except the Selyon logo mark (SVG, described
above) and the small inline feature/UI icons (stroke SVGs in the reference, or use Lucide:
message-circle, calendar-check, list, bell, mic, layout-dashboard, check-circle, play).

The **dish "video" card** in the Menú Digital card is a CSS placeholder (orange gradient + ▶). When
the digital-menu product has real assets, swap in a real thumbnail/`<video>` poster.

---

## Files
- `Selyon.dc.html` — the full design reference (this bundle). All exact styles, copy, SVG paths, and
  keyframes are here. Ignore the `<x-dc>`, `<script src="support.js">`, `<helmet>`, and
  `class Component extends DCLogic` scaffolding — that's environment plumbing, not part of the design.
  The logo mark and the icon SVGs are built in the logic class's `renderVals()` via
  `React.createElement`; read them there and reproduce as static inline `<svg>`.
- Target files to modify in the real repo: `landing/index.html` and `landing/assets/estilos.css`
  (and keep `landing/privacidad.html` / `landing/terminos.html` linked from footer/FAQ).

## Suggested implementation order
1. Port design tokens into `estilos.css` (`:root` vars) and set up Noto Sans + Roboto `@font-face`.
2. Rebuild the nav + footer (shared chrome) with the Selyon mark.
3. Hero (static first, then add the grid/glow/float animations and chat replay).
4. Remaining sections top-to-bottom (they're mostly static + reveal-on-scroll).
5. Wire the single `IntersectionObserver` script for reveals + chat replay; add the reduced-motion
   guard.
6. Responsive pass at 900px / 720px.
7. Replace placeholder content: client marquee names, testimonial quote, verify the metrics, set the
   real Menú Digital page URL.
