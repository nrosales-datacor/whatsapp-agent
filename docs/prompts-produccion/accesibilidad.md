# Auditoría de accesibilidad automatizada y contraste verificado

> **Punto del checklist:** make it accessible · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P2 puede esperar
> **Tipo:** mixto · **Depende de:** nada · **Esfuerzo:** 1-2 días
> **Archivos principales:** `web/src/global.css`, `web/src/ui/`, `web/src/modules/scheduling/`, `web/src/modules/reports/charts.tsx`, `landing/*.html`, `test/e2e/`, `playwright.config.ts`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
**Base sólida ya construida (no rehacer):**
- `web/index.html:2` con `lang="es"` y viewport correcto (`:5`).
- Diálogos y drawer sobre `<dialog>` nativo con `showModal()` (`web/src/ui/Dialog.tsx`, `Drawer.tsx`): trampa de
  foco, Escape e `inert` del resto los da el navegador.
- Menú con teclado completo (flechas, Home/End, Escape devuelve el foco) en `web/src/ui/Menu.tsx`.
- Campos con `<label htmlFor>`, `aria-invalid` y `aria-describedby` hacia ayuda/error (`web/src/ui/Field.tsx`).
- "Saltar al contenido" (`.skip-link` en `web/src/app/layout/AppLayout.tsx`), `:focus-visible` global y
  `prefers-reduced-motion` en `web/src/global.css`.
- Avisos en región `aria-live` (`web/src/ui/Toast.tsx:44`), estados con `role="alert"`/`"status"`.
- Los E2E usan `getByRole` (~544 usos en `test/e2e/`), lo que ya obliga a roles y nombres accesibles.
- El color white-label se ajusta a contraste AA (`web/src/lib/branding.ts`, `accentFor`/`contrastRatio`).

**Lo que falta:**
1. **Ninguna auditoría automatizada** (axe/Lighthouse): no hay `@axe-core/*` en `package.json` ni en
   `web/package.json`, ni paso en CI. Nada impide regresiones.
2. **Contraste de la paleta nueva "Banca privada" (A10, ROADMAP Carril A) sin verificar**: neutrales cálidos,
   texto `muted`, chips y badges de estado en claro y oscuro (`global.css`). Solo el acento se calcula.
3. **Componentes de riesgo sin revisión:** la rejilla de la Agenda (`DayView.tsx`, `WeekView.tsx`,
   `agendaLayout.ts`: bloques posicionados en absoluto, ¿se navegan con teclado y se anuncian hora/estado?),
   los gráficos SVG de Reportes (`reports/charts.tsx`: ¿tienen alternativa textual/tabla?), la bandeja de
   WhatsApp (`ConversationList.tsx`, `ChatPane.tsx`: anuncio de mensajes nuevos).
4. **Landing pública** (`landing/index.html`, `privacidad.html`, `terminos.html`, `contrato.html`) sin auditar.
5. Hay `outline: none` en `.input:focus` (`global.css:244`), `.app-main:focus` (`:362`), `.page-title:focus`
   (`:449`) y `.menu-item:focus-visible` (`:315`, con fondo) (reemplazado por box-shadow o
   intencional por foco programático): verificar que el foco siga visible en tema oscuro.

## Objetivo
Llegar a WCAG 2.2 AA en el panel y la landing, con una prueba automatizada en CI que falle ante violaciones
serias y una revisión manual documentada de lo que axe no detecta.

## Alcance
- Auditoría axe en Playwright sobre las pantallas principales en `panel-mock` (login, Inicio, Agenda día/semana,
  Clientes y ficha, Ventas, Reportes, WhatsApp bandeja/chat, Configuración, un diálogo abierto) en tema claro y
  oscuro, y sobre la landing en el proyecto `server`. Falla con impacto `serious`/`critical`.
- Corregir lo que salga (contraste de tokens, nombres accesibles, landmarks, encabezados).
- Agenda: cada cita como elemento enfocable con nombre "09:00–10:00, Ana Pérez, Corte, Confirmada"; orden de
  tabulación cronológico.
- Reportes: tabla accesible (puede ser `visually-hidden`) o `aria-describedby` con el resumen de cada gráfico.
- Revisión manual con lector de pantalla (NVDA o VoiceOver) de 3 flujos: login, agendar cita, responder chat;
  anotar resultado en `TESTING.md`.

## Fuera de alcance
- Pruebas en dispositivos y navegadores → `multiples-dispositivos`.
- Rediseño visual: solo se tocan tokens donde no cumplen contraste.
- SEO de la landing → `seo-aeo`.

## Pasos sugeridos
1. Proponer al usuario la dependencia `@axe-core/playwright` (Deque) verificando la política: `npm view
   @axe-core/playwright time --json`, versión con más de un mes, versión exacta en `devDependencies`.
   Alternativa sin dependencia: inyectar `axe-core` desde `node_modules` si ya estuviera; si no se aprueba,
   hacer un checker mínimo de contraste sobre los tokens de `global.css` en `test/unit`.
2. Crear `test/e2e/a11y.panel.spec.ts` y `test/e2e/a11y.smoke.spec.ts` (ojo con los `testMatch` de
   `playwright.config.ts`: `panel.spec.ts$` y `smoke.spec.ts$`).
3. Test unitario que recorra los pares texto/fondo de los tokens (claro y oscuro) con `contrastRatio`.
4. Corregir violaciones; revisar Agenda, gráficos y bandeja.
5. Revisión manual con lector de pantalla; documentar.

## Decisiones que el agente NO toma solo
- ¿Se aprueba sumar `@axe-core/playwright` como devDependency (cumple la política: Deque, muy usado)?
- Meta de cumplimiento: ¿WCAG 2.2 AA completo o "sin violaciones serias de axe" para el lanzamiento?
- Si un token de la paleta "Banca privada" no da contraste, ¿se oscurece (cambia la estética aprobada)?

## Criterios de aceptación
- [ ] Spec de accesibilidad en E2E que recorre ≥ 10 pantallas en claro y oscuro con 0 violaciones
      `serious`/`critical`, corriendo en el job `e2e` de CI.
- [ ] Test unitario de contraste de tokens ≥ 4.5:1 (texto normal) y ≥ 3:1 (texto grande/íconos de estado).
- [ ] Las citas de la Agenda se alcanzan con Tab y tienen nombre accesible completo (E2E con `getByRole`).
- [ ] Gráficos de Reportes con alternativa textual verificable.
- [ ] Resultado de la revisión manual con lector de pantalla anotado en `TESTING.md`.
- [ ] `npm run typecheck`, `npm run typecheck --prefix web`, `npm test` y `npm run test:e2e` en verde.
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización").

## Reglas para este trabajo
- Rama propia `prod/accesibilidad` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, violaciones encontradas y corregidas (antes/después), tokens modificados, y pasos humanos
pendientes (revisión con lector de pantalla si no se pudo hacer, aprobación de cambios de color).
