# Progreso de la serie de preparación para producción

Lo mantiene el orquestador (`/prod-readiness`). Ver `00-INDICE.md`.

## Base

| Fecha | PR | Rama | Sha |
|---|---|---|---|
| 2026-10-30 | #15 (último abierto al cargar la serie) | `i6/onboarding` | `2d67138` (`prod/readiness` = `74516e8`) |

Línea base en `prod/readiness` (`74516e8`, Node 22 en la nube): `typecheck` en verde; `npm test` 697/699, con 2 cancelados que ya venían de antes en `test/unit/emailResend.test.ts` ("timeout: Resend colgado…" y "2xx sin id…", `cancelledByParent`). El repo pide Node 24 (`.nvmrc`).

## Modo paralelo (desde 2026-10-30, aprobado por el usuario)

Tres carriles a la vez, cada agente en su worktree; preguntas y merges a `prod/readiness` siguen siendo de a uno con aprobación.

- **A — infra:** rotar-llaves → staging → dominio-y-ssl → … (sigue el orden del índice para lo de infraestructura).
- **B — agente IA:** evals → limites-de-tokens → prompt-injection → tests-de-regresion.
- **C — legal/panel:** privacidad-y-terminos → tests-unitarios → multiples-dispositivos → accesibilidad.

## Prompts

| Slug | Estado (hecho/saltado/bloqueado) | Rama | Base (sha) | Pendientes humanos |
|---|---|---|---|---|
| secretos-fuera-del-repo | hecho (`2665723`, mergeado) | `prod/secretos-fuera-del-repo` | `b393abd` | URGENTE: rotar la contraseña del panel del piloto (repo público, sigue en el historial) → `rotar-llaves`. Crear el secret de GitHub `CHECK_SECRETS_DENYLIST`. Antes de mergear a `main`: revisar que el `.env` del droplet cumpla los mínimos nuevos (≥32 caracteres al azar en `PANEL_SESSION_SECRET`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`; `TOKENS_ENCRYPTION_KEY` sin patrón; `HEALTH_DETAIL_TOKEN` no placeholder). |
| auditoria-de-dependencias | hecho (`6789dfa`, mergeado) | `prod/auditoria-de-dependencias` | `8059782` | Activar alertas de Dependabot (Settings → Code security, sin PRs). Desde 2026-11-06: `vite` 6.4.4 en `web/` (o 6.4.5 desde 11-21). Desde 2026-11-19/22: transitivas del build de `web/` (`fast-uri`, `serialize-javascript`). 2026-11-30: primer repaso mensual (README §7) y evaluar `drizzle-kit` 0.31.x. Excepción aprobada: `zod@4.6.6` antes del mes. |
| auth-en-endpoints | hecho (`7b6bf74`, mergeado) | `prod/auth-en-endpoints` | `9da878b` | Antes del primer deploy: `npx tsx scripts/generateTotp.ts admin` y cargar `PANEL_SUPERADMIN_TOTP_SECRET` (DEPLOY.md §14); sin él no arranca. Opcional: avisar en la UI que "Cerrar sesión" cierra todos los dispositivos. Más adelante (P1.3b): superadmins por persona y logout del admin que revoque. Decidido: `staff` puede leer `GET /whatsapp/settings` y `/whatsapp/growth` (está bien así). |
| smoke-tests | hecho (`0137348`, mergeado) | `prod/smoke-tests` | `0296c2b` | Con el servidor nuevo: ver en Actions el primer "Smoke post-deploy" (5 ✅) y probar una vez el rollback manual. Confirmar que nginx/Caddy reenvían `Host` (si no, el login falso da 403). Avisar que un `invalid_credentials` de `smoke-test@selyon-smoke.invalid` por deploy es esperable. Primer push: job `e2e` en verde con el arranque sembrado. |
| rotar-llaves | en curso (carril A) | `prod/rotar-llaves` | `cabf4a5` | — |
| evals | en curso (carril B) | `prod/evals` | `cabf4a5` | — |
| privacidad-y-terminos | en curso (carril C) | `prod/privacidad-y-terminos` | `cabf4a5` | — |
| tests-unitarios | en curso (carril D) | `prod/tests-unitarios` | `bf99b79` | — |
| error-tracking | en curso (carril E) | `prod/error-tracking` | `a3e04ed` | — |
| alertas | en curso (carril F) | `prod/alertas` | `a3e04ed` | — |
| limites-de-tokens | en curso (carril G) | `prod/limites-de-tokens` | `a3e04ed` | — |

## Decisiones ya tomadas para los que siguen en cola

- **multiples-dispositivos** (después de privacidad-y-terminos y tests-unitarios): hasta ~3 min extra de CI por push; sin servicio pago de dispositivos (QA manual del usuario con sus teléfonos, checklist corta; preguntar qué equipos tiene); Firefox no es objetivo (Chromium + WebKit).
- **accesibilidad** (después de multiples-dispositivos): sí a `@axe-core/playwright` como devDependency (con la política); meta de lanzamiento "sin violaciones serias de axe", WCAG 2.2 AA completo después; si un token de "Banca privada" no da contraste, se oscurece lo mínimo y se muestra antes/después.
