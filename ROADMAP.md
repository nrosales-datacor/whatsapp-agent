# ROADMAP — Evolución a SaaS escalable

> **Este archivo es la fuente de verdad del plan de arquitectura.** No vive en el chat: vive en el repo, en git, y lo ve todo el equipo.
>
> **Cómo se mantiene:** cada vez que se completa o avanza materialmente un ítem, se actualiza su estado (la casilla) **en el mismo commit que hace el cambio**. Si aparece trabajo nuevo que no encaja en ningún ítem, se agrega. Al editar, actualizar la fecha de abajo.

**Leyenda:** ✅ hecho · 🔵 en progreso · ⬜ pendiente · 🔴 bloqueante crítico para escalar

**Última actualización:** 2026-07-03 (A8 completo — Fase 4 de verificación hecha con 3 fixes)

---

## Contexto en una línea

El **código** es sólido para el piloto; lo que no escala todavía es la **topología** (un proceso en un droplet) y 3 decisiones estructurales (B1, B2, B4). Decisión: **migrar el panel a React + TS primero** (porque las features nuevas son UI-pesadas), corriendo la **cola durable (B1) en paralelo** porque es el hueco de fiabilidad más urgente. El panel y el backend están desacoplados por la API JSON `/api/panel/*` (costura estable) → se migra pantalla por pantalla sin riesgo.

---

## Carril A — Panel a React + TypeScript

> Stack: **Vite + React + TS + TanStack Query** (fijado a `5.100.14`) **+ vite-plugin-pwa** (A5). Mismo proceso Node sirve el `dist/`. Reusar tokens CSS de `src/panel/inbox.html` y los tipos de `src/types.ts`. La API `/api/panel/*` NO cambia. **React Router entró en B3** (con el onboarding): el operador vive en `/` y el admin en `/admin` (`basename=/panel`). El panel del operador sigue manejando ficha/dashboard como overlays por estado.

- [x] ✅ **A1 — Scaffold del frontend.** Workspace `web/` (Vite+React+TS); el server sirve `web/dist` en `/panel` y `/panel/assets/*`, con **fallback a inbox.html** si no hay build (migración sin riesgo). Verificado: typecheck + build OK y los endpoints sirven el bundle. Dev: `npm run web:dev` (Vite 5173, proxy a /api). _Falta correr el build en el deploy → A6._
- [x] ✅ **A2 — Portar el sistema de diseño.** Sistema completo (tokens + `@font-face` + base + estilos de todos los componentes) portado **verbatim** de `inbox.html` a `web/src/global.css`. Fuentes servidas por el backend en `/panel/fonts/*` (con proxy en dev). `App.tsx` pasa a ser un preview estático del Login con el markup real. Verificado: build OK y `/panel` sirve el bundle con el sistema completo.
- [x] ✅ **A3 — Capa de API tipada.** `web/src/api.ts`: una función tipada por endpoint `/api/panel/*` (auth, bandeja, ficha, métricas, push) + envoltura `pedir()` con `ApiError`/`esNoAutenticado`. Reusa los tipos de `src/types.ts` vía `import type` (se borra en el build → cero acoplamiento de runtime; el bundle no cambió). Typecheck confirma tipos compartidos front/back. El cableado a la UI va en A4.
- [x] ✅ **A4 — Migrar pantallas.** Las 4 pantallas en React funcional contra la API real: **Login** (cableado a `me`/`login`/`logout`, con compuerta de sesión en `App`), **Bandeja** (lista + chat: responder y toggle bot↔humano), **Ficha CRM** (modal con historial + notas) y **Dashboard** (KPIs + barras). El polling de 4s pasó a `useQuery` con `refetchInterval`; un 401 en cualquier query/mutación cae al login (manejo global en `main.tsx`). Componentes en `web/src/components/*`, helpers en `web/src/lib/formato.ts`. Verificado: typecheck + build OK y el server sirve el bundle + responde login/me/conversaciones/ficha/métricas con los datos de demo. _Push (campana) va en A5._
- [x] ✅ **A5 — PWA con vite-plugin-pwa.** `vite-plugin-pwa` (fijado a `1.3.0`, estrategia `injectManifest`) genera el manifest (inyecta el `<link>` en el index) y compila nuestro `src/sw.ts` → `/panel/sw.js` (sin precache: passthrough + push + notificationclick, portado del sw.js viejo). La suscripción push (VAPID) vive en el hook `usePush` (registra el SW, pide permiso solo al tocar la campana, suscribe y manda prueba); la campana volvió al header (`BotonNotif`). El backend sirve `sw.js`/`manifest`/`icons` desde `web/dist` con fallback a `src/panel`. Verificado: typecheck (app + SW en `tsconfig.sw.json`) + build OK; el server sirve el SW (con `Service-Worker-Allowed`), manifest e íconos, y `/me` expone la VAPID. _El SW solo corre en el build (no en `web:dev`); la entrega real de push se prueba en el panel servido por el backend / deploy. Done de iOS/Android queda para la prueba en dispositivo._
- [x] ✅ **A6 — Servir el build + deploy.** El server ya sirve `web/dist/index.html` + assets hasheados (`/panel/assets/*`, cache `immutable`) + sw/manifest/íconos, con **fallback a `inbox.html`** si no hay build. `DEPLOY.md` actualizado: el flujo de redeploy ahora corre `npm run web:build` (instala deps de `web/` y genera `web/dist`) antes del `pm2 restart`; un deploy sin build no rompe nada (cae al panel viejo). Verificado local: `npm run web:build` desde la raíz compila el PWA completo. _Pendiente operativo: correr el redeploy en el droplet (lo hace Sebastián) para que producción quede en React._
- [x] ✅ **A7 — Borrar `inbox.html`.** Panel verificado en producción (bundle React `/panel/assets/index-*.js` confirmado vivo). `src/panel/inbox.html` eliminado del repo; el servidor sirve solo `web/dist` — sin build → 503 con mensaje claro (en vez del fallback silencioso).
- [x] ✅ **A8 — Rediseño visual del panel según mockup Lavacar (dark mode, lead score, dashboard rico).** Paleta verde + tokens white-label en `global.css`; Noto Sans self-hosted; modo claro/oscuro (`lib/tema.ts` + toggle en header); lead score heurístico por conversación; deltas de KPI en métricas; badge cita + servicio por conversación; búsqueda + filtros pill en bandeja; acciones rápidas (agendar, cotización, atendido) + toasts; horas pico verticales en dashboard. _Fase 4 (verificación) ✅: design-verify con Playwright en 390/1440px × claro/oscuro (20 capturas), flujo real end-to-end (login → chat → responder → toggle → acciones rápidas → ficha → dashboard), PWA (sw.js + `Service-Worker-Allowed` + manifest) y regresión admin. Fixes de la verificación: marca del header oculta en móvil (se truncaba), `color-scheme` por tema (inputs nativos/checkboxes en dark), toast de acciones rápidas ya no es optimista (solo en éxito). Pendiente de validar en dispositivo real: entrega de push iOS/Android._ Ver `PLAN-REDISENO-PANEL.md`.

---

## Carril B — Backend escalable

- [x] ✅ **B1 — Cola durable en Postgres** (`wa_jobs` + `FOR UPDATE SKIP LOCKED`). Tabla `wa_jobs` en el esquema (migración `0006_daily_nomad.sql`). Fase 1 del webhook guarda el mensaje **y** encola el job en una sola transacción antes de responder 200 (`guardarEntranteYEncolar`). `src/queue/cola.ts`: `reclamarUno` (claim con `FOR UPDATE SKIP LOCKED`), backoff exponencial, reaper. `src/queue/worker.ts`: loop serial (1 job a la vez; preserva orden) + reaper cada 60s. Sin DB → comportamiento inline previo (dev local sin cambios). _Done:_ un mensaje entrante sobrevive a un restart del proceso; el worker retoma el job pendiente.
- [x] ✅ **B2 — Tenants y su config → base de datos** + tabla `usuarios`/auth del panel. Tablas `wa_tenants` (config rica como JSONB: horario/servicios/kb + `phone_number_id` único para ruteo) y `wa_usuarios` (login del panel). Se leen vía un **caché en memoria** (`src/config/tenantStore.ts`, accesores síncronos para el hot path) que carga de la base, se refresca cada ~60s y **on-demand** ante un número nuevo (alta sin redeploy), con **fallback hardcodeado** si la base está vacía/caída → la migración no puede causar outage. Login pasa a `usuario → wa_usuarios → tenant` (la sesión sigue firmando `tenant.id`). Seed idempotente `scripts/seedTenants.ts` + DEPLOY.md con orden seguro. Verificado: typecheck + path en memoria (login/me/anti-timing). _Pendiente: la verificación contra Postgres real ocurre en el deploy sembrado (no hay Docker local); el fallback la cubre. El alta self-serve por UI es B3._
- [x] ✅ **B3 — Onboarding (UI en React, operado por admin).** Área de superadmin en `/panel/admin` (auth por `.env` `PANEL_SUPERADMIN_*`, sesión/cookie aparte `panel_admin_sesion` — no toca el login operador). API `/api/panel/admin/*` (login, me, logout, listar/crear negocios) con CSRF + validación server-side + 409 por duplicados; `crearTenant` transaccional en el store + recarga del caché → el negocio queda vivo sin redeploy. Acá entró **React Router** (`basename=/panel`: `/` operador, `/admin` onboarding) + **fallback SPA** en el server para los deep-links. Formulario MVP (datos + servicios + horario + KB en bloques de texto + usuario). Verificado local: typecheck + build + flujo admin/CSRF/no-sombra/regresión operador (alta real requiere base → se valida en el deploy). _MVP: el alta es por admin (no signup público); editar/borrar negocios y conectar WhatsApp por Embedded Signup quedan para más adelante._
- [x] ✅ **B4 — Recordatorios safe para N instancias.** Reemplazado el patrón "leer-y-marcar" (carrera read→write con N instancias) por **claim atómico** (`reclamarRecordatorio`: `UPDATE ... WHERE col IS NULL RETURNING id`). Si el envío falla, `revertirRecordatorio` pone la columna a NULL para reintentar. Sin migración nueva (reutiliza `recordatorio_dia_antes_en`/`recordatorio_mismo_dia_en`). Pooler-safe (no usa advisory locks de sesión). _Done:_ correr 2 instancias no duplica recordatorios.
- [ ] **B5 — Observabilidad + CI/CD.** Sentry (errores), uptime monitor, métricas (msg/s, latencia LLM, profundidad de cola), backups verificados. Pipeline en vez de `git pull && pm2 restart`. _Done:_ alertas activas y deploy automatizado.

---

## Carril C — Valor de producto (plan detallado: `PLAN-VALOR-PRODUCTO.md`)

> Features que hacen que la app destaque y se venda: experiencia WhatsApp de primera, panel como
> centro de operaciones del dueño, motor de crecimiento (reseñas/campañas) y maquinaria SaaS.
> El orden de prioridad y el detalle de cada ítem viven en el plan.

- [ ] **C1.1 — Reprogramar/cancelar cita por el bot** (herramientas nuevas + sync Calendar).
- [ ] **C1.2 — Mensajes interactivos** (botones y listas nativas de WhatsApp, sin deps nuevas).
- [ ] **C1.3 — Recordatorio con confirmación** (anti no-show; cita confirmada visible en panel).
- [ ] **C1.4 — Notas de voz** (transcripción con el SDK de OpenAI ya instalado).
- [ ] **C1.5 — Fotos → cotización con visión** (+ imágenes visibles en el chat del panel).
- [ ] **C2.1 — Vista Agenda en el panel** (citas por día/semana + cita manual + estados).
- [ ] **C2.2 — Configuración self-service del negocio** (servicios/precios/horario/bloqueos/KB).
- [ ] **C2.3 — Estados de conversación + multi-operador por tenant** (roles dueño/operador).
- [ ] **C3.1 — Post-servicio + reseñas de Google** (intercepta malas experiencias antes de la reseña).
- [ ] **C3.2 — Campañas segmentadas** (plantilla MARKETING + opt-out; absorbe el pendiente "Promos").
- [ ] **C3.3 — Dashboard de dueño** (ingresos, no-shows, ahorro del bot).
- [ ] **C4.1 — White-label real por tenant** (marca/colores/logo desde la config; los tokens `--brand-*` de A8 ya lo preparan).
- [ ] **C4.2 — Embedded Signup de Meta** (conectar WhatsApp self-serve; tramitar el review temprano — pasos del trámite en `GUIA-META.md` §B).
- [ ] **C4.3 — Facturación Stripe + planes** (única dependencia npm nueva prevista del carril).
- [ ] **C4.4 — Landing de venta** (el bot de ventas como demo del producto).

## Fiabilidad / hardening

- [x] ✅ **Reintentos con backoff en envíos a WhatsApp** + aviso al operador si falla + manejo de multimedia (commit `d4e1624`). _Nota: parche en la capa de envío; NO sobrevive a muerte del proceso — eso lo cierra B1._
- [x] ✅ **Escalada a humano cuando el bot no puede resolver.** Herramienta `escalar_a_humano` (el bot la llama ante una pregunta del negocio que no puede contestar, un reclamo o un caso especial; también al trabarse el tool-loop): la conversación pasa a modo humano + notificación push al operador, en vez de una respuesta vaga/genérica. Los pedidos fuera del lavacar siguen con la deflección amable (no escalan, para no spamear al operador). Verificado en vivo (gpt-4o-mini) con los 3 casos.

---

## Pendientes operativos (piloto Lavacar Rosales)

- [ ] **Cambiar la contraseña temporal del panel** (`lavacar2026`, débil). Generar hash con `npx tsx scripts/hashPassword.ts` y setear `PANEL_PASSWORD_HASH_ROSALES`.
- [ ] **Plantilla de WhatsApp** (Utility, 3 variables) para recordatorios fuera de 24h — esperando aprobación de Meta. Setear `WHATSAPP_TEMPLATE_RECORDATORIO`. _Pasos exactos en `GUIA-META.md` §A._
- [ ] **Redeploy pendiente en el droplet** (lo corre Sebastián): producción aún NO tiene B1–B4 ni el panel rediseñado — la tabla `wa_jobs` no existe en la base (verificado 2026-07-03), señal de que `migrar.ts` no corre desde antes de B1. El flujo de DEPLOY.md (pull → install → migrar → seed → web:build → pm2 restart) deja todo al día.
- [ ] **Promos / difusión** (marketing segmentado): requiere plantilla MARKETING aprobada, costo por mensaje y opt-out. Sin empezar. _Absorbido por **C3.2** del Carril C._

---

## Notas de contexto

- Límites de WhatsApp (throughput ~80 msg/s ampliable a 1000; tiers 250→ilimitado) son **por número/WABA = por tenant** → se reparten solos, no son un techo compartido.
- Mensajes de servicio (cliente inicia, <24h) son **gratis**; el costo variable real es **OpenAI** + templates utility/marketing.
