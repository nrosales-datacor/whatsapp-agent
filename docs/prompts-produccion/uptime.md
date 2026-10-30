# Monitor de uptime sobre `/health` (web y worker)

> **Punto del checklist:** set up uptime monitoring · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P0 antes del primer cliente que pague
> **Tipo:** mixto (casi todo operativo) · **Depende de:** dominio-y-ssl, alertas · **Esfuerzo:** 2-3 h + 30 min de configuración
> **Archivos principales:** `src/platform/http/health.ts`, `src/app.ts`, `DEPLOY.md` §10, §17, §21, §22, `.github/workflows/ci-cd.yml`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
Lo que existe:
- `/health` real: `checkHealth()`/`serveHealth()` en `src/platform/http/health.ts` hace `SELECT 1` con timeout (`HEALTH_DB_TIMEOUT_MS`, 1500 ms) y responde 200 `Selyon…: ok` o 503 `degradado`; `?detail=1&token=` con `HEALTH_DETAIL_TOKEN` (comparación en tiempo constante) devuelve JSON. Montado en `createAppHandler` (`src/app.ts`, ~l. 93) y en `createWorkerHandler` (~l. 141).
- El CI (`.github/workflows/ci-cd.yml`, paso «Verificar que el proceso responde (/health)», ~l. 181) reintenta `curl -sf $BASE_URL/health` tras el deploy y hace smoke de `/panel` y `/api/panel/me`.

Lo que falta / está roto:
- **La guía del monitor apunta a una ruta que ya no existe:** `DEPLOY.md` §17 (~l. 617-624) manda a configurar UptimeRobot contra `https://wabotlavacar.selyon.app/salud` y afirma que «`/salud` ya existe»; también §2 (~l. 81), §15 (~l. 528), §21 (~l. 803-836, que además usa `ROL=` en vez de `ROLE=` y apps `whatsapp-bot-web/worker` en vez de `selyon-crm` de `ecosystem.config.cjs`), §22 (~l. 862-880), §24 (~l. 940) y la nota de la landing bajo «Mantenimiento rápido» (~l. 998). §10 (~l. 254-260) promete que `GET /` diga «Agente de WhatsApp corriendo ✅», que tampoco es cierto hoy. En el código nuevo `grep salud src` no encuentra la ruta: un monitor configurado según la guía recibiría 404 permanente (o, si ya estaba configurado con el server viejo, quedaría en rojo tras el deploy del código nuevo).
- **No verificado en producción:** ROADMAP E14 🔴; no hay evidencia de que el monitor exista ni de quién recibe la alerta.
- **El worker no se monitorea:** con `ROLE=worker` (DEPLOY §21) el worker escucha en otro puerto sin exponer; si muere, la web sigue en 200 y nadie se entera. `/health` no reporta si el worker/cola está vivo: `checkHealth()` (`health.ts` ~l. 71-79) solo devuelve `db`, `uptimeSec` y `role`. Hay material para el latido: `tryAcquireLease()`/`startLeaderLoop()` en `src/platform/net/leaderLease.ts` (~l. 47/77, tabla `leader_leases`).
- **Sin página de estado** para los negocios (decisión de producto).

## Objetivo
Saber en ≤5 minutos si el servicio (web, base o worker) está caído, con un monitor externo configurado contra la ruta correcta y probado.

## Alcance
- Código: agregar a `checkHealth()` un chequeo **no crítico por defecto** del latido del worker (p. ej. antigüedad del último tick en `leader_leases` o del último job reclamado); que `detail` lo muestre y que una env (`HEALTH_REQUIRE_WORKER=1`) lo vuelva crítico (503). Tests con PGlite.
- Opcional, a decidir: alias `GET /salud` → misma respuesta, para no romper monitores ya configurados.
- Docs: reescribir `DEPLOY.md` §17 con `/health`, la palabra clave a buscar (`ok`), intervalo, contactos, y cómo probarlo (parar el proceso y ver la alerta). Corregir las menciones de `/salud`, `SALUD_DETALLE_TOKEN`, `?detalle=1` en §2, §10, §21, §24 y mantenimiento (en §21, también `ROL=` → `ROLE=`). §15 la reescribió `ci-cd` y §22 `alertas` (ya mergeados): si les quedó alguna mención, corregila sin reescribir esas secciones.
- Si se usa `HEALTH_DETAIL_TOKEN`, documentar un segundo monitor con keyword sobre el JSON (sin poner el token en docs).

## Fuera de alcance
- Alertas internas (LLM caído, backlog de cola): `alertas`.
- Smoke post-deploy más amplio: `smoke-tests`. Dominio y certificados: `dominio-y-ssl`.
- Rollback automático si `/health` falla: ítem aparte (el rollback es manual, ver `rollback`).

## Pasos sugeridos
1. Leer `health.ts`, `src/app.ts`, `src/platform/net/leaderLease.ts` y `test/` de health.
2. Diseñar el latido (sin escrituras extra en el camino caliente: reusar el lease del líder si alcanza).
3. Tests: worker con latido viejo → `detail` lo muestra; con `HEALTH_REQUIRE_WORKER=1` → 503.
4. Corregir `DEPLOY.md` y comprobar con `grep -n "salud" DEPLOY.md` que no queden rutas viejas.

## Decisiones que el agente NO toma solo
- Proveedor del monitor (UptimeRobot free, Better Stack, Healthchecks.io…) y quién recibe las alertas (email/SMS/Slack), también de noche.
- ¿Mantener el alias `/salud` por compatibilidad o cortar limpio?
- ¿El worker caído debe poner `/health` en 503 (lo que dispara el monitor) o solo verse en el detalle + alerta?
- ¿Página de estado pública para los negocios?

## Criterios de aceptación
- [ ] `grep -rn "/salud\|SALUD_DETALLE\|detalle=1" DEPLOY.md` vacío (o solo en una nota de migración explícita).
- [ ] Test nuevo del latido del worker en verde (crítico y no crítico).
- [ ] `curl -s localhost:PORT/health` con PGlite → 200 `ok`; con la base caída simulada → 503.
- [ ] `npm run typecheck` y `npm test` en verde.
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización").

## Reglas para este trabajo
- Rama propia `prod/uptime` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet, UptimeRobot) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas (ni `HEALTH_DETAIL_TOKEN`).
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist humano: crear el monitor contra `https://<dominio>/health`, contactos de alerta, prueba de caída controlada (parar el proceso en una ventana acordada) y confirmar que llegó la alerta.
