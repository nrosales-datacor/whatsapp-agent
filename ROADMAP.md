# ROADMAP — Evolución a SaaS escalable

> **Este archivo es la fuente de verdad del plan de arquitectura.** Vive en el repo, en git, y lo ve todo el equipo.
>
> **Cómo se mantiene:** cada vez que se completa o avanza materialmente un ítem, se actualiza su estado **en el
> mismo commit que hace el cambio**. Si aparece trabajo nuevo que no encaja en ningún ítem, se agrega. Al editar,
> se actualiza la fecha de abajo. **Una línea por ítem**: el porqué y el cómo van en el commit, en el código y, si
> hace falta, en un plan aparte — no acá.
>
> **Historial:** el ROADMAP completo hasta el 2026-10-04 (con el detalle de cada ítem al cerrarlo) está en
> [`docs/archivo/ROADMAP-hasta-2026-10-04.md`](docs/archivo/ROADMAP-hasta-2026-10-04.md).

**Leyenda:** ✅ hecho · 🔵 en progreso · ⬜ pendiente · 🔴 bloqueante crítico para escalar

**Última actualización:** 2026-10-19 — Carril I, I0.2–I0.3: el dominio viejo pasa a `legacy/` (fuera del build), la
plataforma a `src/platform/` en inglés, esquema de plataforma (`leader_leases`, `audit_log`, rol `app_runtime`) con
migración base nueva y servidor nuevo mínimo (rama `i0/platform`).
Antes, 2026-10-19 — Carril I: reestructura a software de gestión multi-sucursal y multi-rubro
(plan acordado en [`PLAN-GESTION.md`](PLAN-GESTION.md); nombre provisional "Selyon CRM"; I0 arrancó en la rama `carril-i`).
Antes, 2026-10-10 — E14: chequeo rápido de producción (`scripts/verificarProduccion.ts`).
Antes, 2026-10-04 — Carril H (auditoría de arquitectura): ráfagas que descartaban
fotos/BAJA/confirmaciones, F1 RLS en código, bandeja paginada, deploy con artefacto + apagado ordenado,
verificación de restore, una sola implementación de datos (PGlite en dev/tests), refactor de
`handleWebhook` y `router.ts`, ROADMAP compactado. Antes: G17 (E2E con base de datos, otra sesión).

---

## Contexto en una línea

**El producto se reestructura** (Carril I): pasa de agente de WhatsApp para lavacar a software de gestión para
negocios con cita (dental, estética, uñas), multi-sucursal, con WhatsApp IA como módulo. Se conserva la plataforma
(RLS, colas, red, observabilidad, deploy) y se rehace el dominio sobre un esquema nuevo sin prefijo `wa_`.

## Carril I — Reestructura a software de gestión ([`PLAN-GESTION.md`](PLAN-GESTION.md))

- [x] ✅ **I-plan — Análisis de brechas, veredicto de arquitectura, modelo de datos, planes y fases.** Acordado: Básico = agente de WhatsApp, Pro = gestión completa (con o sin agente), identificadores en inglés, nombre provisional "Selyon CRM".
- [ ] 🔵 **I0 — Cimientos** (rama `carril-i`, pasos en `PLAN-GESTION.md` §10; I0.1–I0.3 hechos: dominio viejo en `legacy/`, plataforma en `src/platform/` en inglés, migración base nueva con `app_runtime` y `btree_gist`, servidor mínimo). Tag del estado actual, Supabase nuevo, módulos por dominio, router declarativo + Zod + permisos, esquema base con RLS, caché nuevo, correo de plataforma, login por email, sin lavacar ni `wa_`, identificadores en inglés.
- [ ] ⬜ **I1 — Núcleo del Básico.** Disponibilidad con horario por profesional, buffers, varios servicios y `EXCLUDE`; Agenda, profesionales, ficha del cliente, navegación nueva, Inicio básico, plantillas de rubro.
- [ ] ⬜ **I2 — Agente y lanzamiento del Básico.** Agente sobre los servicios del núcleo, bandeja, recordatorios por WhatsApp y correo, superadmin y alta de negocios portados, planes y límites, cobro manual.
- [ ] ⬜ **I3 — CRM y equipo (Pro).** Estados configurables, campos personalizados, CSV, usuario por profesional con roles, varias sucursales.
- [ ] ⬜ **I4 — Ventas y comisiones (Pro).** Pagos y señas, pendientes, resumen del día, comisiones sobre lo cobrado, liquidaciones.
- [ ] ⬜ **I5 — Reportes e Inicio completo (Pro).** Rango de fechas, por sucursal/profesional/servicio/canal, export CSV, `daily_usage`.
- [ ] ⬜ **I6 — Crecimiento.** Campañas, rescate, upsell y reseñas portados, marca propia, Stripe (absorbe C4.3), alta self-service.

## Próximos pasos operativos (no son código)

1. 🔴 **Probar un restore** con `scripts/verificarRestore.ts` (DEPLOY.md §19.2). Cierra B5/E14.
2. 🔴 **Activar F1 en producción**: login del rol `app_wa` + repuntar `DATABASE_URL` (DEPLOY.md §24). Requiere el paso 1.
3. Cargar el secret `DEPLOY_HOST_KEY` y migrar PM2 a `ecosystem.config.cjs` (DEPLOY.md §15 y §6).

---

## Carril H — Auditoría de arquitectura (2026-10-04)

- [x] ✅ **H1 — Ráfagas: la agrupación descartaba fotos, audios y acciones directas.** Un job viejo solo cede si es un texto común (`agrupable`) ante un turno del agente que relee el historial (`releeHistorial`); BAJA, "Confirmo", consentimiento, post-servicio, pedir persona, fotos y audios se procesan siempre. Tests: `test/reliability/rafagaAcciones.test.ts`.
- [x] ✅ **H2 — Cola: conversación en columna indexada y payload sin historial duplicado.** `wa_jobs.conversacion_id` (+ índice) reemplaza `payload->'conv'->>'id'`; el payload ya no copia los 20 mensajes dos veces; el worker relee el modo antes de responder y descarta jobs de conversaciones borradas.
- [x] ✅ **H3 — F1 en código (ver F1).** Políticas RLS en todas las tablas para el rol `app_wa`, `tenant_id` en `wa_mensajes`, y todo el acceso a datos con `conTenant`/`conSistema` (`src/db/alcance.ts`). `test/security/rlsAplicado.test.ts` corre la app entera con el rol sin bypass. Falta el paso operativo (arriba).
- [x] ✅ **H4 — Bandeja a escala.** Listado paginado ("Ver más") y búsqueda en el servidor sobre `wa_conversaciones.ultima_actividad_en` (trigger + índice); acciones del chat con lectura liviana; caché de URLs firmadas (el chat ya no re-firma ni re-descarga las fotos cada 4 s); "cita próxima" con el *hoy* del negocio (antes UTC). Índices nuevos en `wa_mensajes` y `wa_citas`.
- [x] ✅ **H5 — Deploy.** Panel compilado en CI y subido como artefacto; se despliega el commit exacto que pasó CI; `npm ci --omit=dev`; llave del host fijable (`DEPLOY_HOST_KEY`); `pm2 reload` + apagado ordenado (`src/red/apagado.ts`, `ecosystem.config.cjs`): los turnos en curso terminan en vez de repetirse.
- [ ] 🔵 **H6 — Restore verificable.** `scripts/verificarRestore.ts` restaura un volcado en una base aparte y compara conteos y migraciones. Falta correrlo (paso operativo 1).
- [x] ✅ **H7 — Una sola implementación de los datos.** Se eliminó `RepositorioEnMemoria`: dev, E2E y evals corren sobre Postgres en el proceso (PGlite); producción exige `DATABASE_URL`. La migración de los tests destapó divergencias reales (FK de push, reloj de la base).
- [x] ✅ **H8 — `handleWebhook`: un solo pipeline del turno del agente** (`turnoDelAgente`), acciones directas y traspaso factorizados (antes, el bloque escalar/enviar/guardar estaba copiado 3 veces).
- [x] ✅ **H9 — `router.ts` dividido** en `src/panel/{http,sesion,comun,estaticos}.ts` y `src/panel/rutas/*` (un módulo por recurso); `router.ts` queda como orquestador.
- [ ] 🔵 **H10 — Tests más rápidos.** Hecho: plantilla PGlite migrada una vez y cacheada en disco; una base por archivo vaciada con TRUNCATE (ya no se queda sin memoria el WASM); timeout por test. Falta: el total sigue en ~16 min (661 tests) porque el arranque de PGlite por archivo, en paralelo, domina; siguiente paso: compartir una base por worker o correr los archivos de DB en serie.
- [x] ✅ **H11 — ROADMAP compactado** (este archivo); el detalle histórico quedó archivado.
- [x] ✅ **H13 — `validarHorario` estricto.** Un horario que no es objeto (p. ej. un string en `POST /config`) se tomaba como "ausente" y reemplazaba el horario del negocio por el default sin avisar; ahora es 400.
- [ ] ⬜ **H12 — Pendientes de la auditoría (no incluidos en esta tanda).** Reproceso de `wa_webhooks_crudos` que descarta a los ~5 min de un negocio sin alta; dependencia `stripe` sin uso y `plan ?? "pro"` que falla abierto; tools sin `strict` y errores internos devueltos al modelo; un solo proveedor de LLM sin fallback; superadmin compartido (sin cuentas por persona) con 2FA opcional; catálogo en JSONB sin FK desde las citas; `console.*` vs. log estructurado; comentarios-bitácora en el resto del código.

## Carril A — Panel a React + TypeScript ✅

- [x] ✅ A1 Scaffold · A2 sistema de diseño · A3 API tipada · A4 pantallas · A5 PWA · A6 build en deploy · A7 borrar `inbox.html`
- [x] ✅ A8 rediseño (dark mode, lead score) · A9 bandeja/panel · A9b–A9g Mi negocio, Agenda, Ficha, Login, estados vacíos, Usuarios

## Carril B — Backend escalable

- [x] ✅ B1 cola durable · B2 tenants en la base · B3 onboarding · B4 recordatorios multi-instancia · B6/B7/B8 motor multi-mercado
- [ ] 🔵 **B5 — Observabilidad + CI/CD.** ✅ pipeline, Sentry, uptime, métricas. 🔵 Backups: script, cron y verificador listos; falta el restore probado (H6).

## Carril C — Valor de producto

- [x] ✅ C1.1–C1.5 (reprogramar, interactivos, confirmación, voz, fotos) · C2.1–C2.3 (agenda, config, multi-operador) · C3.1–C3.3 (reseñas, campañas, dashboard) · C4.1 white-label · C4.2 Embedded Signup · C4.4 landing
- [ ] 🔵 **C4.3 — Facturación Stripe + planes.** Gating por plan hecho; falta conectar Checkout/Portal/webhook (`src/billing/stripe.ts` no se usa todavía) y la pestaña de facturación.

## Carril D — Plan comercial Básico + Pro

- [x] ✅ Fase 0 (gating, uso mensual, ventana 24 h, reset de clave, cobro manual) · Fase 1 (rescate de cotizaciones, upsell, reseñas)
- [ ] ⬜ Backlog: solo por demanda de un cliente que pague (ver `PLAN-FEATURES-FALTANTES.md`).

## Carril E — Hardening multi-cliente (bloque A de `AUDIT.md`)

- [x] ✅ E1–E13, E15 (timeouts, seed, horarios pasados, Calendar por negocio, ráfagas, login, worker concurrente, plantillas por tenant, botones de plantilla, health check, textos por registro, tipos de mensaje, revocación de sesiones, agenda multi-empleado)
- [ ] 🔴 **E14 — Backups + Sentry + uptime verificados en producción.** Se cierra con H6. `scripts/verificarProduccion.ts` (`npm run verificar:produccion`, DEPLOY.md §19.3) chequea en el droplet Sentry, cron, backup reciente y copia externa; falta correrlo allá junto con el restore.

## Carril F — Escala a 50 tenants (`PLAN-ESCALA-MULTITENANT.md`)

- [ ] 🔵 **F1 — Row Level Security.** Código, políticas y tests hechos (H3); falta activar el rol `app_wa` en producción (DEPLOY.md §24).
- [x] ✅ F2 tokens cifrados · F3 ingesta cruda · F4 escrituras scopeadas · F5 token global fail-closed · F6 web/worker · F7 pool único · F8 fairness · F9 fotos en Storage · F10 cuotas · F11 DLQ · F12 scheduler · F13 costo LLM · F16 offboarding · F17 deploy/rollback
- [ ] 🔵 **F14 — Observabilidad por tenant.** Hecho: log JSON + correlationId + métricas por tenant + 1 alerta SLO. Falta: migrar los `console.*`, `/metricas` Prometheus, métricas persistidas.
- [ ] 🔵 **F15 — Config versionada.** Backend listo; falta la UI de historial.

## Carril G — Revisión pre-venta (2026-10-01) ✅

- [x] ✅ G1–G16 (cookie malformada, RLS sin políticas, payload agrupado, "persona", cita confirmada, tope de cuerpo, precio del catálogo, backups, gate de deploy, techo de costo, alertas, operación de plataforma, consentimiento, producto LLM, seguridad, higiene)
- [x] ✅ **G17 — E2E completo con base de datos (Playwright, proyecto `db`) + 8 bugs que destapó.**

## Pendientes operativos (piloto)

> **Obsoletos (2026-10-19):** el piloto del lavacar termina (Carril I). Las plantillas de Meta se vuelven a pedir
> por negocio en I2.

- [ ] Cambiar la contraseña temporal del panel del piloto.
- [ ] Plantilla de recordatorio aprobada por Meta (`GUIA-META.md` §A).
- [ ] Plantilla MARKETING aprobada para poder enviar campañas reales (`GUIA-META.md` §C).

## Notas de contexto

- Límites de WhatsApp (throughput y tiers) son **por número = por tenant**: se reparten solos.
- Planes activos: `PLAN-ESCALA-MULTITENANT.md` (F), `PLAN-FEATURES-FALTANTES.md` (D), `PLAN-PREVENTA.md`. Hallazgos detallados: `AUDIT.md`.
