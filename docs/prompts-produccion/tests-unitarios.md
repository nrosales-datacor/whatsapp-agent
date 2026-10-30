# Tests unitarios de la lógica del panel y TESTING.md al día

> **Punto del checklist:** add unit tests · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P2 puede esperar
> **Tipo:** código · **Depende de:** nada · **Esfuerzo:** 1 día
> **Archivos principales:** `test/unit/`, `web/src/app/navigation.ts`, `web/src/lib/api.ts`, `web/src/lib/branding.ts`, `web/src/lib/plans.ts`, `TESTING.md`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
El backend está bien cubierto: `npm test` (script en `package.json`) corre `node:test` vía `tsx` sobre
`test/unit` (38 archivos, ~248 `test(`), `test/security` (24, ~186), `test/reliability` (32, ~251, sobre PGlite
con las migraciones reales) y `test/architecture/moduleBoundaries.test.ts` (3). CI lo corre en el job `verify`
(`.github/workflows/ci-cd.yml`, paso "Tests (unit, security, reliability; PGlite en el proceso)").
Las cantidades de arriba salen de contar `test(` en los archivos: la suite no se corrió al escribir este prompt.
Corré `npm ci` (lockfile, sin cambiar versiones) y anotá cantidad de tests y tiempo.

Lo que falta es la **lógica pura del panel**. Solo se testean desde `test/unit` (importando `../../web/src/...`):
`lib/money`, `modules/scheduling/agendaLayout`, `modules/settings/hoursDraft` y `modules/settings/zonedTime`
(`test/unit/agendaLayout.test.ts`, `currency.test.ts`, `panelSettings.test.ts`). Sin tests:
- `web/src/app/navigation.ts`: `accessFor(me, gate)` (~l. 171), `navItemsFor(me)` (~l. 187), `homePathFor(me)`, `terminologyOf` —
  deciden qué ve cada rol y plan en el menú (un bug muestra secciones a quien no corresponde; el backend
  igual rechaza, pero la UX se rompe).
- `web/src/lib/api.ts`: `apiRequest` (mapeo de sobres `{ ok:false }`, `fallbackCode` para 502/HTML de proxy,
  disparo de `onUnauthorized` y `onBusinessPaused`, excepción para `/auth/me`), `filenameFromDisposition`.
- `web/src/lib/branding.ts`: `contrastRatio` (~l. 54), `accentFor` (~l. 66, garantiza AA del color white-label),
  `safeLogoUrl` (~l. 117, filtra URLs de logo: relevante para XSS), `initials`, `documentTitle`.
- `web/src/lib/plans.ts`: `trialDaysLeft`, `atLimit`, `usageText`.
- `web/src/modules/*/format.ts` (clients, reports, sales): `phoneMatches`, `deltaText`, `compactCents`, etc.
Además `TESTING.md` está desactualizado: habla de `test/tenant/`, `test/e2e-webhook/`, `test/e2e-panel/`,
`booking/availability.ts`, `campaigns/segmentos.ts`, "56 casos" (`TESTING.md:39-44`, `:63`, `:82`, `:175`,
"Estructura propuesta" en `:273-304` con un script `test` y jobs `verificar`/`e2e-panel`/`desplegar` que ya no
existen), todo del código viejo.

## Objetivo
Cubrir con tests unitarios la lógica pura del panel que decide permisos de UI, errores, branding y planes, y
dejar `TESTING.md` describiendo la suite real.

## Alcance
- Tests nuevos en `test/unit/` (mismo patrón que `panelSettings.test.ts`: `node:test` + `node:assert/strict`,
  sin dependencias nuevas):
  - `panelNavigation.test.ts`: matriz rol × plan × módulos de `accessFor`/`navItemsFor`/`homePathFor`.
  - `panelApi.client.test.ts` (nombre libre, sin chocar con `panelApi.test.ts` que es del server): `apiRequest`
    con `fetch` mockeado (`globalThis.fetch`) para 200 `{ok:true}`, 4xx con sobre, 502 con HTML, red caída
    (`TypeError`) → `network_error`, 401 → handler, `business_paused` en `/auth/me` vs. otra ruta.
  - `branding.test.ts`: `accentFor` siempre ≥ 4.5:1 contra superficie clara y oscura para una muestra de
    colores; `safeLogoUrl` rechaza `javascript:`, `data:` y acepta `https:`.
  - `plans.test.ts` y tests de los `format.ts` con casos borde (null, cero, negativos, zonas horarias).
- **Bloqueante verificado:** `web/src/lib/api.ts:22` evalúa `import.meta.env.VITE_MOCK_API` al cargar el
  módulo. Bajo `tsx` en Node `import.meta.env` es `undefined` → `TypeError` al importar, y el `tsconfig.json`
  raíz (`types: ["node"]`, incluye `test/**`, excluye `web`) no tipa `import.meta.env` (el tipo vive en
  `web/src/vite-env.d.ts`, que el tsconfig raíz no carga) → `npm run typecheck` falla. Hay que
  resolverlo antes de testear `api.ts`: p. ej. `import.meta.env?.VITE_MOCK_API` con un tipo mínimo, o mover
  `IS_MOCK_API`/`transport` a un módulo aparte e inyectar el transporte en `apiRequest` (`httpTransport`,
  `api.ts:164`; `transport`, `api.ts:181`). Sin cambiar el comportamiento del build de Vite.
- `navigation.ts`, `branding.ts`, `plans.ts` y `modules/*/format.ts` no importan `api.ts` (solo `contract`,
  `money`, tipos): se pueden importar ya desde `test/unit` sin ese arreglo.
- Reescribir `TESTING.md` a la estructura real (este prompt es el dueño de la reescritura completa; conservá las
  secciones que ya actualizaron `evals`, `tests-de-regresion`, `smoke-tests` (§9), `multiples-dispositivos` (§10) y `redes-lentas`): carpetas, qué cubre cada una, comandos, proyectos de
  Playwright, cuántos tests y cuánto tarda `npm test`.

## Fuera de alcance
- Smoke y E2E contra el server real → `smoke-tests`. Suites de regresión → `tests-de-regresion`.
- Evals del agente → `evals`. Accesibilidad automatizada → `accesibilidad`.

## Pasos sugeridos
1. `npm ci` (lockfile, sin cambiar versiones) y `npm test` para tener la línea base (cantidad y tiempo).
2. Leer `navigation.ts`, `api.ts`, `branding.ts`, `plans.ts` y los `format.ts`; listar las ramas.
3. Escribir los tests; si alguno destapa un bug, arreglarlo en el mismo commit con su caso.
4. Confirmar que `test/architecture/moduleBoundaries.test.ts` sigue verde (los tests importan de `web/src`).
5. Reescribir `TESTING.md` y actualizar ROADMAP.

## Decisiones que el agente NO toma solo
Ninguna (no hay dependencias nuevas ni costos). Si se propone vitest u otro runner para `web/`, eso sí se
consulta (política de dependencias).

## Criterios de aceptación
- [ ] Al menos 4 archivos nuevos en `test/unit/` cubriendo `navigation`, `api`, `branding` y `plans`.
- [ ] `safeLogoUrl("javascript:alert(1)")` y `data:` devuelven `null` con test explícito.
- [ ] `accentFor` cumple contraste ≥ 4.5:1 en ambos temas en el test.
- [ ] `TESTING.md` no menciona carpetas ni archivos inexistentes y anota cantidad de tests y tiempo.
- [ ] `npm run typecheck`, `npm run typecheck --prefix web` y `npm test` en verde.
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización").

## Reglas para este trabajo
- Rama propia `prod/tests-unitarios` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cantidad de tests antes/después y tiempo de `npm test`, bugs encontrados, y pasos humanos
pendientes (ninguno esperado).
