# Entorno de staging para el stack nuevo

> **Punto del checklist:** create a staging environment · **Estado en `5f976e1`:** ❌ falta · **Prioridad:** P0 antes del primer cliente que pague
> **Tipo:** mixto · **Depende de:** rotar-llaves · **Esfuerzo:** 1 día
> **Archivos principales:** `.github/workflows/ci-cd.yml`, `ecosystem.config.cjs`, `scripts/seedDev.ts`, `scripts/migrate.ts`, `.env.example`, `DEPLOY.md`, `PLAN-GESTION.md` (§ I0, fila "Vos")

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
- Dev y tests corren sobre PGlite en el proceso (`playwright.config.ts` arranca el server con `DATABASE_URL: ""`; `npm test` también). Eso cubre la lógica, no la infraestructura real (Supabase pooler, SSL, rol `app_runtime` con login, Storage, Meta, Resend, Stripe en modo test).
- `PLAN-GESTION.md` (tabla de I0, fila "Vos") pide crear "el proyecto nuevo de Supabase y el rol de la app (para staging)". No hay evidencia en el repo de que exista: ni variables de entorno de staging, ni environment en `ci-cd.yml`, ni URL, ni sección en `DEPLOY.md`.
- El código nuevo **nunca se desplegó en ningún lado**: el único destino del pipeline es el droplet de producción viejo (`ci-cd.yml:101-104`).
- `scripts/seedDev.ts` existe para poblar datos de demo; `scripts/rls/01-app-role.sql` da login al rol `app_runtime` (paso manual).
- Faltan para probar de verdad: número de prueba de Meta (WhatsApp Cloud API test number) apuntado a staging, claves de Stripe en modo test, dominio de correo de prueba, bucket de Storage propio.
- Guardas: el server no distingue "staging" de "production" (`NODE_ENV=production` en `ecosystem.config.cjs`); no hay indicador visual en el panel de que es staging, ni bloqueo de envíos reales (campañas por WhatsApp, correos) a clientes de verdad.

## Objetivo
Un entorno de staging permanente, idéntico en forma a producción (mismo pipeline, mismo proceso, Supabase propio con RLS activo), donde cada merge a `main` se despliega y se prueba antes de promover a producción.

## Alcance
- Variable `APP_ENV` (`development` | `staging` | `production`; este prompt es su dueño, los demás la leen) leída en `src/platform/config`, documentada en `.env.example`; en staging: banner en el panel (vía `/api/panel/me` o un endpoint de config existente, respetando la costura), `robots: noindex`, y Sentry con `environment`.
- Guardia: en `APP_ENV=staging`, los envíos salientes (WhatsApp de campañas, correos) solo a una allowlist (`STAGING_ALLOWED_PHONES`, `STAGING_ALLOWED_EMAILS`) — con tests.
- Sección en `DEPLOY.md`: alta de staging (Supabase, rol `app_runtime` con `scripts/rls/01-app-role.sql`, `.env`, PM2, subdominio), seed con `seed:dev` y cómo resetearlo.

## Fuera de alcance
- Pipeline por entorno, incluido el environment `staging` en `ci-cd.yml` (push a `main` → staging) → `ci-cd`. DNS/TLS del subdominio → `dominio-y-ssl`. Backups de staging (no necesarios) → `backups`.

## Pasos sugeridos
1. Leer `src/platform/config/*`, `src/platform/observability/sentry.ts`, `src/platform/email/*` y el envío de WhatsApp en `src/modules/whatsapp/`.
2. Agregar `APP_ENV` y la función pura `isOutboundAllowed(env, destination)`; usarla en el despachador de correo y de WhatsApp saliente sin cruzar fronteras de módulos (inyectarla desde la plataforma).
3. Tests unitarios de la allowlist y del banner.
4. Documentar el alta en DEPLOY.md y el checklist humano.

## Decisiones que el agente NO toma solo
- ¿Staging en el mismo droplet (otro usuario/puerto) o en uno aparte? Costo.
- ¿Plan del Supabase de staging (Free alcanza) y si es el "Supabase nuevo" ya creado o uno más?
- ¿Número de prueba de Meta para staging y qué negocio demo lo usa?
- ¿Subdominio (p. ej. `staging.<dominio>`)?

## Criterios de aceptación
- [ ] Con `APP_ENV=staging`, un correo o WhatsApp a un destino fuera de la allowlist no sale (test).
- [ ] El panel muestra un aviso de staging cuando `APP_ENV=staging` (test o E2E del panel en modo mock).
- [ ] DEPLOY.md describe el alta y reseteo de staging; `.env.example` documenta las variables nuevas (`npm run ci:env` en verde).
- [ ] `npm run typecheck` y `npm test` en verde (y en web/ si toca el panel)
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización")

## Reglas para este trabajo
- Rama propia `prod/staging` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist de pasos humanos pendientes (crear Supabase/rol, `.env` de staging, número de prueba de Meta, Stripe test, DNS).
