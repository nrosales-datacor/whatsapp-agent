# Imágenes y fuentes de la landing: capturas actuales y sin 404

> **Punto del checklist:** optimize images · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P2 puede esperar (las fuentes rotas: P1)
> **Tipo:** código · **Depende de:** og-y-favicon (la OG se rehace allá) · **Esfuerzo:** 0,5 día
> **Archivos principales:** `landing/assets/estilos.css`, `landing/assets/panel-*.webp`, `landing/index.html`, `src/platform/http/landing.ts`, `src/platform/http/staticPanel.ts`, `scripts/fetchFonts.mjs`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
Lo que ya está bien (no rehacer):
- Las 4 capturas de la landing son WebP de 31–35 KB (`landing/assets/panel-{dashboard,bandeja}-{claro,oscuro}.webp`), con `width`/`height` y `loading="lazy"` (`landing/index.html:304,310,316`), así que no hay CLS ni carga temprana.
- Íconos de la PWA livianos (`web/public/icons/icon-{180,192,512}.png`, 1–4 KB). Logo y favicon de la landing son SVG inline/archivo.

Lo que falta:
- **Fuentes rotas en la landing**: `landing/assets/estilos.css:11-20` declara 6 `@font-face` de Noto Sans en **TTF** (`/panel/fonts/NotoSans-*.ttf`) y 4 de Inter (`/panel/fonts/inter-*.woff2`). Ninguno existe: el panel solo trae `geist.woff2` y `geist-mono.woff2` (`src/platform/http/fonts/`, los baja `scripts/fetchFonts.mjs`), y `readFont` en `src/platform/http/staticPanel.ts:19` los busca ahí. Resultado: hasta 10 requests 404 por visita y la landing se ve con la fuente de respaldo. Aunque existieran, 6 TTF son el asset más pesado de la página.
- **Capturas desactualizadas y con datos del piloto real**: las WebP muestran el panel viejo (bandeja/dashboard del agente de WhatsApp), no el panel React actual con la dirección «Banca privada». Verificado: `panel-dashboard-oscuro.webp` muestra "Panel · Lavacar Rosales" con sus métricas reales (conversaciones, citas, ingresos estimados en colones) y `panel-bandeja-claro.webp` un chat con número de teléfono y "Lavacar Rosales". El mockup de teléfono del hero también dice "Lavacar Rosales" (`landing/index.html:83`, `.telefono-titulo`).
- **Asset muerto**: `landing/assets/panel-dashboard-claro.webp` (35 KB) no lo referencia ningún HTML ni CSS (`grep -rn dashboard-claro landing/ src/` = 0), pero se sirve igual por `/landing/*`.
- Las capturas son 1600×960 y 800×1000 sin `srcset`/`sizes`: en un teléfono se baja la versión de escritorio (35 KB, aceptable, pero mejorable con una variante de ~800 px).

## Objetivo
Que la landing no pida ningún asset inexistente, use fuentes WOFF2 livianas (o las del sistema) y muestre capturas del producto actual, optimizadas por ancho de pantalla.

## Alcance
- Reemplazar los `@font-face` de la landing por WOFF2 existentes (las Geist ya servidas, o las que decida el usuario, solo subset latin) o por la pila de fuentes del sistema; borrar las declaraciones a archivos inexistentes.
- Capturas nuevas del panel actual con datos ficticios del seed (PGlite), en WebP, con variante móvil y `srcset`/`sizes`; objetivo < 60 KB la de escritorio y < 30 KB la móvil. Borrar las viejas (incluida `panel-dashboard-claro.webp`, sin uso) y cambiar el nombre del negocio del mockup del hero (`index.html:83`) por uno ficticio.
- Test que recorra `estilos.css` y los `<img>`/`url()` de `landing/*.html` y verifique que cada asset referenciado existe (evita que vuelvan los 404).

## Fuera de alcance
- La imagen OG y el favicon → `og-y-favicon`.
- Cabeceras de caché y compresión → `cache`.
- Rendimiento general en redes lentas → `redes-lentas`; ver en varios tamaños → `multiples-dispositivos`.

## Pasos sugeridos
1. Levantá el server en dev y abrí `/` con la consola de red: confirmá los 404 de `/panel/fonts/*`.
2. Decidí la fuente con el usuario; ajustá `estilos.css` (las variables `--font-display`/`--font-body`).
3. Capturá el panel en PGlite (Playwright ya está en el repo: `playwright.config.ts`) a 2 anchos, exportá WebP y reemplazá las 4 imágenes (mismos nombres o actualizá `landing/index.html`).
4. Agregá `srcset`/`sizes` y el test de assets referenciados.

## Decisiones que el agente NO toma solo
- ¿Qué tipografía usa la landing: Geist (la del panel) o volver a Noto Sans/Inter (habría que bajarlas en WOFF2 con `fetchFonts.mjs`)?
- ¿Qué pantallas del panel nuevo se muestran en la landing?

## Criterios de aceptación
- [ ] Cargar `/` no genera ningún 404 (verificado en el navegador y por el test nuevo de assets referenciados).
- [ ] No queda ningún `.ttf` en la landing; las fuentes son WOFF2 o del sistema.
- [ ] Capturas nuevas del panel actual, sin datos reales, con `srcset`; pesos dentro del objetivo. `grep -rn "Rosales" landing/` = 0 y no queda ningún archivo en `landing/assets/` sin referenciar (el test nuevo lo cubre).
- [ ] `npm run typecheck` y `npm test` en verde.
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización").

## Reglas para este trabajo
- Rama propia `prod/optimizar-imagenes` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó (captura de la pestaña Red sin 404, pesos finales), y checklist de pasos humanos pendientes.
