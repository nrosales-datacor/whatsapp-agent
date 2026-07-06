# PLAN C4.4 — Landing de venta (handoff ejecutable)

> **Para quién es esto:** un agente (o humano) que va a implementar el ítem **C4.4 — Landing de
> venta** del `ROADMAP.md` (línea 64) sin más contexto que este documento y el repo. Todo lo
> ambiguo ya está decidido acá; lo que quedó abierto está marcado **[PENDIENTE-NATHAN]** con un
> placeholder que NO bloquea la ejecución.
>
> **Regla de oro del repo (CLAUDE.md):** al completar el ítem, marcá la casilla C4.4 en
> `ROADMAP.md` **en el MISMO commit** y actualizá la fecha de "Última actualización". Código y
> comentarios en español (es-CR). Cero dependencias npm nuevas (esta landing no necesita ninguna).

**Última actualización:** 2026-07-05

---

## Estado de avance

| Fase | Qué | Estado |
|---|---|---|
| F1 | Servir la landing desde el server Node (`GET /`, `/privacidad`, `/terminos`, assets) | ✅ |
| F2 | Contenido + diseño de la landing (HTML/CSS estático, mock de chat, copy es-CR) | ✅ |
| F3 | Screenshots reales del panel (claro/oscuro) + imagen OG | ✅ |
| F4 | Política de privacidad + términos (requisito Meta) | ✅ |
| F5 | Verificación (design-verify, regresión) + ROADMAP/DEPLOY + commit | ✅ |
| F6 | Bot vendedor como tenant propio (dogfooding) — **bloqueada por número nuevo** | ⬜ |

Las fases F1–F5 se hacen en orden y cierran el ítem C4.4. F6 es un añadido posterior que NO
bloquea marcar C4.4 (ver §7 por qué).

---

## 0. Contexto en una línea

Página pública de venta del producto SaaS, servida por el **mismo server Node** (`node:http`, sin
framework) que hoy sirve el bot y el panel, en el **root del dominio** — con demo visual del chat,
screenshots del panel, planes y CTA a WhatsApp. Además cumple el requisito de **sitio web público
+ política de privacidad** que pide Meta para el trámite de Tech Provider (`GUIA-META.md` §B,
líneas 80–90) — o sea, esta landing desbloquea también C4.2.

## 0.1 Decisiones ya tomadas (no re-litigar)

| Decisión | Elección | Por qué |
|---|---|---|
| Stack de la landing | **HTML + CSS estáticos a mano** en carpeta `landing/` (raíz del repo). JS vanilla mínimo embebido solo para la animación del mock de chat. **NO React, NO Vite, NO build.** | Cero pasos nuevos de deploy (`git pull` + `pm2 restart` basta), cero deps, carga instantánea, SEO trivial. El panel React vive aparte en `web/` y no se toca. |
| Ruta | `GET /` sirve la landing (hoy responde texto plano "Agente de WhatsApp corriendo ✅", `src/server.ts:34-38`). Ese texto se **mueve a `GET /salud`** como health check. | El root del dominio es la cara pública; un health check no. |
| Marca del producto | Nombre de trabajo **"Recepcionista IA"** **[PENDIENTE-NATHAN: nombre definitivo]**, definido en **UN solo lugar** (ver §3.2) para cambiarlo en un minuto. | El producto aún no tiene nombre; no bloquear por eso. |
| Dominio | El actual `https://wabotlavacar.selyon.app` (DEPLOY.md:195). **[PENDIENTE-NATHAN: dominio propio del producto]** — cuando exista, es solo DNS, la landing no cambia. | Mismo server, mismo cert. |
| CTA principal (demo) | Link `wa.me` al **bot real del piloto** (Lavacar Rosales, +506 8365 8231 → `https://wa.me/50683658231?text=Hola`), presentado honestamente como *"demo en vivo: el bot de nuestro cliente piloto"*. | El bot vendedor con número propio es F6; mientras tanto el producto igual se demuestra a sí mismo con el tenant real. |
| CTA secundario (ventas) | *"Hablemos de tu negocio"* → `wa.me` de un número humano de ventas. Placeholder: el mismo `50683658231` **[PENDIENTE-NATHAN: número personal de ventas]**. | Separar "probar la demo" de "quiero comprar" — el bot del lavacar no sabe vender el SaaS (hasta F6). |
| Precios | Sección "Planes" con **features por plan** (Básico / Pro) y CTA "Consultar precio", **sin montos**. | Los planes reales son C4.3 (Stripe); inventar montos hoy compromete la venta. |
| Fuentes | `@font-face` apuntando a las que el server **ya sirve** en `/panel/fonts/*` (Noto Sans + Inter, `web/src/global.css:10-20`). No duplicar archivos. | Mismo origen, ya cacheadas. |
| Paleta | Los tokens verdes de A8 (`--brand-accent: #0b7d72`, `--brand-header-bg: #0b5c56`, etc. — valores exactos en §4.2), **solo modo claro** en v1. | La landing debe oler al producto; dark mode ahí no aporta y duplica el trabajo de verificación. |
| Screenshots | **Reales**, del panel corriendo local con `SEED_DEMO=1` (datos ficticios — NUNCA conversaciones reales de la base de prod), capturados con Playwright. | Un mockup dibujado envejece y miente; el panel A8 real luce. |
| Skills de diseño | Al maquetar (F2) **invocar el skill `web-design`** antes de escribir markup, y al terminar (F5) **invocar `design-verify`** (390px y 1440px). | Lo exige `PLAN-VALOR-PRODUCTO.md` C4.4 ("usar los skills de diseño web") y es lo que hizo A8. |
| Dependencia C4.1 | La tabla de priorización dice "C4.4 depende de C4.1 (white-label)"; **se ignora**: era para lucir la demo white-label, que se añadirá como screenshot cuando C4.1 exista. Nada técnico bloquea. | La landing ya se necesita para el trámite de Meta (GUIA-META.md:82). |

## 0.2 Reglas heredadas que aplican

- **Nada de CDNs ni requests externos** en la landing (fuentes, CSS, JS e imágenes: todo self-hosted). Coherente con la política de deps y con que el panel ya self-hostea fuentes.
- **No tocar** el webhook (`/webhook`), `/api/panel/*` ni el servido del panel (`/panel/*`). La landing es puramente aditiva.
- **Multi-tenant en mente:** la landing vende el producto genérico; Lavacar Rosales aparece solo como caso/demo, no como "la app".

---

## 1. Mapa de archivos

| Archivo | Acción |
|---|---|
| `landing/index.html` | **NUEVO** — la landing (una sola página) |
| `landing/privacidad.html` | **NUEVO** — política de privacidad (F4) |
| `landing/terminos.html` | **NUEVO** — términos del servicio (F4) |
| `landing/assets/estilos.css` | **NUEVO** — hoja compartida por las 3 páginas |
| `landing/assets/*.webp` / `*.png` / `favicon.svg` / `og.png` | **NUEVO** — screenshots del panel, favicon, imagen OG (F3) |
| `src/landing/servirLanding.ts` | **NUEVO** — handler HTTP de la landing (F1) |
| `src/server.ts` | **EDITAR** — enrutar `/`, `/salud`, `/privacidad`, `/terminos`, `/landing/*`, `/robots.txt`, `/favicon.svg` (líneas 30–46 aprox.) |
| `ROADMAP.md` | **EDITAR** — marcar C4.4 (línea 64) + fecha (línea 9), en el commit final |
| `DEPLOY.md` | **EDITAR** — nota: la landing es estática, no agrega pasos de build |
| `GUIA-META.md` | **EDITAR** — en §B, actualizar la nota de la línea 82 ("hoy no hay landing") con la URL de `/privacidad` |

---

## 2. F1 — Servir la landing desde el server

### 2.1 Handler nuevo: `src/landing/servirLanding.ts`

Imitá el patrón de estáticos del panel (`src/panel/router.ts:96-148`: allowlist de extensiones,
cache en memoria, content-type por extensión). Contrato:

```ts
// Devuelve true si atendió la request; false para que server.ts siga con sus rutas.
export function manejarLanding(req: IncomingMessage, res: ServerResponse, pathname: string): boolean
```

Comportamiento exacto:

- `GET /` → `landing/index.html`, `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-cache`.
- `GET /privacidad` y `GET /terminos` → sus HTML (mismos headers). También aceptar con `.html`
  final (redirect 301 a la versión sin extensión, o servir directo — servir directo es más simple).
- `GET /landing/<archivo>` → assets desde `landing/assets/` con **allowlist** de extensiones
  (`.css .png .webp .svg .jpg .ico`), `Cache-Control: public, max-age=86400` (sin hash → cache
  corto, no `immutable`).
- `GET /favicon.svg` → `landing/assets/favicon.svg`. `GET /robots.txt` → responder inline
  `"User-agent: *\nAllow: /\nDisallow: /panel\n"` (text/plain).
- **Anti path-traversal:** resolver con `path.join` + verificar que el resultado empiece con la
  carpeta `landing/assets/` resuelta (mismo enfoque que `leerDistAsset`), además de la allowlist.
- **Cache en memoria** de HTML y assets (Map módulo-global, como `distAssetCache` en
  `router.ts:110`), **salvo** cuando `process.env.SEED_DEMO` está seteado → releer del disco en
  cada request (mismo criterio que `leerReactIndex`, `router.ts:74-92`) para iterar en dev.
- Archivo inexistente bajo `/landing/*` → 404. Si `landing/index.html` no existe → 503 con texto
  claro (paridad con el panel, `router.ts:431-433`).
- Método ≠ GET/HEAD en estas rutas → 405.

### 2.2 Cambios en `src/server.ts`

En el dispatcher (líneas 30–46):

1. **Antes** del bloque actual de `GET /`, agregar `GET /salud` con la respuesta actual
   ("Agente de WhatsApp corriendo ✅") — es el health check de ahora en adelante.
2. Reemplazar el bloque de `GET /` por la llamada a `manejarLanding(...)` (que también captura
   `/privacidad`, `/terminos`, `/landing/*`, `/robots.txt`, `/favicon.svg`).
3. No tocar nada más: `/panel`, `/api/panel/*` y `/webhook` siguen idénticos.

**Chequeo obligatorio antes de mover `GET /`:** `grep -rn "salud\|healthcheck\|curl.*3001/\b" DEPLOY.md README.md` y revisar si algo (uptime monitor, Caddy/nginx, instrucciones de verificación del deploy) usa `GET /` como health check. Si DEPLOY.md lo usa, actualizá esas instrucciones a `/salud` en el mismo commit. (B5/observabilidad aún no existe, así que no debería haber monitor externo — pero verificalo, no lo asumas.)

### 2.3 Done de F1

Con `landing/index.html` provisional ("hola landing"): arrancar local en memoria (receta abajo, §6.1) y verificar con curl: `/` → HTML, `/salud` → texto ✅, `/robots.txt` → ok, `/landing/estilos.css` → css, `/landing/../package.json` → 404, `/panel` y `GET /webhook` (verify token) intactos. `npm run typecheck` (o `npx tsc --noEmit`) verde.

---

## 3. F2 — Contenido y diseño de la landing

> **Primero invocá el skill `web-design`** y aplicalo a esta página. Lo de abajo define contenido
> y restricciones; el skill define el nivel de acabado. Estética objetivo: la del panel A8 —
> limpia, verde, profesional, mucho aire — NO una landing genérica de template.

### 3.1 Idioma y tono del copy

Español de Costa Rica, **voseo** (como el bot: "escribinos", "probá", "atendé"). Tono directo, de
dueño de negocio a dueño de negocio — sin humo corporativo. Los dolores que el copy ataca (salen
de la tesis de `PLAN-VALOR-PRODUCTO.md` §0): mensajes sin contestar fuera de horario, no-shows,
el dueño esclavo del teléfono, todo en la cabeza del dueño y nada medible.

### 3.2 La marca en un solo lugar

En `landing/index.html`, arriba de todo:

```html
<!-- MARCA: cambiar el nombre del producto solo acá y en <title>/<meta>. -->
```

y usar el nombre **"Recepcionista IA"** de forma consistente (header, hero, footer, title, OG).
Mantener las menciones en pocos lugares y contiguas para que el reemplazo futuro sea un
buscar-y-reemplazar trivial.

### 3.3 Estructura de la página (en orden)

1. **Header** fijo simple: nombre del producto + CTA chico "Ver demo".
2. **Hero:** headline del dolor→resultado (p. ej. *"Tu negocio atiende WhatsApp 24/7, agenda solo,
   y nadie te deja plantado"* — refinala con el skill), subheadline de una línea (qué es: asistente
   con IA para WhatsApp que responde, cotiza y agenda), **CTA primario** "Probá la demo en vivo"
   (wa.me del bot, §0.1) + CTA secundario "Hablemos de tu negocio". Al lado/abajo: el **mock de
   chat** (§3.4).
3. **Barra de confianza:** una línea — *"En producción con Lavacar Rosales (San José, CR)"*.
4. **Features** (6 tarjetas; cada una existe de verdad — no prometer lo no construido):
   - Responde al instante, 24/7 (dudas, precios, horarios — con IA, no menús).
   - Agenda, reprograma y cancela citas solo (sincronizado con Google Calendar) — C1.1.
   - Botones y listas nativas: el cliente confirma con un tap — C1.2.
   - Recordatorios con confirmación = menos plantazos — C1.3.
   - Entiende notas de voz — C1.4.
   - Panel para tu equipo: bandeja con takeover humano, CRM y métricas, instalable en el celular
     con notificaciones (PWA) — A4–A8.
5. **Screenshots del panel** (F3): claro + oscuro, móvil + desktop, con captions de una línea.
6. **Cómo funciona** (3 pasos): 1) Configuramos tu negocio (servicios, precios, horarios) →
   2) Conectamos tu WhatsApp → 3) El bot atiende y vos ves todo en el panel.
7. **Planes** (sin montos, §0.1): **Básico** (bot + agenda + panel + recordatorios) / **Pro**
   (+ campañas, multi-usuario, marca propia). Nota chica: *"precios de lanzamiento — escribinos"*.
   CTA "Consultar precio" → CTA secundario de ventas.
8. **FAQ** (5–6, en `<details>`): ¿Necesito cambiar mi número? (no) · ¿Y si el bot no sabe algo?
   (te avisa y pasa a un humano) · ¿Puedo responder yo? (sí, takeover desde el panel) · ¿Qué pasa
   con mis datos? (link a /privacidad) · ¿Cuánto tarda estar operando? (días, no meses) ·
   ¿Sirve para mi rubro? (cualquier negocio con citas).
9. **CTA final** grande (repite el primario).
10. **Footer** — obligatorio por Meta (GUIA-META.md:80): nombre del negocio/responsable
    **[PENDIENTE-NATHAN: nombre legal]**, ubicación (San José, Costa Rica), email de contacto
    **[PENDIENTE-NATHAN]**, y links a `/privacidad` y `/terminos`.

### 3.4 El mock de chat del hero

Conversación WhatsApp simulada en HTML/CSS (burbujas dentro de un marco de teléfono), con la
transcripción demostrando lo diferencial en ~6 mensajes: cliente manda *audio* 🎤 → bot entiende y
cotiza → ofrece horarios como **lista** → cliente toca uno → bot confirma cita ✅. Animación de
aparición secuencial de burbujas con CSS (`animation-delay`) o un `IntersectionObserver` de ~15
líneas de JS vanilla **embebido** (sin archivo JS aparte, sin librerías). Respetar
`prefers-reduced-motion`. Colores de burbuja del sistema del panel: `--bubble-in: #ffffff`,
`--bubble-out: #d4f2e7` sobre un fondo de chat suave.

### 3.5 `landing/assets/estilos.css`

- Copiar **los tokens** (variables `:root`) relevantes de `web/src/global.css` — solo modo claro
  (§0.1): paleta completa en §4.2 del reporte de diseño; los imprescindibles:
  `--brand-accent:#0b7d72`, `--brand-accent-fg:#fff`, `--brand-header-bg:#0b5c56`,
  `--brand-header-fg:#eafcf6`, `--bg:#e9efec`, `--surface:#fff`, `--surface-2:#f4f8f6`,
  `--text:#0f2723`, `--text-2:#5e716c`, `--border:#e3ebe7`, `--accent-soft:#d6efe9`,
  `--accent-strong:#084f46`, `--radius:16px`, `--radius-pill:999px`, y las sombras
  (`--shadow: 0 1px 2px rgba(15,39,35,.05), 0 10px 30px rgba(15,39,35,.06)`).
  Copiar valores, NO importar el global.css del panel (trae estilos de app que ensucian).
- `@font-face`: **Noto Sans** para display (`/panel/fonts/NotoSans-Regular.ttf`, `-SemiBold`,
  `-Bold`, `-ExtraBold`) e **Inter** para body (`/panel/fonts/inter-400.woff2`, `-500`, `-600`) —
  mismas declaraciones de `web/src/global.css:10-20`, con `font-display: swap`.
- Mobile-first, breakpoints ~720px y ~1080px. Sin overflow horizontal a 390px (esto lo caza
  design-verify en F5).

### 3.6 SEO / metadatos del `<head>`

`lang="es-CR"`; `<title>` y `<meta name="description">` con el nombre del producto y la promesa;
Open Graph completo (`og:title`, `og:description`, `og:image` → `/landing/og.png`, `og:locale`
`es_CR`); `<link rel="icon" href="/favicon.svg">`; viewport. Nada de analytics en v1 (requests
externos prohibidos, §0.2).

---

## 4. F3 — Screenshots reales del panel + OG

1. Arrancar el server local **en memoria con datos de demo** (receta §6.1) — los datos de
   `SEED_DEMO` son ficticios; está prohibido capturar datos reales de producción.
2. Con Playwright (ya usado en A8 Fase 4; si el entorno no lo tiene: `npx playwright screenshot`
   o un script efímero en el scratchpad — NO agregarlo a `package.json` ni a deps), loguearse al
   panel (usuario `lavacar-rosales`, hash demo por env — ver §6.1) y capturar:
   - Bandeja + chat, **390px** claro y oscuro (toggle de tema en el header del panel).
   - Dashboard, **1440px** claro y oscuro.
   - (Cuatro capturas bastan; más diluye.)
3. Post-proceso: recortar, y exportar **`.webp`** (calidad ~80) a `landing/assets/`. Ancho máx
   ~1600px las de desktop, ~800px las móviles. En el HTML: `loading="lazy"`, `width`/`height`
   explícitos (evitar layout shift), `alt` descriptivo.
4. **`og.png`**: 1200×630 — composición simple: fondo `--brand-header-bg`, nombre + headline +
   un screenshot inclinado. Puede generarse como HTML efímero capturado con Playwright.
5. **`favicon.svg`**: dibujarlo a mano (SVG de ~10 líneas): burbuja de chat verde
   `#0b7d72` con un check blanco. Sin generadores externos.

---

## 5. F4 — Privacidad y términos

Páginas sobrias (mismo `estilos.css`, layout de una columna ~720px). **No es asesoría legal**:
es la página que Meta exige para App Review (GUIA-META.md:89) — clara, honesta y completa.
Marcar fecha de vigencia. Contenido mínimo de `privacidad.html`:

- **Responsable:** nombre y contacto del footer (mismos placeholders [PENDIENTE-NATHAN]).
- **Qué datos se procesan:** número de WhatsApp, nombre del perfil, contenido de los mensajes
  (texto y notas de voz), datos de la cita (servicio, fecha/hora, vehículo si aplica).
- **Para qué:** responder consultas, gestionar citas y recordatorios del negocio al que el
  usuario le escribe. No se venden datos ni se usan para publicidad de terceros.
- **Con quién se comparten (encargados):** Meta/WhatsApp (mensajería), OpenAI (procesamiento del
  lenguaje y transcripción de audios), Supabase/PostgreSQL (almacenamiento), Google Calendar
  (eventos de cita). Cada uno solo para prestar el servicio.
- **Retención y derechos:** los datos se conservan mientras exista relación con el negocio;
  contacto del responsable para acceso/rectificación/supresión.
- **Opt-out:** escribir al negocio para no recibir más mensajes.

`terminos.html` (corto): qué es el servicio, que la disponibilidad de WhatsApp depende de Meta,
que las citas las presta el negocio (el software es intermediario), limitación de responsabilidad
razonable, contacto.

Al terminar, actualizar `GUIA-META.md` §B: la nota de la línea 82 pasa a decir que la landing
existe y que la URL de política de privacidad para App Review es `https://<dominio>/privacidad`.

---

## 6. F5 — Verificación y cierre

### 6.1 Receta para correr local (de la memoria del repo, verificada 2026-07-03)

El `.env` local apunta a la base de **producción** → para probar en memoria hay que vaciar las
vars **desde Git Bash** (en PowerShell `$env:VAR=''` la borra y dotenv recarga la de `.env`):

```bash
DATABASE_URL='' WHATSAPP_ACCESS_TOKEN='' SEED_DEMO=1 npx tsx src/server.ts
# Panel demo: usuario lavacar-rosales + la contraseña cuyo hash esté en PANEL_PASSWORD_HASH_ROSALES
```

### 6.2 Checklist de verificación (todas obligatorias)

- [ ] `npx tsc --noEmit` verde (el handler nuevo compila).
- [ ] curl: `/` (200 html) · `/privacidad` · `/terminos` · `/salud` (texto ✅) · `/robots.txt` ·
      `/favicon.svg` · `/landing/estilos.css` (content-type css) · `/landing/../.env` y
      `/landing/x.ts` (404) · `POST /` (405).
- [ ] Regresión: `/panel` sirve el bundle React; `GET /webhook` con verify token responde el
      challenge; `/api/panel/me` responde igual que antes.
- [ ] **Skill `design-verify`** sobre `/`: 390px y 1440px, sin overflow horizontal, jerarquía y
      contraste OK, mock de chat legible, imágenes sin layout shift. Corregir lo que salga.
- [ ] Los dos links `wa.me` abren con el texto prellenado correcto.
- [ ] Buscar en el HTML final la cadena `PENDIENTE-NATHAN`: debe aparecer **solo** en comentarios
      HTML, nunca en texto visible (los placeholders visibles usan el valor de trabajo de §0.1).
- [ ] Peso: página + assets < 1.5 MB total (las .webp son lo único pesado).

### 6.3 Cierre (mismo commit)

- `ROADMAP.md`: línea 64 → `- [x] ✅ **C4.4 — Landing de venta** ...` con resumen de 3–5 líneas al
  estilo de C1.1–C1.4 (qué se sirvió, rutas nuevas, nota de que `/` dejó de ser health check →
  `/salud`, y que F6/bot vendedor queda pendiente de número nuevo). Actualizar línea 9 (fecha).
- `DEPLOY.md`: nota corta en el flujo de redeploy: la landing es estática dentro del repo — no
  agrega pasos (el `git pull` la trae); si algo usaba `GET /` como health check, ahora es `/salud`.
- Mensaje de commit estilo del repo: `C4.4: landing de venta pública (/, /privacidad, /terminos) servida por el server`.
- **Publicación:** el deploy real lo corre Sebastián en el droplet (flujo DEPLOY.md paso 13);
  no intentar deployar desde acá — dejarlo dicho en el resumen final al usuario.

---

## 7. F6 — Bot vendedor como tenant propio (posterior, no bloquea C4.4)

**Por qué está bloqueada:** `phoneNumberId` es único por tenant (`src/db/schema.ts:134-162`,
índice `wa_tenants_pnid_uq`) — el bot vendedor necesita **su propio número de WhatsApp** en la
WABA. Conseguirlo es un trámite operativo de Nathan **[PENDIENTE-NATHAN: número nuevo en la WABA
+ su `phone_number_id`]**.

Cuando exista el número, F6 es solo configuración (cero código nuevo — eso es el dogfooding):

1. Alta por el admin (`/panel/admin`, flujo B3) de un tenant `ventas` con ese `phoneNumberId`.
2. Su config: `servicios` = una entrada no-agendable tipo "Demo del producto" (o agendable de
   30 min = "agendá una llamada de demo" — el bot agendando la reunión de ventas ES el pitch);
   `kb` con el pitch del producto: qué hace (features de §3.3.4), planes, preguntas típicas de
   un dueño de negocio, y política de escalar a humano (Nathan) ante intención de compra.
3. Cambiar el CTA primario de la landing al número del bot vendedor (un solo `href`).
4. Marcar esta fase en la tabla de §Estado y anotar el avance en `ROADMAP.md` (línea de C4.4).

---

## 8. Resumen de placeholders [PENDIENTE-NATHAN]

| Qué | Placeholder en v1 | Dónde se cambia después |
|---|---|---|
| Nombre del producto | "Recepcionista IA" | `landing/index.html` (§3.2), title/OG |
| Dominio propio | `wabotlavacar.selyon.app` | Solo DNS; la landing usa rutas relativas |
| Número de ventas (CTA 2º) | `50683658231` | Un `href` en index.html |
| Nombre legal + email (footer y privacidad) | "Lavacar Rosales — San José, CR" + sin email visible hasta tenerlo | Footer + privacidad.html |
| Número del bot vendedor (F6) | CTA demo → bot del lavacar | Un `href` (§7.3) |
| Montos de planes | "Consultar precio" | Sección Planes, cuando exista C4.3 |
