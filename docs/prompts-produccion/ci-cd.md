# Pipeline de deploy para el stack nuevo (Selyon CRM)

> **Punto del checklist:** add CI/CD · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P0 antes del primer cliente que pague
> **Tipo:** mixto · **Depende de:** staging, dominio-y-ssl, smoke-tests · **Esfuerzo:** 1-2 días
> **Archivos principales:** `.github/workflows/ci-cd.yml`, `ecosystem.config.cjs`, `scripts/migrate.ts`, `DEPLOY.md`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
- La parte de **CI** está completa: job `verify` (`ci-cd.yml:20`) corre `ci:versions`, `ci:env`, `npm ci`, typecheck, `npm test`, `db:check` y typecheck + build del panel; job `e2e` corre Playwright (proyectos `server` y `panel-mock` de `playwright.config.ts`) sobre PGlite. Corre en push a cualquier rama y en PR a `main` (`ci-cd.yml:4-7`).
- La parte de **CD** apunta todavía al sistema VIEJO: el job `deploy` (`ci-cd.yml:86`) sale de un push a `main` y usa por defecto `DEPLOY_HOST` = el droplet actual, `DEPLOY_DIR` = `~/lavacar-whatsapp-bot` y `BASE_URL` = `https://wabotlavacar.selyon.app` (`ci-cd.yml:101-104`). Ahí corre el código viejo de `main` contra el Supabase viejo.
- Consecuencia: **mergear el stack (#2→último PR abierto) a `main` despliega el código nuevo sobre el droplet y la base del piloto**. `scripts/migrate.ts` aplicaría `drizzle/0000_platform_base.sql`…`0009_billing_signup.sql` contra la base vieja (otra historia de migraciones en `drizzle.__drizzle_migrations`), con un `.env` que usa nombres de variables viejos (p. ej. `DATABASE_URL_MIGRACIONES` en vez de `DATABASE_URL_MIGRATIONS`).
- `ecosystem.config.cjs` define la app PM2 `selyon-crm`, mientras que en el droplet corre `whatsapp-bot` (DEPLOY.md, tabla "Mantenimiento rápido"): `pm2 startOrReload` (`ci-cd.yml:178`) levantaría un SEGUNDO proceso en el mismo `PORT` en vez de recargar.
- `DEPLOY.md` está desactualizado frente al código nuevo: nombra `migrar.ts`, `seedTenants.ts`, `/salud`, `verificar:produccion` (ninguno existe en `scripts/` ni en `package.json`); el server nuevo expone `/health` (`src/app.ts`, ruta `/health`).
- No hay `npm audit` en el pipeline (lo cubre `auditoria-de-dependencias`).

## Objetivo
Que el pipeline despliegue el código nuevo a SU propio entorno (staging y luego producción nueva, contra el Supabase nuevo) y que sea imposible que un merge a `main` toque el droplet/base del sistema viejo por accidente.

## Alcance
- Parametrizar el job `deploy` por entorno con `environment:` de GitHub (`staging`, `produccion`), sin defaults hardcodeados: si falta `vars.DEPLOY_HOST`/`DEPLOY_DIR`/`BASE_URL` del entorno, el job falla con un mensaje claro.
- Environment `staging` en `ci-cd.yml` (este prompt es su dueño; `staging` solo prepara el entorno). Disparadores: push a `main` → staging automático; producción solo con aprobación (environment con required reviewers) o tag `v*`. Decidirlo con el usuario.
- Guardia en el script remoto: antes de migrar, verificar que la base de destino NO tiene tablas `wa_*` (base vieja) y abortar si las tiene.
- Alinear nombre del proceso PM2 (`selyon-crm`) y puerto con el entorno; documentar el primer `pm2 start ecosystem.config.cjs && pm2 save`.
- Reescribir la sección 15 de `DEPLOY.md` (CI/CD) para el stack nuevo; mover lo del droplet viejo a un anexo "sistema viejo (congelado)".

## Fuera de alcance
- Rollback (salvo quitar sus defaults del droplet viejo, que se hace acá) y plan de corte del sistema viejo → `rollback`.
- Crear el entorno de staging y su base → `staging`.
- DNS, TLS y proxy → `dominio-y-ssl`.
- `npm audit` en CI → `auditoria-de-dependencias`. El script de smoke post-deploy (`scripts/ci/smoke.sh`) ya lo dejó `smoke-tests` y los chequeos TLS los sumó `dominio-y-ssl`: llamalo en cada entorno, no lo reescribas.

## Pasos sugeridos
1. Leer `ci-cd.yml` completo y la §15 de `DEPLOY.md`.
2. Partir `deploy` en un job reutilizable (`workflow_call` o matriz) con `environment: ${{ inputs.env }}` y variables por entorno.
3. Quitar los fallbacks hardcodeados (IP del droplet, usuario Unix, carpeta y URL viejos) de `deploy` y `rollback`; agregar un paso "validar variables" que falle si faltan.
4. Agregar al script remoto un chequeo SQL con `psql "$DATABASE_URL_MIGRATIONS"` (o un `scripts/assertTargetDb.ts` con test sobre PGlite) que aborte si existe `wa_tenants` o si la base no es la esperada.
5. Actualizar `DEPLOY.md` y `.env.example` si aparecen variables nuevas (`npm run ci:env` debe seguir en verde).
6. Probar el workflow con `act` o en una rama con `workflow_dispatch` contra staging SOLO con el OK del usuario.

## Decisiones que el agente NO toma solo
- ¿Dónde corre el stack nuevo: el mismo droplet (otro usuario Unix, otra carpeta, otro puerto) o un droplet nuevo? (AUDIT-v2 V2-22 recomienda no compartir).
- ¿Producción se dispara por aprobación manual tras staging o por tag de release?
- ¿Cuándo se mergea el stack a `main` y qué pasa con el job que hoy despliega el sistema viejo (congelarlo en una rama `legacy-prod`)?

## Criterios de aceptación
- [ ] `ci-cd.yml` no contiene host, usuario, carpeta ni URL del droplet viejo como default (`grep -nE "wabotlavacar|lavacar-whatsapp-bot|\|\| *'[0-9]+\." .github/workflows/ci-cd.yml` vacío).
- [ ] Un push a `main` despliega solo a `staging`; producción requiere aprobación o tag.
- [ ] El deploy aborta si la base de destino tiene tablas `wa_*` (test del script de guardia sobre PGlite).
- [ ] `DEPLOY.md` §15 describe el pipeline nuevo, sin referencias a `migrar.ts`, `seedTenants.ts` ni `/salud`.
- [ ] `npm run typecheck` y `npm test` en verde (y en web/ si toca el panel)
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización")

## Reglas para este trabajo
- Rama propia `prod/ci-cd` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist de pasos humanos pendientes (crear environments y variables en GitHub, llave SSH del nuevo destino, `DEPLOY_HOST_KEY`).
