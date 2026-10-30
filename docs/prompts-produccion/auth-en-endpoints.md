# Inventario de rutas con auth candado y superadmin con 2FA obligatorio

> **Punto del checklist:** check auth on every endpoint · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P0 antes del primer cliente que pague
> **Tipo:** código · **Depende de:** nada · **Esfuerzo:** 1–1,5 días
> **Archivos principales:** `src/platform/http/router.ts`, `src/routes.ts`, `src/admin/session.ts`, `src/platform/config/requiredSecrets.ts`, `src/modules/team/routes.ts`, `src/modules/team/identity.ts`, `test/security/`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
Lo que YA está bien (no rehacer):
- Router declarativo: `route()` (`src/platform/http/router.ts:142`) exige `auth` ∈ `AUTH_MODES` (`router.ts:62`, chequeo en `:155`) y `createRouter` (`:316`) aplica en orden CSRF de mismo origen → sesión (401) → rol (403 `forbidden_role`) → módulo del plan (403) → sucursal (403 `location_forbidden`) (bloque `if (r.auth === "user")`, `:426`). Sin resolver de sesión/gate, falla cerrado (tests "router: defaults seguros" en `test/unit/router.test.ts`).
- Fuera del router, `src/app.ts` solo atiende `/health` (detalle con `HEALTH_DETAIL_TOKEN` en tiempo constante, `src/platform/http/health.ts`), el webhook de WhatsApp firmado con HMAC (`src/modules/whatsapp/webhook.ts`, `timingSafeEqual`), el de Stripe firmado (`isValidStripeSignature` en `src/modules/billing/stripeWebhook.ts`), y estáticos. Cualquier otro `/api/*` → 404.
- Rutas `auth: "public"` reales (13): `/ping` (`systemRoutes.ts`), `/auth/login|logout|password/forgot|password/reset|verify-email|verify-email/resend|invitations/:token|invitations/accept` (`src/modules/team/routes.ts:96-171`), `/auth/signup/config` y `/auth/signup` (`src/signup.ts:151-153`), `/admin/login|logout` (`src/admin/routes.ts:86-93`). Todas son legítimas.
- Acceso fino en handlers: rol `staff` solo sus citas (`accessibleAppointment`/`ownStaffId` en `src/modules/scheduling/routes.ts`), sucursales vía `visibleLocations`, RLS por negocio (`test/security/identity.test.ts` "RLS: con la sesión de un negocio…").

Lo que falta:
1. **No hay test que congele el inventario de acceso.** Nada falla si mañana alguien agrega `auth: "public"` a una ruta nueva o le quita `roles` a una ruta de escritura sensible. `test/unit/router.test.ts` prueba el mecanismo con rutas de juguete, no las rutas reales que compone `src/routes.ts`.
2. **Superadmin con 2FA opcional en producción.** `adminLogin` (`src/admin/session.ts:56`) solo pide código si existe `PANEL_SUPERADMIN_TOTP_SECRET` (`:78`); `productionSecretProblems`/`productionConfigWarnings` (`src/platform/config/requiredSecrets.ts:20/35`) no lo exigen. El superadmin crea negocios, cambia planes y pausa cuentas de todos los clientes. (Ya listado en ROADMAP H12: "superadmin compartido… con 2FA opcional".)
3. **El logout no revoca la sesión.** `POST /auth/logout` (`src/modules/team/routes.ts:110`) es `public` y solo llama `clearSessionCookie`: una cookie copiada (XSS, equipo compartido, extensión) sigue valiendo hasta 7 días (`SESSION_MAX_AGE_SEC`, `src/platform/auth/sessionToken.ts:42`). Existe `bumpSessionEpoch` (`src/modules/team/identity.ts:100`) pero hoy solo lo usan cambio/reset de clave y `updateMember` (`src/modules/team/members.ts:249`); no hay ruta "cerrar sesión en todos los dispositivos". (Pista V2-48, vigente.)

## Objetivo
Que agregar o aflojar el acceso de una ruta sea un cambio explícito y revisado (falla un test), y que en producción el superadmin no pueda entrar sin segundo factor.

## Alcance
- Test nuevo `test/security/routeInventory.test.ts` que arma las rutas reales (la misma composición de `src/routes.ts`, con dependencias dobles como en otros tests de seguridad) y:
  - compara el conjunto `{método ruta}` con `auth: "public"` contra una allowlist literal en el test (las 13 de arriba);
  - compara contra un snapshot literal `método ruta → auth / roles / module / location` de TODAS las rutas (tabla en el test, ordenada), para que cualquier cambio de acceso aparezca en el diff;
  - verifica que toda ruta `superadmin` empieza con `/admin/` y que ninguna ruta `user` empieza con `/admin/`.
- Test de humo por ruta: para cada ruta `auth: "user"` sin sesión → 401; para cada `superadmin` con sesión de equipo → 401 (iterando el inventario, sin escribir uno por uno).
- `productionSecretProblems`: en `NODE_ENV=production` con superadmin configurado y sin `PANEL_SUPERADMIN_TOTP_SECRET` (o con uno inválido), problema que frena el arranque. Actualizar `.env.example` y `npm run ci:env` si corresponde.
- Logout que revoca: si la request trae una sesión válida, `POST /auth/logout` sube el epoch con `bumpSessionEpoch` (o, según la decisión de abajo, una ruta aparte `POST /auth/sessions/revoke` "cerrar sesión en todos lados" con botón en Configuración › Mi cuenta). Test: la cookie copiada antes del logout → 401 después.

## Fuera de alcance
- Cuentas de superadmin por persona (tabla, alta, auditoría por persona): decisión de producto (ver abajo); si se aprueba, es un ítem nuevo.
- Rate limiting general de la API → `rate-limiting`.
- Rotación de `PANEL_SESSION_SECRET`/claves → `rotar-llaves`.
- Rechazar en producción el placeholder público de `PANEL_SESSION_SECRET` (`.env.example:152`) → `secretos-fuera-del-repo`.

## Pasos sugeridos
1. Leé `src/routes.ts` y cómo `test/security/identity.test.ts` / `test/helpers/panelClient.ts` levantan la app; reutilizá esa composición para obtener `Route[]`.
2. Escribí el inventario: generalo una vez con un script local, pegalo como literal en el test y revisá a mano cada fila (`roles` ausente en rutas de escritura: confirmá que el handler filtra por `staff`/sucursal).
3. Test de 401 iterando el inventario (sin sesión; con cookie de equipo contra `/admin/*`).
4. Exigí el TOTP del superadmin en `productionSecretProblems` + test unitario del caso.
5. Actualizá DEPLOY.md §14 (superadmin) diciendo que el TOTP es obligatorio y cómo generarlo (`scripts/generateTotp.ts`).

## Decisiones que el agente NO toma solo
- ¿El droplet de producción ya tiene `PANEL_SUPERADMIN_TOTP_SECRET`? Si no, el próximo deploy no arrancaría: el usuario tiene que cargarlo antes de mergear.
- ¿Cuentas de superadmin por persona ahora o más adelante?
- Logout: ¿cierra TODAS las sesiones de la persona (simple, pero saca también el celular) o solo la actual + botón aparte "cerrar en todos lados"? La segunda requiere un id de sesión revocable (más trabajo).

## Criterios de aceptación
- [ ] `test/security/routeInventory.test.ts` falla si se agrega una ruta pública, se cambia `auth`, `roles`, `module` o `location` de cualquier ruta sin actualizar el snapshot.
- [ ] Toda ruta `user`/`superadmin` responde 401 sin la sesión correcta (test iterado).
- [ ] Con `NODE_ENV=production` y sin TOTP del superadmin, `productionSecretProblems` lo reporta (test).
- [ ] Test: una cookie de equipo guardada antes del logout (o de "cerrar en todos lados") responde 401 en `GET /api/panel/auth/me` después.
- [ ] `npm run typecheck` y `npm test` en verde.
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización").

## Reglas para este trabajo
- Rama propia `prod/auth-en-endpoints` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist de pasos humanos pendientes (cargar el TOTP del superadmin en producción antes del deploy).
