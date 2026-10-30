# Smoke tests que de verdad prueben el sistema

> **Punto del checklist:** add smoke tests · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P0 antes del primer cliente que pague
> **Tipo:** mixto · **Depende de:** nada · **Esfuerzo:** 3-5 horas
> **Archivos principales:** `test/e2e/smoke.spec.ts`, `.github/workflows/ci-cd.yml`, `DEPLOY.md`, `TESTING.md`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
Hay dos capas de smoke y las dos quedaron apuntando a una API que ya no existe:

- **Smoke E2E en CI** (`test/e2e/smoke.spec.ts`, proyecto `server` de `playwright.config.ts`): 4 tests. El
  segundo (`"la API responde JSON aunque todavía no tenga rutas (404 { ok: false })"`) pide `GET /api/panel/me`
  y **espera 404**. Esa ruta no existe: la sesión vive en `GET /api/panel/auth/me`
  (`src/modules/team/routes.ts:115`, `route({ method: "GET", path: "/auth/me", auth: "user" })`; login en
  `:96`). `/api/panel/*` entra al router (`src/app.ts:112`, `createAppHandler` → `panelApiHandler`) y el test
  pasa porque `findRoute` no encuentra la ruta y el router lanza `HttpError(404, …, "not_found")`
  (`src/platform/http/router.ts:518`), **antes** de sesión, CSRF y base: prueba que el router está montado,
  pero **no detecta** si la sesión, el login o la base están rotos. Comentario del archivo y del job `e2e`
  (`ci-cd.yml:81-82`): "El E2E completo del panel se rehace en I0.7" (desactualizado).
- **Smoke post-deploy** (`.github/workflows/ci-cd.yml:196`, job `deploy`, paso "Smoke post-deploy (panel + API)"):
  acepta `401` **o `404`** de `/api/panel/me` (`ci-cd.yml:211-213`). Con la ruta inexistente siempre da 404
  JSON → el paso siempre pasa. El rollback (job `rollback`, `ci-cd.yml:240`, verificación en `:315`) solo mira
  `/health`.
- `TESTING.md` §9 (`TESTING.md:251-260`) describe un smoke con `/api/panel/me → 401` y `/api/panel/login` con credenciales falsas →
  401 que **ya no está** en el workflow (texto heredado de la versión vieja, rutas `/salud`, job `desplegar`).
- `DEPLOY.md` (sección de verificación, ~línea 719) manda a correr `scripts/verificarProduccion.ts`, que **no
  existe** en `scripts/` (hay `backupDb.ts`, `migrate.ts`, `verifyRestore.ts`, etc.).
- Lo que sí sirve: `/health` hace ping a la base (`serveHealth`), y el smoke verifica que `/panel` entregue
  `#root`. Todos los E2E del panel (`test/e2e/*.panel.spec.ts`) corren contra la API **simulada**
  (`web/src/lib/mockApi.ts`), no contra el server real: no hay ningún flujo login→dato real en E2E.

## Objetivo
Que el smoke de CI y el post-deploy fallen si el router de la API, la sesión, el login o la base se rompen,
sin usar credenciales reales en producción.

## Alcance
- `test/e2e/smoke.spec.ts`: reemplazar el test de `/api/panel/me` por:
  - `GET /api/panel/auth/me` sin cookie → **401** JSON `{ ok: false, code: "unauthorized" }`.
  - `POST /api/panel/auth/login` con `Origin` del host y credenciales inexistentes → **401**
    `invalid_credentials` (prueba router + CSRF + Zod + base; un 500 delata la base).
  - Un login **real** contra la base efímera: sembrar un usuario con el seed de dev (`scripts/seedDev.ts` /
    `test/helpers/identityFixtures.ts`) en el arranque del webServer de Playwright, loguearse por la UI del
    panel real (no el mock) y ver el Inicio. Es el único E2E de punta a punta contra el backend.
  - Una ruta desconocida bajo `/api/panel/` → 404 JSON (lo que hoy prueba el test viejo, con su nombre real).
- `.github/workflows/ci-cd.yml`: en el smoke post-deploy y en el job `rollback`, usar `/api/panel/auth/me`
  (exigir **401**, no 404) y sumar el `POST /api/panel/auth/login` falso → 401. Que el rollback corra el mismo
  smoke que el deploy (hoy solo `/health`), extrayendo el smoke a `scripts/ci/smoke.sh <BASE_URL>`. Este prompt es el
  dueño único del script: `dominio-y-ssl` le suma chequeos TLS y `rollback`/`ci-cd` lo reutilizan.
- `DEPLOY.md` y `TESTING.md` §9: quitar `verificarProduccion.ts` o reemplazarlo por el script nuevo; corregir
  rutas (`/health`, `deploy`).

## Fuera de alcance
- Monitoreo continuo de disponibilidad → `uptime`. Alertas → `alertas`.
- Correr el smoke en cada entorno (staging/producción) y rediseño del pipeline → `ci-cd`. Chequeos TLS/HSTS en el script → `dominio-y-ssl`.
- Cobertura E2E completa contra el backend real: ítem aparte (anotalo en el ROADMAP).

## Pasos sugeridos
1. Leer `src/modules/team/routes.ts` (login/me) y `src/platform/http/router.ts` (CSRF por `Origin`,
   comentario "2) CSRF", ~l. 394) para armar los requests correctos.
2. Ver cómo arranca el server en modo test (`playwright.config.ts:40-48`, `webServer[0]`: `npx tsx
   src/server.ts` con `DATABASE_URL: ""` → PGlite **en memoria**, `startLocalDb` en
   `src/platform/db/client.ts:54`). Ojo: PGlite es de un solo proceso, así que `scripts/seedDev.ts` no puede
   sembrar el server ya levantado. Opciones: correr el seed antes con `PGLITE_DIR` en una carpeta temporal y
   arrancar el server con el mismo `PGLITE_DIR`, o un arranque de test que siembre en el proceso. El seed se
   niega a correr con `NODE_ENV=production`; no tocar código de producción para esto.
3. Reescribir `smoke.spec.ts`; correr `npm run web:build && npx playwright test --project=server`.
4. Extraer el smoke post-deploy a `scripts/ci/smoke.sh <BASE_URL>` y usarlo en `deploy` y `rollback`.
5. Probar el script a mano contra el server local (`npm run dev` sobre PGlite), nunca contra producción.
6. Actualizar docs y ROADMAP.

## Decisiones que el agente NO toma solo
- ¿El login falso contra producción en cada deploy es aceptable? Suma un intento fallido al rate-limit de la IP
  del runner y puede quedar en logs/alertas de seguridad.
- ¿Se quiere un usuario de smoke real en producción (solo lectura) para probar login exitoso post-deploy, o
  basta con el 401? Implica una credencial más que guardar en secretos de GitHub.

## Criterios de aceptación
- [ ] `smoke.spec.ts` no referencia `/api/panel/me`; `npx playwright test --project=server` verde.
- [ ] Romper a propósito el router (p. ej. que `/auth/me` devuelva 500) hace fallar el smoke local.
- [ ] Hay al menos un test E2E que se loguea contra el server real (PGlite) y ve el Inicio.
- [ ] El paso post-deploy exige 401 en `/api/panel/auth/me` (no acepta 404) y el rollback corre el mismo smoke.
- [ ] `DEPLOY.md` no menciona scripts inexistentes; `TESTING.md` §9 describe lo que hace el workflow.
- [ ] `npm run typecheck` y `npm test` en verde.
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización").

## Reglas para este trabajo
- Rama propia `prod/smoke-tests` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó (salida de Playwright, prueba de rotura a propósito), y checklist de pasos
humanos pendientes (p. ej. confirmar el primer deploy con el smoke nuevo en la pestaña Actions).
