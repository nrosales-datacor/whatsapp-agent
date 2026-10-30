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
| secretos-fuera-del-repo | en curso | `prod/secretos-fuera-del-repo` | `74516e8` | — |
