# Auditoría de dependencias en verde y en CI

> **Punto del checklist:** run a dependency audit · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P0 antes del primer cliente que pague
> **Tipo:** mixto · **Depende de:** nada · **Esfuerzo:** 3-4 h (más esperar las ventanas de +1 mes)
> **Archivos principales:** `package.json`, `package-lock.json`, `web/package.json`, `web/package-lock.json`, `.github/workflows/ci-cd.yml`, `scripts/ci/checkExactVersions.mjs`

## Contexto (verificado en `5f976e1`, 2026-10-28; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
- Lo que existe: versiones exactas en raíz y `web/` con guardrail `npm run ci:versions` (`scripts/ci/checkExactVersions.mjs`) en el job `verify`; acciones de GitHub fijadas por SHA. No hay `npm audit` en CI, ni Dependabot/Renovate (`.github/` solo tiene `workflows/`).
- `npm audit --omit=dev` en la raíz: **1 crítica, 1 alta**.
  - `zod@4.6.5` (dependencia directa de producción; el router valida los cuerpos con Zod): GHSA-mrhx-c7xc-m3w5, agotamiento de memoria con colecciones grandes. Arreglo en `4.6.6` (publicada 2026-10-11) / `4.6.7` (2026-10-12): **la política de +1 mes las habilita recién el 2026-11-11 / 2026-11-12**.
  - `shell-quote@1.10.0` (crítica, GHSA-pqg4-j6r4-53mv): entra por `gel`, peer opcional de `drizzle-orm` que el lockfile instala también sin devDependencies; la app usa `postgres`, no `gel`. `1.11.0` (publicada 2026-09-29T02:34Z, verificado con `npm view shell-quote time --json`) **ya cumple el mes hoy (2026-10-29)**: este arreglo se puede aplicar ya vía `overrides`.
- `npm audit` completo en la raíz: 6 (4 moderadas por `drizzle-kit` → `@esbuild-kit/*`/`esbuild`, solo dev).
- `web/`: `npm audit --omit=dev` = 0. Completo: 13 (7 altas, 1 moderada, 5 bajas), entre ellas `vite@6.4.3` (dev server: lectura fuera de `fs.allow`, ejecución cross-origin, `launch-editor`) y `source-map-js`. `vite@6.4.4` (2026-10-06) se habilita el 2026-11-06; `6.4.5` el 2026-11-21. Solo afectan al dev server, no al bundle servido.

## Objetivo
`npm audit --omit=dev` en 0 en raíz y web, las de desarrollo evaluadas y justificadas, y un job de CI que no deje entrar vulnerabilidades altas/críticas nuevas de producción.

## Alcance
- Job o paso `audit` en `ci-cd.yml`: `npm audit --omit=dev --audit-level=high` en raíz y `web/` (falla), y `npm audit` completo como informativo (no falla).
- Allowlist explícita y con vencimiento para avisos aceptados temporalmente (p. ej. `scripts/ci/auditAllowlist.json` con GHSA, motivo y fecha límite), leída por un script `scripts/ci/checkAudit.mjs` sin dependencias, con test.
- Subir versiones respetando la política, cada una verificada con `npm view <pkg> time --json`: `zod` a 4.6.6/4.6.7 cuando cumpla el mes; `shell-quote` vía `overrides` a `1.11.0` (o evitar instalar `gel`) cuando cumpla; `vite` en `web/` a la primera versión parcheada con +1 mes.
- Documentar en `CLAUDE.md`/`README.md` el procedimiento mensual de auditoría.

## Fuera de alcance
- Escaneo de secretos → `secretos-fuera-del-repo`. Límite de tamaño de cuerpos (mitiga el aviso de Zod): ya existe `maxBodyBytes` por ruta (`src/platform/http/routeTypes.ts`), no se toca acá.

## Pasos sugeridos
1. Correr `npm audit --omit=dev --json` y `npm audit --json` en raíz y `web/` para la foto del día.
2. Escribir `checkAudit.mjs` (lee el JSON de `npm audit`, filtra por severidad y allowlist vencida) con tests en `test/unit/`.
3. Agregar el paso al job `verify` y el script `ci:audit` en `package.json`.
4. Cargar en la allowlist los avisos con fix bloqueado por la política, con fecha límite = fecha en que la versión cumple el mes.
5. En o después de esas fechas, subir versiones exactas, `npm ci`, `npm run typecheck`, `npm test`, `npm run build --prefix web`.

## Decisiones que el agente NO toma solo
- ¿Se acepta esperar a 2026-11-11 para `zod` (manteniendo el aviso en la allowlist) o se hace excepción a la política de +1 mes por ser una vulnerabilidad alta en producción?
- ¿Se habilita Dependabot (solo alertas, sin PRs automáticos) en GitHub?

## Criterios de aceptación
- [ ] `npm run ci:audit` falla si aparece una alta/crítica de producción fuera de la allowlist, y si un ítem de la allowlist venció (tests).
- [ ] El job `verify` de `ci-cd.yml` corre la auditoría de raíz y `web/`.
- [ ] Tras las fechas de habilitación: `npm audit --omit=dev` = 0 en raíz y `web/`, versiones exactas (`npm run ci:versions` en verde).
- [ ] `npm run typecheck` y `npm test` en verde (y en web/ si toca el panel)
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización")

## Reglas para este trabajo
- Rama propia `prod/auditoria-de-dependencias` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist de pasos humanos pendientes (fechas en que hay que volver a subir versiones).
