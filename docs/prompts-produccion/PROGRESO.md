# Progreso de la serie de preparación para producción

Lo mantiene el orquestador (`/prod-readiness`). Ver `00-INDICE.md`. **Este archivo es el documento de traspaso:** con
él (y las ramas en GitHub) cualquier persona o sesión nueva puede seguir la serie donde quedó. Se actualiza y se sube a
GitHub (`prod/readiness`) cada vez que cambia algo.

## Cómo retomar (otra persona u otra sesión)

1. `git fetch origin && git checkout prod/readiness` (tiene lo mergeado + este archivo). Node 24 (`.nvmrc`), `npm ci`.
2. En Claude Code, desde la raíz: `/prod-readiness`. El orquestador lee el índice y este archivo.
3. Ramas `prod/<slug>` con estado **"listo, espera merge"**: ya están en GitHub con su commit; solo falta que el
   usuario apruebe el merge a `prod/readiness` (`git merge --no-ff prod/<slug>`), correr `npm run typecheck` y `npm test`,
   y actualizar esta tabla.
4. Estado **"en curso"**: el agente estaba trabajando en una copia local que NO está en GitHub. Si la sesión que lo
   corría se perdió, relanzar ese prompt desde `prod/readiness` (`git checkout -b prod/<slug> prod/readiness`) con
   las decisiones anotadas en la sección "Decisiones ya tomadas".
5. Ramas `wip/<slug>` en GitHub: **respaldo** del trabajo sin terminar ni verificar de un agente (se guardó el
   2026-10-31 tras un corte por límite de uso). Si la sesión se perdió, se puede seguir desde ahí
   (`git checkout -b prod/<slug> wip/<slug>`) en vez de empezar de cero: revisar, terminar, verificar y commitear.
   Cuando la rama `prod/<slug>` final esté en GitHub, la `wip/<slug>` se puede borrar.
6. Nunca mergear a `main` ni a las ramas del stack (#2→#15): eso es por PR que aprueba el usuario.

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
| rotar-llaves | hecho en código/docs (`cc896de`, mergeado 2026-10-31); falta lo humano | `prod/rotar-llaves` | `cabf4a5` | URGENTE (DEPLOY.md §26.1): desactivar `lavacar-rosales` por SQL en el Supabase viejo y reiniciar; cargar `CHECK_SECRETS_DENYLIST`; rotar la key de OpenAI y los secretos de Meta del sistema viejo. Elegir gestor de contraseñas (recomendado: Bitwarden). Decidir si el stack nuevo usa app de Meta propia. **Antes del primer push a `main` del stack nuevo: `DEPLOY_HOST`/`DEPLOY_USER`/`DEPLOY_DIR`/`BASE_URL` y deploy key nueva — hoy el CI apunta por defecto al droplet viejo** (§26.4). Validar el calendario de rotación. |
| evals | hecho, falta corrida real (`957f46c`, mergeado 2026-10-31) | `prod/evals` | `cabf4a5` | Conseguir `OPENAI_API_KEY` de desarrollo y correr `EVAL_REPEAT=3 EVAL_WRITE_BASELINE=1 npm run eval` (tope US$1; ~US$0,10–0,20 con `gpt-4o-mini`); revisar rojos; commitear `eval/baseline.json`, marcar P1.16 ✅ y quitar el "Falta" de I2. |
| privacidad-y-terminos | hecho, borrador legal (`87bf4ca`, mergeado 2026-10-31) | `prod/privacidad-y-terminos` | `cabf4a5` | Completar los marcadores `[PENDIENTE: …]` de `landing/privacidad.html`, `terminos.html` y `contrato.html` (razón social o persona física, cédula, domicilio, correos de soporte y privacidad, regiones de Supabase y DigitalOcean, precios e IVA, jurisdicción, representante legal, cuenta SINPE, canal oficial de contacto). Revisión por abogado cuando haya más clientes; PRODHAB pendiente sin responsable. Ojo: `landing/index.html` todavía muestra `wa.me/50683658231` (7 veces) — decidir el canal oficial. Migración nueva `0011_legal_acceptances` (tabla propia, invitados también aceptan). |
| tests-unitarios | hecho (`c5e5cbd`, mergeado 2026-10-31) | `prod/tests-unitarios` | `bf99b79` | Ninguno. Refactor chico del panel para poder testear (`setTransport`/`mockMode.ts`) y 2 arreglos de formato (`formatMinutes`, `compactCents`). |
| error-tracking | hecho (`38e7720`, mergeado 2026-10-31) | `prod/error-tracking` | `a3e04ed` | Crear cuenta Sentry (free) y un proyecto; `SENTRY_DSN` en el `.env` del servidor (opcional `SENTRY_PANEL_DSN`); correr `scripts/sentryTestEvent.ts`; reglas de alerta y scrubbing en Sentry (DEPLOY.md §16). `@sentry/react@10.54.0` nuevo en `web/`. El bundle principal del panel pesa ~811 kB (aviso de Vite) — revisar en `optimizar-imagenes`/`cache`. |
| alertas | hecho (`fbb19a7`, mergeado 2026-10-31) | `prod/alertas` | `a3e04ed` | Crear bot de Telegram (@BotFather), sacar el chat id (DEPLOY.md §22.1), cargar `ALERTS_TELEGRAM_BOT_TOKEN` y `ALERTS_TELEGRAM_CHAT_ID` en el servidor y correr `scripts/sendTestAlert.ts`. Ajustar umbrales `ALERTS_*` con tráfico real. Contadores por proceso (con varias réplicas worker, cada una cuenta lo suyo). |
| limites-de-tokens | hecho (`544f485`, mergeado 2026-10-31) | `prod/limites-de-tokens` | `a3e04ed` | Aprobar los defaults: 600 tokens de salida (+3000 en modelos de razonamiento), prompt máx. 32 000 caracteres, audio máx. 120 s / 3 MB. Decidir si los topes pasan a ser por plan (junto con `topes-de-gasto`). Probar una nota de voz real de >2 min. |

## Estado de `prod/readiness` (2026-10-31, tras mergear 11 prompts)

`typecheck` raíz y `web/` en verde; `npm test` 886/888 (los 2 cancelados de siempre en `emailResend.test.ts`, Node 22);
`ci:audit`, `ci:versions`, `ci:secrets`, `ci:env` y `db:check` en verde; build del panel OK; Playwright 92/93: el único
rojo (`whatsapp.panel.spec.ts` › "push: el botón aparece…") falla igual en la base con el Chromium de este contenedor
(el permiso de notificaciones arranca en "default"); en CI usa el Chromium de `npx playwright install` — confirmar
en el primer push. Conflictos resueltos al mergear: `ROADMAP.md` (ítems y fecha), `TESTING.md` (tests-unitarios +
evals), `web/src/main.tsx` (Sentry + transporte mock) y `alertas` × `error-tracking` en `pipeline.ts`,
`requiredSecrets.ts`, `server.ts` y su test (se conservaron los dos: `reportTurnError` + contadores de alertas; los
dos avisos de configuración).

## Decisiones ya tomadas para los que siguen en cola

- **Decisiones de los que ya corrieron o corren:** textuales en cada reporte; resumen: secretos → script propio, repo sigue público; dependencias → excepción `zod@4.6.6`, Dependabot solo alertas; auth → sin servidor de prod aún, superadmins por persona más adelante, logout cierra todas; smoke → login falso OK, sin usuario de smoke real; rotar-llaves → desactivar usuario del piloto, no reescribir historial, sin gestor aún, rotar OpenAI y Meta ya; evals → sí gastar tokens pero aún sin key (harness listo, se salta sin key), 90 % general / 100 % críticos, rubros uñas y dental; privacidad → sin datos legales (marcadores `[PENDIENTE]`), sin abogado por ahora, sacar el número de WhatsApp, tabla propia de aceptación e invitados también aceptan; error-tracking → Sentry free, un proyecto, `@sentry/react`, sin DSN solo advierte; alertas → Telegram, sin canal solo advierte, umbrales propuestos por el agente; límites → topes conservadores ajustables por plan, audio máx. 2 min.
- **staging** (siguiente del carril A, depende de rotar-llaves): el usuario quiere **staging en el mismo servidor que producción**, pero todavía no eligió proveedor y quiere ver opciones **gratis** (no necesariamente DigitalOcean). Falta esa elección antes de lanzarlo.

- **multiples-dispositivos** (después de privacidad-y-terminos y tests-unitarios): hasta ~3 min extra de CI por push; sin servicio pago de dispositivos (QA manual del usuario con sus teléfonos, checklist corta; preguntar qué equipos tiene); Firefox no es objetivo (Chromium + WebKit).
- **accesibilidad** (después de multiples-dispositivos): sí a `@axe-core/playwright` como devDependency (con la política); meta de lanzamiento "sin violaciones serias de axe", WCAG 2.2 AA completo después; si un token de "Banca privada" no da contraste, se oscurece lo mínimo y se muestra antes/después.
