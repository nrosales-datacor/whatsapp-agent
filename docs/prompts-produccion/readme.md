# README que explica cómo funciona (y docs de deploy/testing al día)

> **Punto del checklist:** write a README so future you knows how it works · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P1 antes de 5 clientes
> **Tipo:** código (docs) · **Depende de:** nada (va último: corre con todos los demás ya mergeados) · **Esfuerzo:** 0,5–1 día
> **Archivos principales:** `README.md`, `TESTING.md`, `DEPLOY.md`, `.env.example`, `src/routes.ts`, `src/jobs.ts`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
- `README.md` (185 líneas) **sí refleja el código nuevo** en lo que cubre: Selyon CRM, stack, instalación con Node 24 (`.nvmrc` existe), PGlite por defecto, `npm run seed:dev` con los usuarios reales de `scripts/seedDev.ts:41-45` (`owner@`, `recepcion@`, `ana@demo-estetica.test`), modo mock con sus cuentas, superadmin local, comandos de test y CI, y un árbol de `src/`.
- Lo que no cubre ("cómo funciona"):
  - El ciclo de un request: `src/app.ts` (health, webhooks firmados, `/api/panel/*`, landing, panel estático) → router declarativo (`src/platform/http/router.ts`: CSRF → sesión → rol → módulo del plan → sucursal → Zod) y dónde se declaran las rutas (`src/routes.ts`).
  - Modelo de seguridad: sesiones con epoch, 2FA, RLS por negocio (`withTenant`/`withSystem`, `src/platform/db/scope.ts`), rol `app_runtime`.
  - Cola genérica y loops de fondo (`src/jobs.ts`, `src/platform/queue/`), correo por la cola (`src/platform/email/`), roles de proceso web/worker.
  - Planes y módulos (`src/plans.ts`, `PlanFeature`), fronteras entre módulos (`test/architecture/moduleBoundaries.test.ts`) y cómo agregar un módulo/ruta/migración (`npm run db:generate`, `db:check`).
  - Variables de entorno mínimas para producción (hoy solo `.env.example`).
  - En local, los correos van al proveedor `log` y "no se muestran con su link": no hay forma de probar a mano invitación/recuperación/verificación.
- El propio README dice que `DEPLOY.md` y `TESTING.md` "todavía describen la versión anterior": DEPLOY.md tiene ~45 líneas con lavacar/`wa_`/`rosalescarwash` (29 solo con lavacar/rosalescarwash; TESTING.md, 1) (p. ej. §8 `whatsapp-bot`, `rosalescarwash-bot.duckdns.org`), así que un humano que siga la guía hoy configura cosas que ya no existen.

## Objetivo
Que alguien que no tocó el proyecto en 3 meses entienda en 15 minutos cómo fluye un request, dónde vive cada cosa, cómo se agrega una funcionalidad y cómo se despliega, sin leer el código entero.

## Alcance
- README: sección "Cómo funciona" (diagrama de texto del request, seguridad, datos/RLS, cola y jobs, correo, planes/módulos, agente de WhatsApp en un párrafo) y "Cómo agregar…" (ruta, módulo, migración, job) con rutas de archivo reales. Tabla "variables mínimas en producción" que remite a `.env.example`.
- Dev: que el proveedor `log` loguee en desarrollo (no en tests ni producción) el link de los correos de invitación/recuperación/verificación, o un comando que los muestre, para poder probar los flujos a mano. Documentarlo en el README. (Cambio chico en `src/platform/email/email.ts`, sin datos personales en producción.)
- TESTING.md: ya lo reescribió `tests-unitarios`; solo enlazarlo desde el README y corregir lo que haya quedado mal.
- DEPLOY.md: quitar/actualizar referencias a lavacar y nombres viejos (`whatsapp-bot`, dominio del piloto, `wa_*`), y dejar un índice al principio. Este prompt corre último: las secciones que ya reescribieron otros prompts (`ci-cd`, `rollback`, `backups`, `restore-probado`, `staging`, `dominio-y-ssl`, `uptime`, `alertas`, `error-tracking`, `logging`, etc.) no se pisan: solo el resto.

## Fuera de alcance
- Contenido de procedimientos operativos nuevos: CI/CD → `ci-cd`; rollback → `rollback`; backups/restore → `backups`, `restore-probado`; staging → `staging`.
- Documentación para usuarios finales del panel.
- Reescritura completa de TESTING.md → `tests-unitarios`.

## Pasos sugeridos
1. Leé `README.md`, `TESTING.md`, `DEPLOY.md`, `PLAN-GESTION.md`, `src/app.ts`, `src/routes.ts`, `src/jobs.ts`, `src/platform/http/router.ts`.
2. Escribí "Cómo funciona" y "Cómo agregar…"; verificá cada ruta de archivo con `ls`/grep.
3. Link de correos en dev + test unitario de que en `NODE_ENV=production` no se loguea.
4. Revisá TESTING.md; limpiá DEPLOY.md.
5. Seguí el README de cero en un clon limpio (`npm ci`, `seed:dev`, `dev`, login con `owner@demo-estetica.test`) y corregí lo que falle.

## Decisiones que el agente NO toma solo
- Ninguna.

## Criterios de aceptación
- [ ] README con "Cómo funciona" y "Cómo agregar…", todas las rutas citadas existen (`grep`).
- [ ] Siguiendo el README desde un clon limpio se entra al panel con los usuarios del seed.
- [ ] En dev, pedir recuperación de clave muestra el link en el log; en producción no (test).
- [ ] `grep -ci "lavacar\|rosalescarwash" DEPLOY.md TESTING.md` → 0 (salvo una nota histórica explícita).
- [ ] `npm run typecheck` y `npm test` en verde.
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización").

## Reglas para este trabajo
- Rama propia `prod/readme` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist de pasos humanos pendientes.
