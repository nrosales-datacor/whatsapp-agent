# Pantallas reales de 404, 500 y caída del panel

> **Punto del checklist:** build real 404, 500, empty, and loading states · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P1 antes de 5 clientes
> **Tipo:** código · **Depende de:** error-tracking (extiende su `AppErrorBoundary`) · **Esfuerzo:** 1 día
> **Archivos principales:** `web/src/main.tsx`, `web/src/app/App.tsx`, `src/app.ts`, `src/platform/net/http.ts`, `src/platform/http/staticPanel.ts`, `src/platform/http/landing.ts`, `landing/`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
**Lo que ya está bien (no rehacer):**
- Componentes de estado en `web/src/ui/`: `ErrorState` (`role="alert"`, texto tranquilizador y "Reintentar"),
  `EmptyState`, `FullPageStatus` (cargando/error antes de la sesión, `role="status"`/`"alert"`). Se usan en
  ~31 archivos de `web/src/modules` (`ErrorState`), ~19 (`EmptyState`) y ~56 manejan `isPending`.
- 404 dentro del panel: `web/src/app/NotFoundPage.tsx` (ruta `*` en `App.tsx:205`), y sub-rutas como `/admin/*`
  y `/sales/*` redirigen. La API devuelve 404 JSON `not_found` para `/api/*` desconocido (`src/app.ts`,
  `createAppHandler`).
- Mapeo de errores del cliente: `web/src/lib/api.ts`, `ERROR_MESSAGES` y `fallbackCode` (502 de proxy →
  `server_error` con texto en español).
- Botones de mutación deshabilitados mientras corren (`disabled={...isPending}` en ~84 lugares).

**Lo que falta:**
1. **No hay error boundary en el panel** (en `5f976e1`; `error-tracking`, que corre antes, agrega el de la raíz con reporte). Ni `ErrorBoundary`, ni `componentDidCatch`, ni `errorElement` en
   `web/src/` (el router es `<BrowserRouter>` en `main.tsx:48` + `<Routes>` en `App.tsx`, sin data router;
   el `<Outlet />` del layout está en `web/src/app/layout/AppLayout.tsx:58`). Una
   excepción de render en cualquier página deja la **pantalla en blanco** sin forma de recuperarse ni aviso a
   Sentry del front.
2. **404 público en texto plano.** `src/app.ts:129-130` (`createAppHandler`, final) responde `"Not found"`
   `text/plain` a cualquier ruta que no sea API, landing ni panel (p. ej. `/precios`, un link viejo o mal
   escrito desde WhatsApp). Igual `createWorkerHandler` (`app.ts:145-146`), `serveLanding`
   (`src/platform/http/landing.ts:103`) y `staticPanel.ts:105`.
3. **500 en texto plano.** `withSafetyNet` (`src/platform/net/http.ts:47-48`) responde `"Internal error"` en
   `text/plain` también a navegación HTML; si cae una página de la landing, el visitante ve eso.
4. **Panel sin build** → 503 texto plano (`staticPanel.ts:166-167`, "corré `npm run web:build`"): aceptable
   como error de operación, pero no debe filtrar la instrucción interna al público.
5. **Nadie prueba estos estados**: ningún E2E fuerza un error de API (500/red) ni una excepción de render.

## Objetivo
Que ningún error deje al usuario frente a una pantalla en blanco o un texto crudo: páginas 404/500 con la
marca, un error boundary en el panel con recuperación, y tests que lo demuestren.

## Alcance
- Panel: extender el `AppErrorBoundary` que dejó `error-tracking` (`web/src/app/AppErrorBoundary.tsx`, ya en la raíz y con
  reporte) para envolver también, por sección, el `<Outlet />` de `AppLayout` (que un fallo en Reportes no tumbe el menú). Muestra el mismo lenguaje de
  `ErrorState` + "Recargar" + "Ir al inicio"; se resetea al cambiar de ruta (`useLocation().key`). El reporte ya lo hace
  el componente de `error-tracking`: no lo dupliques.
- Server: helper `sendErrorPage(res, status, req)` que, si el request acepta `text/html`, sirve
  `landing/404.html` / `landing/500.html` estáticos (con estilos de la landing, sin JS, enlace a `/` y a
  `/panel`); si no, mantiene el texto/JSON actual. Usarlo en el final de `createAppHandler`, en
  `withSafetyNet` y en el 503 de `serveStaticPanel` (mensaje público genérico; el detalle va al log).
- `<title>` y `noindex` en las páginas de error.
- Tests: unit/integración del helper (HTML vs. texto según `Accept`), un test que fuerce un throw en el
  handler y verifique 500 HTML; E2E en `panel-mock` que fuerce una excepción de render (p. ej. ruta de
  prueba solo en modo mock o respuesta del mock malformada) y vea el boundary; E2E con `page.route` que
  devuelva 500 en una consulta y vea `ErrorState` + "Reintentar" funcionando.

## Fuera de alcance
- Integrar Sentry del front y el boundary de raíz → `error-tracking`. Logs → `logging`.
- Timeouts, reintentos y modo sin conexión → `redes-lentas`.
- SEO de la landing → `seo-aeo`; favicon → `og-y-favicon`.

## Pasos sugeridos
1. Leer `web/src/main.tsx`, `web/src/app/App.tsx`, `web/src/app/layout/AppLayout.tsx` y `web/src/ui/ErrorState.tsx`.
2. Extender `web/src/app/AppErrorBoundary.tsx` (de `error-tracking`); envolver el `Outlet` y resetear por ruta.
3. Crear `landing/404.html` y `landing/500.html` con el CSS existente de `landing/assets`.
4. Implementar `sendErrorPage` en `src/platform/http/` y reemplazar los `res.end("Not found")` /
   `"Internal error"` de navegación HTML.
5. Tests (unit + E2E) y ROADMAP.

## Decisiones que el agente NO toma solo
- Texto y tono de las páginas 404/500 públicas (marca "Selyon CRM" es nombre provisional): ¿lo aprueba el
  usuario o se usa un texto neutro?
- ¿La 500 muestra un correo/WhatsApp de soporte? ¿Cuál?

## Criterios de aceptación
- [ ] `curl -H "Accept: text/html" http://localhost:3000/no-existe` → 404 con HTML de marca; sin `Accept`
      HTML sigue respondiendo texto; `/api/x` sigue con 404 JSON.
- [ ] Un throw en un handler responde 500 HTML a navegación (test nuevo en `test/reliability` o `test/unit`).
- [ ] En el panel, una excepción de render muestra el boundary (E2E nuevo) y "Ir al inicio" recupera.
- [ ] E2E: una consulta con 500 muestra `ErrorState` y "Reintentar" la vuelve a pedir.
- [ ] `npm run typecheck`, `npm run typecheck --prefix web`, `npm test` y `npm run test:e2e` en verde.
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización").

## Reglas para este trabajo
- Rama propia `prod/estados-de-error-y-carga` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, capturas o descripción de las páginas 404/500 y del boundary, comandos de verificación, y
pasos humanos pendientes (aprobar textos, revisar en el celular).
