# Restore probado de punta a punta

> **Punto del checklist:** actually test a restore · **Estado en `5f976e1`:** ❌ falta · **Prioridad:** P0 antes del primer cliente que pague
> **Tipo:** mixto · **Depende de:** backups, staging · **Esfuerzo:** 4-6 h (código) + 1 h (operativo)
> **Archivos principales:** `scripts/verifyRestore.ts`, `scripts/backupDb.ts`, `drizzle/0000_platform_base.sql`, `DEPLOY.md` §19.2, `ROADMAP.md` (H6, B5, E14)

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
- Existe `scripts/verifyRestore.ts`: toma el `.sql.gz` más nuevo de `backups/` (función `pickDump`), se niega a restaurar sobre el origen o la app (comparación con `identity`), exige destino sin tablas en `public` (`publicTables`), restaura con `psql -v ON_ERROR_STOP=1` y compara conteos por tabla (`countRows`) y filas de `drizzle.__drizzle_migrations`.
- **Nunca se corrió** (ROADMAP H6 🔵, B5 🔵, E14 🔴, "Próximos pasos operativos" 1). El ROADMAP y DEPLOY.md §19.2 lo llaman todavía `scripts/verificarRestore.ts` y dicen que rechaza bases con tablas `wa_*` — el script nuevo ya no hace eso.
- Tal como está, el primer restore real va a fallar:
  - El dump trae las políticas `CREATE POLICY … TO "app_runtime"` (`drizzle/0000_platform_base.sql:34-35`) pero no el rol (`pg_dump` no vuelca roles). `verifyRestore.ts` no lo crea en el destino antes de `psql`.
  - `backupDb.ts` vuelca todos los esquemas (sin `-n public -n drizzle`); en un proyecto Supabase destino `auth`/`storage` ya existen → error con `ON_ERROR_STOP`.
  - La extensión `btree_gist` (EXCLUDE anti-solape de citas) tiene que existir en el destino.
  - `backupDb.ts` vuelca con `--no-privileges` (`scripts/backupDb.ts:67`, llamada a `spawn("pg_dump", …)`): el volcado NO trae los `GRANT … TO app_runtime` ni el `ALTER DEFAULT PRIVILEGES` de `drizzle/0000_platform_base.sql:37-44`. Aunque el restore termine ✅ con conteos iguales, la app conectada con el rol de runtime recibe `permission denied` en todas las tablas. El chequeo de conteos de `verifyRestore.ts` (corre con el usuario dueño) no lo detecta.
- No hay test automatizado del ciclo backup → restore; tampoco hay `pg_dump`/`psql` en el job de CI.
- No hay nada que pruebe que la app ARRANCA sobre la base restaurada (solo conteos).

## Objetivo
Un restore ensayado y repetible: script que prepara el destino, restaura, verifica conteos + migraciones + que la app levanta y responde `/health` sobre la base restaurada; corrido una vez contra un volcado real del Supabase nuevo y con la fecha anotada.

## Alcance
- `verifyRestore.ts`: preparar el destino (crear rol `app_runtime NOLOGIN NOBYPASSRLS` si no existe, `CREATE EXTENSION IF NOT EXISTS btree_gist`), restaurar, comparar, y opcionalmente chequear que `scripts/migrate.ts` contra el destino no aplica nada nuevo.
- Un test de integración en CI con un Postgres de servicio (`services: postgres` en GitHub Actions) que corre `backupDb.ts` → `verifyRestore.ts` sobre datos de `seed:dev`. Si no es viable, documentar por qué y dejar un script local.
- Actualizar DEPLOY.md §19.2 y los ítems H6/B5/E14 del ROADMAP con el nombre real del script.
- Runbook corto "restaurar producción" (RTO esperado, quién decide, cómo repuntar `DATABASE_URL`).

## Fuera de alcance
- Hacer el backup completo y cifrado, y decidir los argumentos de `pg_dump` (incluido `--no-privileges`) → `backups` (acá se verifica el resultado).
- Rollback de código → `rollback`.

## Pasos sugeridos
1. Leer `scripts/verifyRestore.ts` y `scripts/backupDb.ts` tal como quedó después de `backups` (ya mergeado: revisá qué decidió sobre esquemas y `--no-privileges`).
2. Agregar `prepareTarget(sql)` con el rol y la extensión; cubrirlo con un test sobre PGlite si aplica.
3. Agregar al workflow un job `restore-check` con `services: postgres:16`, `apt-get install postgresql-client`, `npm run db:migrate` + `npm run seed:dev` contra ese Postgres, backup, restore en una segunda base del mismo servicio y verificación.
4. Documentar el runbook en DEPLOY.md §19.2.
5. Con el OK del usuario: correrlo en el servidor contra un volcado real del Supabase nuevo y un proyecto de prueba; anotar la fecha.

## Decisiones que el agente NO toma solo
- ¿Destino del ensayo real: un segundo proyecto Supabase temporal o un Postgres local/descartable? (no debe ser la base de staging en uso).
- ¿Cada cuánto se repite (DEPLOY.md sugiere 2-3 meses) y quién es responsable?
- RTO/RPO aceptables para vender (p. ej. RPO 24 h con backup diario).

## Criterios de aceptación
- [ ] Job de CI (o script local documentado) que hace backup → restore → verificación y termina en ✅.
- [ ] `verifyRestore.ts` crea `app_runtime` y `btree_gist` en el destino antes de restaurar.
- [ ] Tras restaurar, una consulta con `SET ROLE app_runtime` + `app.tenant_id` de un negocio sembrado lee filas (prueba de grants + RLS), o el backup deja de usar `--no-privileges` y el test lo cubre.
- [ ] DEPLOY.md §19.2 y ROADMAP (H6, B5, E14, "Próximos pasos") con el nombre real del script.
- [ ] Fecha del primer restore real anotada (paso humano).
- [ ] `npm run typecheck` y `npm test` en verde (y en web/ si toca el panel)
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización")

## Reglas para este trabajo
- Rama propia `prod/restore-probado` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist de pasos humanos pendientes (crear base de prueba, correr el ensayo real, anotar la fecha, borrar la base de prueba).
