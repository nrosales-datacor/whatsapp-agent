# Secretos fuera del repo (y placeholders que no arrancan)

> **Punto del checklist:** keep secrets out of the repo · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P0 antes del primer cliente que pague
> **Tipo:** código · **Depende de:** nada · **Esfuerzo:** 3-4 h
> **Archivos principales:** `DEPLOY.md`, `PLAN-PREVENTA.md`, `docs/archivo/PLAN-VALOR-PRODUCTO.md`, `docs/archivo/ROADMAP-hasta-2026-10-04.md`, `src/platform/config/requiredSecrets.ts`, `.env.example`, `.github/workflows/ci-cd.yml`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
- Lo que está bien: `.env`, `.env.local`, `.env.*.local` y `backups/` en `.gitignore`; el único `.env*` versionado además de `.env.example` es `web/.env.mock` (solo `VITE_MOCK_API=1`). Un barrido por patrones de llaves (Stripe `sk_live_`/`whsec_`, tokens de Meta `EAA…`, JWT, llaves privadas) sobre el árbol y el historial no encontró valores reales; `.env.example` solo trae placeholders. Los secretos de CI van como `secrets.*` de GitHub.
- Lo que falla:
  - **La contraseña del panel del piloto sigue en texto plano** en `DEPLOY.md` (§14, línea "Usuario `lavacar-rosales`, contraseña …", ~línea 439), en `PLAN-PREVENTA.md:50` (en la raíz), en `docs/archivo/PLAN-VALOR-PRODUCTO.md:51` y en `docs/archivo/ROADMAP-hasta-2026-10-04.md:320` (pista V2-77, vigente). Verificado con `git grep -n <valor> 5f976e1`: son exactamente esos 4 archivos. No la copies en ningún lado.
  - `productionSecretProblems` (`src/platform/config/requiredSecrets.ts`) solo exige `PANEL_SESSION_SECRET` de ≥16 caracteres: el placeholder público de `.env.example:152` (37 caracteres) pasa el chequeo y permite forjar sesiones si alguien copia el ejemplo a producción (pista V2-03, vigente). Lo mismo para cualquier placeholder de `WHATSAPP_APP_SECRET`/`WHATSAPP_VERIFY_TOKEN`.
  - No hay escaneo automático de secretos en CI (ni gitleaks ni un script propio): nada impide volver a commitear una clave.
  - `DEPLOY.md` §0 pide "copiá el `.env` tal cual" del sistema viejo: el stack nuevo debería nacer con secretos nuevos (ver `rotar-llaves`).

## Objetivo
Cero credenciales reales en el árbol, arranque en producción que rechaza placeholders conocidos, y un guardrail de CI que frene secretos nuevos.

## Alcance
- Quitar la contraseña del piloto de los 4 archivos (reemplazar por "pedila a Nathan / está en el gestor de contraseñas").
- `requiredSecrets.ts`: rechazar en producción valores que coincidan con los placeholders de `.env.example` (leerlos o listarlos), exigir ≥32 bytes de entropía razonable para `PANEL_SESSION_SECRET`; mismo trato para `WHATSAPP_APP_SECRET` y `WHATSAPP_VERIFY_TOKEN` si están definidos. Tests en `test/security/requiredSecrets.test.ts`.
- Guardrail de CI sin dependencias nuevas: `scripts/ci/checkSecrets.mjs` con patrones de llaves conocidas y una lista de cadenas prohibidas, corrido en `verify` como `npm run ci:secrets`. Si se prefiere gitleaks (acción de GitHub), pasa por la política de dependencias.

## Fuera de alcance
- Rotar la contraseña y demás llaves en los sistemas reales → `rotar-llaves`.
- Reescribir el historial de git (se decide en `rotar-llaves`; rotar es lo que protege).
- Que el stack nuevo genere sus propios secretos (DEPLOY.md §0/§4 e inventario) → `rotar-llaves`.

## Pasos sugeridos
1. `git grep -n "lavacar-rosales\|contraseña \`" -- DEPLOY.md PLAN-PREVENTA.md docs/` para ubicar las líneas; editar sin repetir el valor en el commit message.
2. Extender `productionSecretProblems` y sus tests (placeholder exacto, corto, válido).
3. Escribir `checkSecrets.mjs` (patrones: `sk_live_`, `sk_test_` + 20 chars, `whsec_`, `EAA` + 40, `-----BEGIN .*PRIVATE KEY-----`, URLs `postgres://usuario:clave@` que no sean de ejemplo) con una allowlist para `.env.example` y tests; sumarlo a `package.json` y a `ci-cd.yml`.
4. `npm run ci:secrets`, `npm run typecheck`, `npm test`.

## Decisiones que el agente NO toma solo
- ¿Gitleaks (acción externa, pasa por la política de dependencias) o script propio?
- ¿El repo en GitHub es público o privado? Cambia la urgencia de `rotar-llaves`.

## Criterios de aceptación
- [ ] `git grep -n "lavacar-rosales" -- DEPLOY.md PLAN-PREVENTA.md docs/` no muestra ninguna contraseña junto al usuario (y `git grep` del valor viejo, corrido a mano sin pegarlo en el commit, da vacío en el árbol).
- [ ] Con `NODE_ENV=production` y el `PANEL_SESSION_SECRET` de `.env.example`, el server no arranca (test nuevo).
- [ ] `npm run ci:secrets` corre en el job `verify` y falla con un archivo de prueba que contenga un patrón de llave.
- [ ] `npm run typecheck` y `npm test` en verde (y en web/ si toca el panel)
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización")

## Reglas para este trabajo
- Rama propia `prod/secretos-fuera-del-repo` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist de pasos humanos pendientes (rotación en `rotar-llaves`).
