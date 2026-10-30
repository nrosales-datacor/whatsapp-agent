# Progreso de la serie de preparación para producción

Lo mantiene el orquestador (`/prod-readiness`). Ver `00-INDICE.md`.

## Base

| Fecha | PR | Rama | Sha |
|---|---|---|---|
| 2026-10-30 | #15 (último abierto al cargar la serie) | `i6/onboarding` | `2d67138` (`prod/readiness` = `74516e8`) |

Línea base en `prod/readiness` (`74516e8`, Node 22 en la nube): `typecheck` en verde; `npm test` 697/699, con 2 cancelados que ya venían de antes en `test/unit/emailResend.test.ts` ("timeout: Resend colgado…" y "2xx sin id…", `cancelledByParent`). El repo pide Node 24 (`.nvmrc`).

## Prompts

| Slug | Estado (hecho/saltado/bloqueado) | Rama | Base (sha) | Pendientes humanos |
|---|---|---|---|---|
| secretos-fuera-del-repo | hecho (`2665723`, mergeado) | `prod/secretos-fuera-del-repo` | `b393abd` | URGENTE: rotar la contraseña del panel del piloto (repo público, sigue en el historial) → `rotar-llaves`. Crear el secret de GitHub `CHECK_SECRETS_DENYLIST`. Antes de mergear a `main`: revisar que el `.env` del droplet cumpla los mínimos nuevos (≥32 caracteres al azar en `PANEL_SESSION_SECRET`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`; `TOKENS_ENCRYPTION_KEY` sin patrón; `HEALTH_DETAIL_TOKEN` no placeholder). |
| auditoria-de-dependencias | hecho (`6789dfa`, mergeado) | `prod/auditoria-de-dependencias` | `8059782` | Activar alertas de Dependabot (Settings → Code security, sin PRs). Desde 2026-11-06: `vite` 6.4.4 en `web/` (o 6.4.5 desde 11-21). Desde 2026-11-19/22: transitivas del build de `web/` (`fast-uri`, `serialize-javascript`). 2026-11-30: primer repaso mensual (README §7) y evaluar `drizzle-kit` 0.31.x. Excepción aprobada: `zod@4.6.6` antes del mes. |
| auth-en-endpoints | en curso | `prod/auth-en-endpoints` | — | — |
