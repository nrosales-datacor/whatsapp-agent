# Rollback de deploys y plan de corte del sistema viejo

> **Punto del checklist:** have a rollback plan for bad deploys · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P0 antes del primer cliente que pague
> **Tipo:** mixto · **Depende de:** ci-cd, backups, restore-probado, smoke-tests · **Esfuerzo:** 1 día
> **Archivos principales:** `.github/workflows/ci-cd.yml` (job `rollback`), `DEPLOY.md` (§15 Rollback y expand/contract), `ecosystem.config.cjs`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
- Existe un rollback **de código** manual: job `rollback` (`ci-cd.yml:240`, `workflow_dispatch` con input `sha`), que toma el SHA o `~/.ultimo-deploy-ok`, compila el panel de ese commit, hace `git checkout`, `npm ci --omit=dev`, swap atómico de `web/dist` y `pm2 startOrReload` (`ci-cd.yml:306-312`); luego chequea `/health` y marca el SHA como último bueno. El deploy imprime cómo revertir si falla (`if: failure()`).
- DEPLOY.md §15 documenta el protocolo expand/contract para migraciones no aditivas.
- Huecos en el código nuevo:
  - Igual que `deploy`, `rollback` apunta por defecto al droplet y URL VIEJOS (`ci-cd.yml:248-251`). `~/.ultimo-deploy-ok` del droplet hoy contiene un SHA del sistema viejo: un rollback "a ciegas" desde el stack nuevo volvería a código que habla `wa_*` contra la base nueva.
  - El rollback solo verifica `/health`, no el smoke de `/panel` y `/api/panel/me` que sí corre el deploy (DEPLOY.md dice lo contrario: "mismo smoke de 3 superficies").
  - No valida que el SHA pedido haya pasado CI ni que sea ancestro de `main`.
  - El job `rollback` NO declara `environment: produccion` (a diferencia de `deploy`, `ci-cd.yml:95`): se salta los required reviewers y, si `DEPLOY_SSH_KEY`/`DEPLOY_HOST_KEY` se mueven a secrets del environment (como pide `ci-cd`), el rollback se queda sin llave y falla justo cuando hace falta.
  - Inyección de comandos: el input se interpola crudo en el script (`sha_input="${{ github.event.inputs.sha }}"`, `ci-cd.yml:269`) y luego en el shell remoto (`git checkout $ROLLBACK_SHA`, `ci-cd.yml:306`). Un valor como `x; comando` corre en el runner y en el servidor. Hay que pasarlo por `env:` y validar `^[0-9a-f]{7,40}$` antes de usarlo.
  - No hay guía de "deploy roto con migración": cuándo restaurar backup vs. migración correctiva hacia adelante.
- **No existe plan de corte** del sistema viejo (droplet `wabotlavacar.selyon.app` + Supabase viejo) al nuevo: ni cuándo se apaga, ni cómo se mueve el webhook de Meta (`/webhook/whatsapp` en el nuevo), ni cómo se vuelve atrás si el nuevo falla el día del corte. `PLAN-GESTION.md` solo dice que `main` se fusiona "cuando I2 esté lista".

## Objetivo
Un rollback confiable para el stack nuevo (código y, con juicio humano, datos) y un plan de corte viejo→nuevo con vuelta atrás explícita.

## Alcance
- `rollback`: declarar `environment:` (mismo gate que `deploy`), recibir el SHA por `env:` y validarlo con regex hex antes de cualquier `ssh`; usar las variables por entorno que dejó `ci-cd` (que ya quitó los defaults del droplet viejo); confirmar que corre `scripts/ci/smoke.sh` igual que `deploy` (el script lo dejó `smoke-tests`); rechazar SHAs que no estén en `main` o cuyo check de CI no haya pasado (`gh api` de check-runs).
- Guardar `~/.ultimo-deploy-ok` por entorno y por carpeta del proyecto nuevo (no compartido con el viejo).
- `DEPLOY.md`: runbook "deploy malo" en 3 casos (solo código / migración aditiva / migración destructiva → restore desde backup) con quién decide.
- `docs/` o `DEPLOY.md`: plan de corte paso a paso (congelar el viejo, levantar el nuevo en su dominio, pasar número(s) de Meta, ventana de observación, apagar el viejo) y su rollback (devolver el webhook de Meta al viejo, que sigue intacto con su base).

## Fuera de alcance
- Pipeline, entornos y quitar los defaults del droplet viejo → `ci-cd`, `staging`. Script de smoke → `smoke-tests`. Restore → `restore-probado`. DNS → `dominio-y-ssl`.

## Pasos sugeridos
1. Leer `ci-cd.yml` (jobs `deploy` y `rollback`) y DEPLOY.md §15.
2. Confirmar que `deploy` y `rollback` llaman `scripts/ci/smoke.sh` (de `smoke-tests`); si falta en alguno, enchufarlo sin reescribir el script.
3. Agregar el paso de validación del SHA (`git merge-base --is-ancestor` en el runner + estado de checks).
4. Escribir el runbook y el plan de corte; incluir checklist del día del corte.
5. Probar el job contra staging solo con el OK del usuario.

## Decisiones que el agente NO toma solo
- ¿Hay datos del piloto viejo que migrar a la base nueva o se arranca de cero?
- ¿Cuánto tiempo se mantiene vivo el sistema viejo después del corte (para volver atrás)?
- ¿Fecha y ventana del corte, y quién aprueba el rollback en producción?

## Criterios de aceptación
- [ ] `rollback` no tiene defaults del droplet viejo (verificar lo que dejó `ci-cd`) y corre `scripts/ci/smoke.sh` igual que `deploy`.
- [ ] Un SHA que no está en `main` hace fallar el rollback antes de tocar el servidor.
- [ ] Un input `sha` con caracteres no hex (p. ej. `abc;id`) falla en el paso de validación sin ejecutarse; `grep -n 'github.event.inputs.sha' .github/workflows/ci-cd.yml` solo aparece dentro de un bloque `env:`.
- [ ] El job `rollback` declara `environment:` y requiere la misma aprobación que `deploy`.
- [ ] DEPLOY.md tiene el runbook de deploy malo y el plan de corte con su vuelta atrás.
- [ ] `npm run typecheck` y `npm test` en verde (y en web/ si toca el panel)
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización")

## Reglas para este trabajo
- Rama propia `prod/rollback` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist de pasos humanos pendientes (ensayar un rollback en staging, fijar la fecha del corte).
