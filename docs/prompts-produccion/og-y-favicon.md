# Imagen OG de Selyon CRM y favicon completo

> **Punto del checklist:** add OG images and a favicon · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P1 antes de 5 clientes
> **Tipo:** código · **Depende de:** seo-aeo (marcador de URL absoluta de la base) · **Esfuerzo:** 0,5–1 día
> **Archivos principales:** `landing/assets/og.png`, `landing/assets/favicon.svg`, `landing/index.html`, `landing/privacidad.html`, `landing/terminos.html`, `landing/contrato.html`, `src/platform/http/landing.ts`, `web/index.html`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
- **La imagen OG existe pero es de la versión vieja**: `landing/assets/og.png` (1200×630, 293 871 bytes) dice "Recepcionista IA — Tu WhatsApp atendido 24/7" y muestra el panel viejo con el nombre del negocio piloto real ("Lavacar Rosales") y sus datos. No representa "Selyon CRM" (`src/platform/brand.ts:8`) ni el panel nuevo (dirección «Banca privada», commit `5f976e1`). Además expone el nombre de un cliente real en cada preview compartido.
- Está a ~13 KB del límite de 300 KB que WhatsApp tolera para mostrar el preview grande.
- **`og:image` es relativa**: `landing/index.html:15` `content="/landing/og.png"`. Facebook/WhatsApp/LinkedIn piden URL absoluta; con la relativa el preview puede salir sin imagen. Faltan `og:url`, `og:site_name`, `og:image:width`/`height`/`alt` y `twitter:card`.
- No es solo la OG: las capturas de `landing/assets/panel-*.webp` y el mockup del hero (`landing/index.html:83`) también muestran "Lavacar Rosales"; eso lo cubre `optimizar-imagenes` y conviene hacer ambos juntos con el mismo negocio ficticio.
- Las páginas legales (`privacidad.html`, `terminos.html`, `contrato.html`) solo tienen `<link rel="icon" href="/favicon.svg">` (línea 8 de cada una): sin `og:*`.
- **Favicon**: solo SVG. `serveLanding` (`src/platform/http/landing.ts:129-136`) sirve `/favicon.svg` y `/landing/*`; **`/favicon.ico` no existe** (cae en `return false` → 404 del servidor). Safari/iOS y lectores viejos piden `/favicon.ico` y `apple-touch-icon`; la landing no declara `apple-touch-icon` (el panel sí: `web/index.html:9`, `/panel/icons/icon-180.png`).
- El favicon de la landing (`landing/assets/favicon.svg`, logo Selyon azul/amarillo) y el del panel (`web/index.html:16-19`, data URI con el ícono verde de bandeja) son marcas distintas; el `theme-color` del panel es `#0b6b5e`.

## Objetivo
Que compartir cualquier URL pública (por WhatsApp, Facebook, LinkedIn, X) muestre un preview correcto de Selyon CRM, sin datos de clientes reales, y que el sitio tenga favicon en todos los navegadores.

## Alcance
- OG nueva 1200×630 de "Selyon CRM" con datos ficticios (negocio demo, sin nombres reales), < 200 KB (JPEG o PNG optimizado). Puede salir de una captura del panel nuevo con datos del seed de PGlite.
- `og:image` absoluta (con el marcador de base que dejó `seo-aeo` en `readPage`; no crees otro mecanismo), `og:image:width`, `og:image:height`, `og:image:alt`, `og:url`, `og:site_name`, `twitter:card=summary_large_image`.
- Bloque `og:*` también en las 3 páginas legales (misma imagen).
- `/favicon.ico` (32×32 multi-tamaño o PNG) servido por `serveLanding`, `apple-touch-icon` 180×180 para la landing, `ASSET_TYPES` ya admite `ico`.
- Unificar favicon de landing y panel con la marca decidida.

## Fuera de alcance
- Sitemap, robots, JSON-LD y canónicas → `seo-aeo`.
- Peso de las capturas y fuentes de la landing → `optimizar-imagenes`.
- Caché de los assets → `cache`.

## Pasos sugeridos
1. Generá la OG con el panel corriendo sobre PGlite (`npm run dev`, datos del seed) y una plantilla HTML local capturada a 1200×630; nada de datos del piloto.
2. Comprimí la imagen sin dependencias nuevas si se puede (herramienta del sistema); si hace falta un paquete, cumplí la política de dependencias.
3. Actualizá los `<head>` de los 4 HTML; agregá `/favicon.ico` y `/apple-touch-icon.png` a `serveLanding`.
4. Tests: `GET /favicon.ico` 200 con `image/x-icon` (o png); `og:image` de `/` empieza con `http`; tamaño de `og.png`/`og.jpg` < 300 KB (test que lee el archivo).

## Decisiones que el agente NO toma solo
- ¿Qué marca y texto lleva la OG ("Selyon CRM" provisional según `PLAN-GESTION.md` §8, o "Selyon")? ¿Se unifica el favicon del panel con el logo Selyon de la landing o al revés?
- ¿Se puede mostrar el panel en la OG, o solo logo + frase?

## Criterios de aceptación
- [ ] La OG nueva no contiene nombres ni datos de clientes reales y pesa < 200 KB.
- [ ] `og:image` absoluta con width/height/alt en las 4 páginas; `twitter:card` presente (test nuevo).
- [ ] `curl -I localhost:3000/favicon.ico` → 200; `apple-touch-icon` declarado y servido.
- [ ] Preview verificado con el Sharing Debugger de Meta y pegando la URL en WhatsApp (paso humano, en staging).
- [ ] `npm run typecheck` y `npm test` en verde (y `web/` si se toca `web/index.html`).
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización").

## Reglas para este trabajo
- Rama propia `prod/og-y-favicon` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist de pasos humanos pendientes (Sharing Debugger de Meta para refrescar la caché del preview viejo, prueba en WhatsApp).
