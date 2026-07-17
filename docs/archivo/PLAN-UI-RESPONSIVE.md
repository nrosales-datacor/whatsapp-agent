> ✅ **Archivado — plan ejecutado.** Nunca tuvo casilla de estado propia ni ítem en `ROADMAP.md`
> (esa fue una de las causas del desorden); verificado por grep contra el código (2026-07-17) que
> las Fases 1–4 están todas aplicadas (`.campo > input`, `.panel-mobile-grid` responsive, `dvh`,
> `color-mix`, `nav-burger`, `.kpis` a 3 columnas, `.agenda-chip` con ellipsis, safe-area en
> `#toasts`, etc.). No queda trabajo pendiente de este documento.

# PLAN — Ajustes visuales/responsive (panel React + landing)

> **Para el modelo ejecutor:** este plan es autocontenido. Sale de una auditoría completa de
> `web/src/global.css` (590 líneas), todos los componentes de `web/src/components/` y
> `landing/` (3 HTML + `assets/estilos.css`). Los `archivo:línea` eran exactos al momento de la
> auditoría (2026-07-12); **verificá cada selector con Grep antes de editar** por si el archivo
> se movió unas líneas. No instalar dependencias (ver política en `CLAUDE.md`). Código y
> comentarios en español (es-CR). Al terminar, si algún ítem del `ROADMAP.md` aplica, actualizarlo
> en el mismo commit.

## Contexto de arquitectura (leer antes de tocar nada)

### Panel React (`web/src/`)
- **Un solo CSS global:** `web/src/global.css`. Sin CSS-modules ni Tailwind. Cada pantalla es un
  `id` contenedor (`#lista`, `#chat`, `#dashboard`, `#agenda`, `#miNegocio`, `#campanias`,
  `#usuarios`, `#admin`).
- **Tokens:** variables en `:root, [data-tema="claro"]` (~líneas 25-94) con override en
  `[data-tema="oscuro"]` (~100-120). Tipografía fluida `--step--1`…`--step-5`. White-label:
  `--brand-accent`, `--brand-header-bg`, etc., inyectadas por tenant desde `web/src/lib/marca.ts`;
  `web/src/lib/tema.ts` alterna `data-tema`. Hay alias legacy (`--gris`, `--verde`, `--texto`,
  `--text-muted`) que conviven con los tokens nuevos.
- **UN solo breakpoint:** `@media (max-width: 760px)` (~línea 476). `Panel.tsx:19` replica
  `ANCHO_MOVIL = 760` en JS.
- **Patrón de anchos de formulario:** por scoping de id — `#login input`, `#admin input`,
  `#agendaForm input`, `#miNegocio input`, todos `width:100%`. `#campanias` y `#usuarios` NO lo
  tienen (origen del bug C-1).
- **Piezas compartidas:** `.dash-body` (max-width 960 centrado), `.card`, `.admin-form`,
  `.admin-tabla-scroll` + `.admin-tabla` (tabla con overflow-x propio), `.admin-servicio` (fila
  flex-wrap con `input { min-width:120px; flex:1 }`), `.campo` (`min-width:0`), `.accion*`,
  `.btn-ghost`, `.ficha-modal` + `.overlay`.

### Landing (`landing/`)
- **Un solo CSS:** `landing/assets/estilos.css` (~536 líneas), compartido por `index.html`,
  `privacidad.html`, `terminos.html`. Los HTML referencian `/landing/estilos.css` (el server
  mapea `/landing/ → landing/assets/` en `src/landing/servirLanding.ts`).
- **Tokens en `:root`** (~22-83): paleta oscura (`--profundo`, `--oscuro`, `--marino`, `--azul`,
  `--cian`, `--amarillo`), superficies claras, anchos (`--ancho-nav` 1240, `--ancho-seccion` 1160,
  `--ancho-angosta` 800, `--ancho-cta` 1080). `color-scheme: light` forzado (decisión de diseño).
- **`.contenedor`** = max-width 1160 + `padding-inline: 24px`. Los modificadores `--ancha/--media/
  --angosta` solo cambian max-width (el padding lo aporta la clase base — no usar el modificador
  solo).
- **Breakpoints mobile-first:** `min-width:820px` (muestra `.nav-enlaces`) y `min-width:900px`
  (activa TODAS las grillas multi-columna). Entre 430 y 900px todo es 1 columna.
- `body { overflow-x: hidden }` (~línea 94) enmascara desbordes: no confiarse de que "no hay
  overflow" al probar.

---

## FASE 1 — Severidad ALTA (hacer primero, bajo riesgo)

### 1.1 Panel · Campañas: inputs/textarea diminutos (afecta mobile y desktop)
- **Síntoma:** en "Nueva campaña" (`web/src/components/Campanias.tsx` ~190, ~194) y en el
  datetime del modal de detalle (~359), los campos están en `<div className="campo">` pero
  `.campo` solo define `min-width:0` y no existe regla de ancho para `#campanias` → los inputs
  quedan al ancho por defecto del navegador (~170px).
- **Fix (UNA regla en `global.css`, junto a `.campo` ~548):**
  ```css
  .campo > input, .campo > textarea, .campo > select { width: 100%; }
  ```
- **⚠️ NO usar scoping por id** (`#campanias input { width:100% }`): la especificidad del id
  pisaría `.admin-servicio input { flex:1 }` y rompería la fila "Agregar usuario" de
  `Usuarios.tsx` y las filas de servicios de `MiNegocio.tsx`. El selector hijo directo de
  `.campo` no las toca.
- **Verificar después:** Campañas (form + modal detalle), Usuarios (fila de alta intacta),
  Mi negocio (servicios intactos), Onboarding/FormularioNegocio.

### 1.2 Landing · Capturas del panel apretadas 2-up en mobile
- **Síntoma:** `.panel-mobile-grid { grid-template-columns: 1fr 1fr }`
  (`landing/assets/estilos.css` ~407) muestra dos imágenes retrato 800×1000
  (`landing/index.html` ~308-321) lado a lado sin colapso: a 360px cada captura mide ~144px →
  ilegible.
- **Fix:**
  ```css
  .panel-mobile-grid { grid-template-columns: 1fr; }
  @media (min-width: 640px) { .panel-mobile-grid { grid-template-columns: 1fr 1fr; } }
  ```
  (Respetar el estilo mobile-first del archivo. De paso puede quitarse el `max-width:
  var(--ancho-nav)` redundante de esa misma regla: vive dentro de `.contenedor` de 1160.)

---

## FASE 2 — Panel, severidad MEDIA

### 2.1 Modales cortados en mobile (`vh` → `dvh`)
- `global.css` ~338: `.ficha-modal { max-height: 88vh }` → con la barra de URL visible el pie del
  modal (botón Guardar) queda tapado. Afecta FichaModal, ModalCita (Agenda) y DetalleCampania.
- **Fix (con fallback):**
  ```css
  .ficha-modal { max-height: 88vh; max-height: 88dvh; }
  ```

### 2.2 Shell móvil con `height:100%` / `inset:0` sin `dvh`
- `global.css` ~126 (`html, body, #root { height:100% }`) y ~481 (`#chat { position:fixed;
  inset:0 }`): el `#composer` del chat puede quedar detrás de la barra de URL dinámica.
- **Fix:** `#app { min-height: 100vh; min-height: 100dvh; }` y en la media query ≤760:
  `#chat { height: 100vh; height: 100dvh; }`. Probar el chat mobile con teclado abierto después
  del cambio (que el composer no salte).

### 2.3 Dashboard: KPIs desbalanceados y números que desbordan
- `global.css` ~363: `.kpis { grid-template-columns: repeat(4,1fr) }` pero `Dashboard.tsx`
  (~136-167) pinta **6 KPIs** → en desktop quedan 4 + 2 huérfanos.
  **Fix:** `repeat(3, 1fr)` (2 filas de 3) o `repeat(auto-fit, minmax(180px, 1fr))`. En móvil ya
  colapsa a `repeat(2)` (~490) — dejarlo.
- `global.css` ~369: `.kpi-n` con `--step-3` + `font-weight:900`; "Ingresos estimados"
  (`₡1,234,567`) desborda una tarjeta de ~150px en móvil 2-col.
  **Fix:** `.kpi-n { font-size: clamp(var(--step-2), 6vw, var(--step-3)); overflow-wrap: anywhere; }`

### 2.4 Header del panel: la marca roba ancho a las tabs en móvil
- `global.css` ~172: `.hd-marca { flex:1 }`. En móvil `.hd-marca-txt` se oculta (~516) pero el
  contenedor sigue creciendo y comprime `.hd-tabs` (6 tabs con rol dueño quedan casi siempre en
  scroll).
- **Fix:** dentro de `@media (max-width:760px)`: `.hd-marca { flex: 0 0 auto; }`

### 2.5 Header del chat apretado en móvil ("Atender yo" vs título)
- `global.css` ~273: `#chat header` sin `flex-wrap`; `Chat.tsx` ~131-175 mete volver + título +
  pills + "Ver ficha" + toggle "Atender yo/Devolver al bot" (`white-space:nowrap`). A 360px con
  teléfono largo queda comprimido y feo (problema ya conocido: el toggle tapa el header).
- **Fix:** en la media query ≤760: `#chat header { flex-wrap: wrap; row-gap: 6px; }` y dejar que
  el toggle baje a segunda fila. Verificar visualmente que `.volver` y el título queden alineados.

### 2.6 Colores hardcodeados que rompen modo oscuro / white-label
- `global.css` ~301 `.accion-check { border-color:#c5e8bf }`, ~305 `.accion-alerta
  { border-color:#fcd9a8 }`, ~438 `.badge-estado.no_show { background:#fdecd2 }`, ~448
  `.agenda-chip.no_show { background:#fdecd2 }`. En `data-tema="oscuro"` quedan como parches
  claros (los `:hover` sí tienen override oscuro en ~303/~307; los base no).
- **Fix:** sustituir por tokens con transparencia, p. ej.:
  ```css
  .accion-check  { border-color: color-mix(in srgb, var(--success) 40%, transparent); }
  .accion-alerta { border-color: color-mix(in srgb, var(--warning) 45%, transparent); }
  .badge-estado.no_show, .agenda-chip.no_show {
    background: color-mix(in srgb, var(--warning) 18%, transparent);
    color: var(--warning);
  }
  ```
  Verificar en claro y oscuro (toggle `.btn-hd-icono`), y con un tenant white-label si es fácil.

### 2.7 Agenda: chips de la vista semana sin truncado
- `global.css` ~444: `.agenda-chip` sin ellipsis; en 7 columnas (~100px c/u en tablet 761-900px)
  los nombres largos hacen wrap y descuadran las columnas.
- **Fix:** `.agenda-chip { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }`

### 2.8 Admin/Onboarding: padding sin reducir en móvil
- `global.css` ~543: `.admin-body { padding: var(--space-xl) var(--space-lg) }` y la media query
  ≤760 no lo ajusta (`.dash-body` sí baja a `--space-md` en ~487).
- **Fix:** dentro de `@media (max-width:760px)`: `.admin-body { padding: var(--space-md); }`

---

## FASE 3 — Landing, severidad MEDIA

### 3.1 Navegación inaccesible bajo 820px (sin hamburguesa)
- `estilos.css` ~193: `.nav-enlaces { display:none }` y solo reaparece en `min-width:820px`. En
  mobile solo quedan logo + "Ver demo": "Productos / Cómo funciona / Precios" son inalcanzables.
- **Fix mínimo sin JS pesado** (mantener el estilo del archivo): botón hamburguesa en el header
  de `index.html` que togglee una clase en `<header>`:
  - HTML: `<button class="nav-burger" aria-label="Abrir menú" aria-expanded="false">☰</button>`
    (visible solo `<820px`), antes de `.nav-derecha`.
  - CSS: bajo 820px, `header.nav-abierta .nav-enlaces { display:flex; flex-direction:column; }`
    posicionado bajo el header (fondo `--oscuro`, padding, `box-shadow`).
  - JS: la landing ya tiene un `<script>` inline al final de `index.html` (reveal on-scroll);
    agregar ahí el toggle (click → alterna clase + `aria-expanded`, click en enlace → cierra).
  - Solo aplica a `index.html` (las legales no tienen nav, ver "No tocar" abajo).

---

## FASE 4 — Severidad BAJA (opcionales; hacer solo las de bajo riesgo)

Panel:
1. **`.dato b` del FichaModal sin word-break** (`global.css` ~343-345): placas/URLs largas
   empujan el layout → `.dato b { overflow-wrap: anywhere; min-width: 0; }`
2. **Estilos inline inconsistentes en `FichaModal.tsx`** (~76, ~80): `var(--text-muted)` vs
   `var(--gris)` y `fontSize:13` → unificar en una clase con `var(--text-2)` y `var(--step--1)`.
3. **Botones `‹ › Hoy` de Agenda angostos en móvil** (`Agenda.tsx` ~139-147): en ≤760
   `.agenda-nav .btn-ghost { min-width: 44px; justify-content: center; }` (verificar el nombre
   real del contenedor de esos botones antes de inventar la clase).
4. **Red de seguridad de overflow:** `body { overflow-x: hidden; }` en `global.css` (el panel no
   la tiene; agregarla DESPUÉS de arreglar 2.3, no antes, para no enmascarar el bug).
5. **Toasts sin safe-area** (`global.css` ~460):
   `#toasts { bottom: calc(var(--space-md) + env(safe-area-inset-bottom)); }`
6. **`.split-bar` sin regla** (`Dashboard.tsx` ~84): clase muerta; quitarla del JSX.
7. **Mi negocio en móvil:** cada `.admin-servicio` como tarjeta (borde + padding + gap) en ≤760
   para separar visualmente los servicios.
8. **Defaults de color duplicados en `MiNegocio.tsx`** (~261, ~270): `#0b7d72`/`#0b5c56`
   duplican los tokens de `global.css` (~38, ~40) → extraer a constantes compartidas o leer de
   `getComputedStyle`.

Landing:
9. **Testimonio apretado en móvil** (`estilos.css` ~427): bajo 640px
   `.testimonio-tarjeta { padding: 36px 24px; }`
10. **`<br>` forzados del hero y CTA final** (`index.html` ~63 y ~443): envolver en
    `<br class="solo-desktop">` + `@media (max-width:640px){ .solo-desktop{ display:none } }`
    para que `text-wrap: balance` trabaje en móvil.
11. **Chips decorativos del teléfono recortados** (`estilos.css` ~296-297: `left:-46px` /
    `right:-40px`): bajo 900px reducir el offset (p. ej. `-10px`) o escalarlos.
12. **Títulos fijos sin clamp:** `.tarjeta-producto-body h3` (~370, 23px) y `.plan-nombre`
    (~451, 26px) → opcional `clamp(20px, 5vw, 26px)` por consistencia.

---

## NO TOCAR (decisiones de diseño confirmadas en la auditoría)

- **Landing sin modo oscuro** (`color-scheme: light` forzado): intencional, secciones
  oscuras/claras intercaladas por marca.
- **Dashboard-oscuro fijo en la sección oscura de la landing** (sin `<picture>` por tema): el
  grid de abajo ya muestra claro+oscuro.
- **Headers de `privacidad.html`/`terminos.html` solo con logo** (sin nav/CTA): deliberado, hay
  enlace "← Volver".
- **`.btn-fb` azul #1877f2** (`global.css` ~569): color de marca de Facebook para el Embedded
  Signup, debe quedarse.
- **`.hd-tabs` con scroll horizontal en móvil** y **badges de campaña sin color por estado**
  (`borrador/programada/enviando` caen al gris base): aceptados; no "arreglar".
- **Tablas admin (`.admin-tabla-scroll`) y historial de campañas:** ya tienen su propio
  `overflow-x:auto`; no envolver de nuevo.

## Riesgos / precauciones transversales

- `color-mix()` y `dvh` tienen soporte amplio desde 2023; el panel es PWA moderna, OK. Aun así
  dejar siempre el fallback `vh` en la línea anterior (patrón de 2.1/2.2).
- El repo usa **es-CR** en clases, comentarios y textos.
- No renombrar clases existentes ni cambiar la API `/api/panel/*`.
- Cambios solo en: `web/src/global.css`, `web/src/components/*.tsx` (mínimos),
  `landing/index.html`, `landing/assets/estilos.css`. Nada de backend.
- **Hay cambios sin commitear** en varios de estos archivos (branch `c4.2-embedded-signup`);
  editar sobre el working tree actual sin revertir nada.

## Verificación (obligatoria al final)

1. `npm run build` (o el script de build del panel en `web/`) — sin errores.
2. Usar la skill **`design-verify`** para capturar y criticar:
   - **Landing:** servir estático y capturar `index.html` a 360, 390, 768, 1280 y 1536px.
     Revisar: sección de capturas del panel (1.2), nav hamburguesa (3.1), hero, precios, CTA.
   - **Panel:** capturar a 360, 390 y 1280px las pantallas: Campañas (form completo), Dashboard
     (6 KPIs), Chat abierto en móvil (header + composer), Agenda semana en ~820px, Mi negocio,
     Onboarding admin. En claro Y oscuro (toggle `.btn-hd-icono`; en móvil, alternar el tema
     ANTES de abrir una conversación — con el chat abierto el toggle queda tapado).
3. Gotchas del entorno local para Playwright (de sesiones previas): no es dependencia del
   proyecto — usar `npx playwright@<versión con +1 mes> install chromium`; el login del panel no
   tiene contraseña plana — generar hash scrypt propio (formato `salt:hash` de
   `src/panel/auth.ts`) y pasarlo como `PANEL_PASSWORD_HASH_ROSALES` inline al arrancar el
   server, sin tocar `.env`. Selectores útiles: `.conv`, `.volver`, `.btn-hd-icono`, tabs por
   texto.
4. Confirmar que NO se rompió: fila "Agregar usuario" (`Usuarios.tsx`), filas de servicios
   (`MiNegocio.tsx`), tablas admin con scroll, login.

## Orden de commits sugerido

1. `UI: fixes de alta prioridad (inputs de campañas + capturas landing en mobile)` — Fase 1.
2. `UI panel: responsive mobile (dvh, header, chat, dashboard, agenda, admin) + modo oscuro` — Fase 2.
3. `UI landing: menú hamburguesa en mobile` — Fase 3.
4. `UI: pulido menor (opcional)` — Fase 4, solo lo que pase verificación sin fricción.
