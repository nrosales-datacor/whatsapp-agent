# Backups de la base nueva (y de los archivos)

> **Punto del checklist:** back up your database · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P0 antes del primer cliente que pague
> **Tipo:** mixto · **Depende de:** staging · **Esfuerzo:** 1 día (código) + 2 h (operativo)
> **Archivos principales:** `scripts/backupDb.ts`, `src/platform/db/backups.ts`, `test/unit/backups.test.ts`, `.env.example`, `DEPLOY.md` §19

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
- Existe `scripts/backupDb.ts`: `pg_dump` → gzip a `backups/db_<fecha>.sql.gz` vía `.partial`, verifica la marca de cierre (`isDumpComplete` de `src/platform/db/backups.ts`), poda con `selectBackupsToPrune` (retención `BACKUP_RETENTION_DAYS`, mínimo `BACKUP_MIN_KEEP`), copia externa opcional con `BACKUP_COPY_COMMAND` y alerta a Sentry si falla (función `fail`). La lógica pura tiene test (`test/unit/backups.test.ts`).
- El deploy hace backup antes de migrar si hay cambios en `drizzle/` (`ci-cd.yml`, paso "Actualizar código y recargar el proceso").
- Problemas reales en el código nuevo:
  - `pg_dump` se llama con `[url, "--no-owner", "--no-privileges"]` (`backupDb.ts`, bloque `try` del volcado): en Supabase vuelca también `auth`, `storage`, `extensions`, etc. El restore en un proyecto Supabase limpio choca con esos esquemas (pista V2-08, sigue vigente). Falta `-n public -n drizzle`.
  - Las políticas RLS se crean `TO "app_runtime"` (`drizzle/0000_platform_base.sql:34-35`) y el rol no viaja en el dump: el destino tiene que crearlo antes o el restore con `ON_ERROR_STOP` falla.
  - `--no-privileges` descarta los `GRANT … TO app_runtime` (`drizzle/0000_platform_base.sql:37-44`): una base restaurada desde este volcado no deja operar a la app con el rol de runtime. Decidir entre quitar `--no-privileges` (y crear el rol antes de restaurar) o reaplicar los grants al restaurar: la decisión y los argumentos de `pg_dump` son de este prompt; `restore-probado` verifica el resultado.
  - La URL va en `argv` de `pg_dump` (visible en `ps` del droplet compartido); conviene `PGPASSWORD`/`.pgpass` o pasar la URL por env.
  - El dump queda en texto plano en el servidor; la copia externa es opcional y sin cifrado obligatorio.
  - Los archivos de medios viven en un bucket de Supabase Storage (`src/platform/storage/supabaseStorage.ts`, `SUPABASE_STORAGE_BUCKET`, default `media`) y **no se respaldan**.
  - `TOKENS_ENCRYPTION_KEY` cifra secretos en la base: un backup sin esa llave guardada aparte no sirve para los tokens de WhatsApp ni el 2FA.
- `DEPLOY.md` §19 está desactualizado: nombra `BACKUP_RETENCION_DIAS`, `BACKUP_COMANDO_COPIA` con `{archivo}` (el script usa `{file}`), `wa_bot_*.sql.gz`, `~/lavacar-whatsapp-bot`. Nunca se configuró el cron para el Supabase nuevo (no está desplegado).
- Desconocido sin preguntar: plan del Supabase nuevo (Free no tiene backups automáticos ni PITR; Pro sí, diarios con 7 días).

## Objetivo
Backup diario automático, completo y restaurable del Supabase nuevo (esquemas `public` + `drizzle`), cifrado y con copia fuera del servidor, más un plan explícito para los medios del bucket y la llave de cifrado.

## Alcance
- `backupDb.ts`: `-n public -n drizzle`, credenciales fuera de `argv`, cifrado obligatorio en producción (o copia externa obligatoria si `NODE_ENV=production`), nombre de archivo con hora.
- Extraer la construcción de argumentos a una función pura en `src/platform/db/backups.ts` con test.
- Documentar en `DEPLOY.md` §19 el setup real (cron, variables vigentes de `.env.example`, permisos `700` de `backups/`).
- Decisión y script (o procedimiento) para respaldar el bucket de medios.
- En DEPLOY.md §19, remitir al inventario de secretos que dejó `rotar-llaves` (dónde vive la copia de `TOKENS_ENCRYPTION_KEY`): sin esa llave el backup no sirve para los tokens cifrados. No definas otro gestor ni otro procedimiento.

## Fuera de alcance
- Probar el restore → `restore-probado`.
- Alerta si el backup falla: ya existe vía Sentry (`fail()` de `backupDb.ts`); un detector de "backup que no corrió" es ítem aparte (anotalo en el ROADMAP). Uptime → `uptime`.
- Inventario y gestor de secretos → `rotar-llaves`.

## Pasos sugeridos
1. Leer `scripts/backupDb.ts`, `src/platform/db/backups.ts` y su test.
2. Agregar `buildPgDumpArgs()` puro (esquemas, `--no-owner` y `--no-privileges` según la decisión de abajo) y test; pasar la contraseña por `PGPASSWORD` derivada de la URL.
3. Exigir `BACKUP_COPY_COMMAND` (o una variable de cifrado) cuando `NODE_ENV=production`; si falta, salir con código ≠ 0 y Sentry.
4. Probar el volcado contra una base PGlite/Postgres local si hay `pg_dump` disponible; si no, solo los tests puros.
5. Reescribir DEPLOY.md §19.1 con las variables actuales y la ruta nueva del proyecto.

## Decisiones que el agente NO toma solo
- ¿Plan del Supabase nuevo: Free + `pg_dump` propio, o Pro (backups diarios del proveedor; PITR como extra pago)?
- ¿Dónde va la copia externa (Backblaze B2, S3, Google Drive vía rclone) y con qué cifrado (gpg o age)? Costo mensual.
- ¿Se respaldan los medios del bucket? ¿Con qué frecuencia y retención?
- ¿`pg_dump` con o sin `--no-privileges`? (con: hay que reaplicar los grants de `drizzle/0000_platform_base.sql:37-44` al restaurar; sin: el rol `app_runtime` tiene que existir en el destino antes del restore).

## Criterios de aceptación
- [ ] Test nuevo que verifica que los argumentos de `pg_dump` incluyen `-n public -n drizzle` y no incluyen la contraseña.
- [ ] Con `NODE_ENV=production` y sin copia externa configurada, `backupDb.ts` sale con código 1.
- [ ] DEPLOY.md §19 usa solo variables que existen en `.env.example` (`npm run ci:env` en verde).
- [ ] Decisión sobre medios y llaves documentada en DEPLOY.md.
- [ ] `npm run typecheck` y `npm test` en verde (y en web/ si toca el panel)
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización")

## Reglas para este trabajo
- Rama propia `prod/backups` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist de pasos humanos pendientes (instalar `postgresql-client`, cron, `BACKUP_DATABASE_URL` directa 5432, configurar rclone/gpg, guardar llaves).
