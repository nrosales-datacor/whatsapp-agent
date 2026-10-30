# Rotar lo que se filtró y nacer con secretos nuevos

> **Punto del checklist:** rotate any keys that leaked · **Estado en `5f976e1`:** ❌ falta · **Prioridad:** P0 antes del primer cliente que pague
> **Tipo:** operativo · **Depende de:** secretos-fuera-del-repo · **Esfuerzo:** 2-3 h
> **Archivos principales:** `DEPLOY.md` (§0, §4, §14, §15, §20), `.env.example`, `src/platform/crypto/secrets.ts`, `ROADMAP.md` ("Pendientes operativos (piloto)")

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
- **Filtrado confirmado:** la contraseña del panel del usuario `lavacar-rosales` del sistema viejo está en texto plano en `DEPLOY.md:439` (§14), `PLAN-PREVENTA.md:50` y dos archivos de `docs/archivo/` (`PLAN-VALOR-PRODUCTO.md:51`, `ROADMAP-hasta-2026-10-04.md:320`), y por lo tanto en el historial de git de todas las ramas. El sistema viejo sigue en producción con ese usuario. ROADMAP la lista como pendiente ("Cambiar la contraseña temporal del panel del piloto", sección "Pendientes operativos (piloto)") y la marca como obsoleta, pero el panel viejo sigue expuesto en internet.
- En el stack nuevo ese usuario no existe (login por email, `users`/`memberships`), así que el riesgo es del sistema viejo mientras siga vivo.
- No se encontraron en el árbol ni en el historial llaves con formato de Stripe, Meta, JWT de Supabase ni llaves privadas SSH (barrido por patrones). No se pudo ver el `.env` del droplet ni los secrets de GitHub.
- Riesgo estructural (pista V2-22): el droplet es compartido con otra app bajo el mismo usuario Unix; `DEPLOY.md` §0 pide reutilizar "el mismo `.env`". Si el stack nuevo hereda `PANEL_SESSION_SECRET`, `TOKENS_ENCRYPTION_KEY`, la deploy key de CI y la contraseña del Supabase viejo, hereda también cualquier exposición pasada.
- `src/platform/crypto/secrets.ts` fija la llave de cifrado al importar: no hay herramienta de rotación de `TOKENS_ENCRYPTION_KEY` con datos existentes (pista V2-47). Para el stack nuevo conviene generarla nueva ANTES de cargar datos.

## Objetivo
Contraseña del piloto invalidada en el sistema viejo, y el stack nuevo arrancando con un juego completo de secretos nuevos que no comparte nada con el viejo, con un inventario de qué secreto vive dónde.

## Alcance
- Paso humano en el sistema viejo: resetear la clave de `lavacar-rosales` (o desactivar el usuario) y revocar sus sesiones.
- Inventario en `DEPLOY.md` (tabla nueva): cada secreto del stack nuevo (`PANEL_SESSION_SECRET`, `TOKENS_ENCRYPTION_KEY`, `PANEL_SUPERADMIN_HASH`/TOTP, `DATABASE_URL`/`DATABASE_URL_MIGRATIONS` con el rol `app_runtime`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `OPENAI_API_KEY`, `STRIPE_*`, `RESEND_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, VAPID, `SENTRY_DSN`, `DEPLOY_SSH_KEY`), cómo se genera, dónde se guarda la copia y cómo se rota.
- Generar secretos nuevos para el stack nuevo (comandos en DEPLOY.md, nunca valores).
- Llave SSH de deploy nueva por entorno (no reusar la del droplet viejo).
- Procedimiento de rotación periódica y "si se filtra X, hacé Y".

## Fuera de alcance
- Sacar secretos del árbol y guardrail de CI → `secretos-fuera-del-repo`.
- Herramienta de rotación de `TOKENS_ENCRYPTION_KEY` con datos vivos (llavero con `kid`) → proponer como ítem aparte en el ROADMAP si el usuario lo prioriza.

## Pasos sugeridos
1. Leer `.env.example` completo y armar la tabla de inventario.
2. Escribir la sección de DEPLOY.md con comandos de generación (`openssl rand -hex 32`, `node --import tsx scripts/hashPassword.ts`, `scripts/generateTotp.ts`, `npx web-push generate-vapid-keys`).
3. Preparar el checklist humano para el día del alta del entorno nuevo.
4. NO ejecutar nada contra el droplet, Supabase, Meta, OpenAI ni Stripe: dejar los pasos para el usuario.

## Decisiones que el agente NO toma solo
- ¿Se resetea la clave del piloto o se desactiva el usuario viejo directamente?
- ¿Se reescribe el historial de git (BFG/filter-repo) o alcanza con rotar? (reescribir rompe los PRs abiertos #2→último PR abierto).
- ¿Gestor de secretos del equipo (1Password, Bitwarden, Doppler) y quién tiene acceso?
- ¿Se rotan también las llaves del sistema viejo (OpenAI, Meta, Supabase viejo) o solo se apaga al cortar?

## Criterios de aceptación
- [ ] DEPLOY.md tiene la tabla de inventario de secretos del stack nuevo con generación, ubicación y rotación (sin valores).
- [ ] Checklist humano entregado: clave del piloto reseteada, secretos nuevos generados, llave de deploy nueva cargada en GitHub.
- [ ] `npm run ci:env` en verde (si se tocó `.env.example`).
- [ ] `npm run typecheck` y `npm test` en verde (y en web/ si toca el panel)
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización")

## Reglas para este trabajo
- Rama propia `prod/rotar-llaves` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist de pasos humanos pendientes (cada rotación con quién la hace y dónde se confirma).
