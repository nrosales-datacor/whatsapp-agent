# Pruebas en varios navegadores y dispositivos

> **Punto del checklist:** test it on multiple devices · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P1 antes de 5 clientes
> **Tipo:** mixto · **Depende de:** nada · **Esfuerzo:** 1 día de código + medio día de QA manual
> **Archivos principales:** `playwright.config.ts`, `test/e2e/*.panel.spec.ts`, `.github/workflows/ci-cd.yml`, `web/src/global.css`, `web/src/app/layout/BottomNav.tsx`, `TESTING.md`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
**Lo que hay:**
- Panel responsive: barra inferior móvil (`web/src/app/layout/BottomNav.tsx`), `@media` en `global.css` y en los
  CSS de cada módulo (clients 6, whatsapp 4, sales 2, resto 1), `viewport-fit=cover` en `web/index.html`.
- Tests E2E de "móvil (375 px) sin scroll horizontal" con `page.setViewportSize({ width: 375, height: 812 })`
  y `scrollWidth <= innerWidth` en 9 specs: `panel`, `agenda`, `clients`, `crm`, `growth`, `reports`,
  `billing`, `sales` y `whatsapp` (`test/e2e/*.panel.spec.ts` / `panel.spec.ts`). Todos contra la API simulada.

**Lo que falta:**
1. `playwright.config.ts:37-38` tiene solo dos proyectos (`server`, `panel-mock`) y **ambos son
   `devices["Desktop Chrome"]`**; el job `e2e` instala solo Chromium (`ci-cd.yml`, "Instalar el navegador"). No se prueba
   WebKit (Safari iOS/macOS: el navegador del dueño de negocio típico con iPhone) ni Firefox.
2. El "móvil" de los tests es Chromium de escritorio achicado: sin `isMobile`, sin `hasTouch`, sin
   `deviceScaleFactor`. No se ejercen gestos táctiles, el teclado virtual sobre diálogos, ni `100vh` en iOS.
3. Sin tablet (768–1024 px): el rango donde la barra lateral y la inferior se intercambian no se prueba.
4. Sin landscape del teléfono (Agenda semanal y bandeja de WhatsApp son las pantallas de más riesgo).
5. QA en dispositivo real pendiente: `TESTING.md` §10 (`TESTING.md:265-267`) deja sin marcar la entrega de push iOS/Android; la PWA
   (`vite-plugin-pwa`, `web/src/sw.ts`) instalada en iOS (requiere "Agregar a inicio") no está validada.
6. La landing (`landing/index.html`) no tiene ninguna prueba de ancho móvil.

## Objetivo
Que cada cambio del panel se pruebe automáticamente en Chromium, WebKit y Firefox, en móvil táctil y tablet,
y que exista una lista de QA manual en dispositivos reales firmada antes de vender.

## Alcance
- `playwright.config.ts`: sumar proyectos `panel-mock-webkit` (`devices["Desktop Safari"]`),
  `panel-mock-iphone` (`devices["iPhone 13"]`, WebKit con `isMobile`/`hasTouch`), `panel-mock-pixel`
  (`devices["Pixel 7"]`), `panel-mock-ipad` (`devices["iPad (gen 7)"]`) y Firefox de escritorio. Mantener
  `workers: 1` si el mock lo exige.
- Para no multiplicar el tiempo de CI: los proyectos móviles corren un subconjunto etiquetado (`@mobile`, con
  `grep`) — login, navegación por la barra inferior, Agenda día, nueva cita, ficha de cliente, chat de WhatsApp,
  cobro — y los tests de 375 px pasan a esos proyectos en vez de `setViewportSize` manual.
- Test de tablet (768 px y 1024 px): sin scroll horizontal y con la navegación correcta para el ancho.
- Smoke de la landing a 375 px sin scroll horizontal en el proyecto `server`.
- CI: `npx playwright install --with-deps chromium webkit firefox` en el job `e2e`.
- `TESTING.md` §10: checklist de QA manual en dispositivo real (iPhone Safari + PWA instalada, Android
  Chrome, iPad, un Android de gama baja) con fecha y responsable.

## Fuera de alcance
- Conexiones lentas o intermitentes → `redes-lentas`.
- Accesibilidad (lector de pantalla, contraste) → `accesibilidad`.
- Entrega real de push (depende de VAPID y del dominio): QA manual en staging, paso humano de la checklist de este prompt.

## Pasos sugeridos
1. Correr `npm run test:e2e` en Chromium para la línea base.
2. Agregar los proyectos; correr solo WebKit primero (`npx playwright test --project=panel-mock-iphone`) y
   arreglar lo que rompa (suele ser `<dialog>`, `position: sticky`, fechas con `Intl`, inputs `type=time`).
3. Etiquetar el subconjunto móvil y mover los tests de 375 px.
4. Ajustar CI y medir cuánto suma al job `e2e` (anotarlo).
5. Escribir la checklist manual en `TESTING.md`.

## Decisiones que el agente NO toma solo
- ¿Cuánto tiempo extra de CI se acepta? (3 motores × subconjunto móvil puede sumar varios minutos por push.)
- ¿Se paga un servicio de dispositivos reales (BrowserStack/LambdaTest) o el QA en dispositivo lo hace una
  persona del equipo con sus teléfonos? ¿Quién y con qué equipos?
- ¿Firefox es objetivo de soporte o basta con Chromium + WebKit?

## Criterios de aceptación
- [ ] `npx playwright test --list` muestra proyectos para Chromium, WebKit (escritorio e iPhone), Android y
      tablet; todos verdes localmente.
- [ ] Ningún test usa `setViewportSize(375…)` a mano: el móvil sale de `devices[...]` con `hasTouch`.
- [ ] Test de tablet y de landing móvil sin scroll horizontal.
- [ ] El job `e2e` de CI instala y corre WebKit.
- [ ] `TESTING.md` tiene la checklist de QA en dispositivo real (puede quedar sin firmar: es paso humano).
- [ ] `npm run typecheck`, `npm test` y `npm run test:e2e` en verde.
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización").

## Reglas para este trabajo
- Rama propia `prod/multiples-dispositivos` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, bugs encontrados por motor, tiempo del job `e2e` antes/después, y la checklist de QA en
dispositivo real que queda para una persona.
