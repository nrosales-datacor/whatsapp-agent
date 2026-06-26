# ROADMAP — Evolución a SaaS escalable

> **Este archivo es la fuente de verdad del plan de arquitectura.** No vive en el chat: vive en el repo, en git, y lo ve todo el equipo.
>
> **Cómo se mantiene:** cada vez que se completa o avanza materialmente un ítem, se actualiza su estado (la casilla) **en el mismo commit que hace el cambio**. Si aparece trabajo nuevo que no encaja en ningún ítem, se agrega. Al editar, actualizar la fecha de abajo.

**Leyenda:** ✅ hecho · 🔵 en progreso · ⬜ pendiente · 🔴 bloqueante crítico para escalar

**Última actualización:** 2026-06-26

---

## Contexto en una línea

El **código** es sólido para el piloto; lo que no escala todavía es la **topología** (un proceso en un droplet) y 3 decisiones estructurales (B1, B2, B4). Decisión: **migrar el panel a React + TS primero** (porque las features nuevas son UI-pesadas), corriendo la **cola durable (B1) en paralelo** porque es el hueco de fiabilidad más urgente. El panel y el backend están desacoplados por la API JSON `/api/panel/*` (costura estable) → se migra pantalla por pantalla sin riesgo.

---

## Carril A — Panel a React + TypeScript

> Stack: **Vite + React + TS + TanStack Query** (fijado a `5.100.14`) **+ vite-plugin-pwa** (A5). Mismo proceso Node sirve el `dist/`. Reusar tokens CSS de `src/panel/inbox.html` y los tipos de `src/types.ts`. La API `/api/panel/*` NO cambia. **React Router se difiere a B3**: hoy no hay rutas reales (login es una compuerta; ficha y dashboard son overlays), así que el panel maneja las vistas por estado; las rutas nacen con el onboarding.

- [x] ✅ **A1 — Scaffold del frontend.** Workspace `web/` (Vite+React+TS); el server sirve `web/dist` en `/panel` y `/panel/assets/*`, con **fallback a inbox.html** si no hay build (migración sin riesgo). Verificado: typecheck + build OK y los endpoints sirven el bundle. Dev: `npm run web:dev` (Vite 5173, proxy a /api). _Falta correr el build en el deploy → A6._
- [x] ✅ **A2 — Portar el sistema de diseño.** Sistema completo (tokens + `@font-face` + base + estilos de todos los componentes) portado **verbatim** de `inbox.html` a `web/src/global.css`. Fuentes servidas por el backend en `/panel/fonts/*` (con proxy en dev). `App.tsx` pasa a ser un preview estático del Login con el markup real. Verificado: build OK y `/panel` sirve el bundle con el sistema completo.
- [x] ✅ **A3 — Capa de API tipada.** `web/src/api.ts`: una función tipada por endpoint `/api/panel/*` (auth, bandeja, ficha, métricas, push) + envoltura `pedir()` con `ApiError`/`esNoAutenticado`. Reusa los tipos de `src/types.ts` vía `import type` (se borra en el build → cero acoplamiento de runtime; el bundle no cambió). Typecheck confirma tipos compartidos front/back. El cableado a la UI va en A4.
- [x] ✅ **A4 — Migrar pantallas.** Las 4 pantallas en React funcional contra la API real: **Login** (cableado a `me`/`login`/`logout`, con compuerta de sesión en `App`), **Bandeja** (lista + chat: responder y toggle bot↔humano), **Ficha CRM** (modal con historial + notas) y **Dashboard** (KPIs + barras). El polling de 4s pasó a `useQuery` con `refetchInterval`; un 401 en cualquier query/mutación cae al login (manejo global en `main.tsx`). Componentes en `web/src/components/*`, helpers en `web/src/lib/formato.ts`. Verificado: typecheck + build OK y el server sirve el bundle + responde login/me/conversaciones/ficha/métricas con los datos de demo. _Push (campana) va en A5._
- [x] ✅ **A5 — PWA con vite-plugin-pwa.** `vite-plugin-pwa` (fijado a `1.3.0`, estrategia `injectManifest`) genera el manifest (inyecta el `<link>` en el index) y compila nuestro `src/sw.ts` → `/panel/sw.js` (sin precache: passthrough + push + notificationclick, portado del sw.js viejo). La suscripción push (VAPID) vive en el hook `usePush` (registra el SW, pide permiso solo al tocar la campana, suscribe y manda prueba); la campana volvió al header (`BotonNotif`). El backend sirve `sw.js`/`manifest`/`icons` desde `web/dist` con fallback a `src/panel`. Verificado: typecheck (app + SW en `tsconfig.sw.json`) + build OK; el server sirve el SW (con `Service-Worker-Allowed`), manifest e íconos, y `/me` expone la VAPID. _El SW solo corre en el build (no en `web:dev`); la entrega real de push se prueba en el panel servido por el backend / deploy. Done de iOS/Android queda para la prueba en dispositivo._
- [x] ✅ **A6 — Servir el build + deploy.** El server ya sirve `web/dist/index.html` + assets hasheados (`/panel/assets/*`, cache `immutable`) + sw/manifest/íconos, con **fallback a `inbox.html`** si no hay build. `DEPLOY.md` actualizado: el flujo de redeploy ahora corre `npm run web:build` (instala deps de `web/` y genera `web/dist`) antes del `pm2 restart`; un deploy sin build no rompe nada (cae al panel viejo). Verificado local: `npm run web:build` desde la raíz compila el PWA completo. _Pendiente operativo: correr el redeploy en el droplet (lo hace Sebastián) para que producción quede en React._
- [ ] **A7 — Borrar `inbox.html`.** Solo tras verificar en producción. _Done:_ panel 100% React en prod.

---

## Carril B — Backend escalable

- [ ] 🔴 **B1 — Cola durable en Postgres** (`wa_jobs` + `FOR UPDATE SKIP LOCKED`). Hoy el LLM corre fire-and-forget en proceso → se pierden mensajes en vuelo ante crash/reinicio. Cierra el hueco y absorbe los reintentos actuales. **Sin UI → empezar ya, en paralelo a A.** _Done:_ un mensaje entrante sobrevive a un restart del proceso.
- [ ] 🔴 **B2 — Tenants y su config → base de datos** + tabla `usuarios`/auth del panel. Hoy `src/config/tenants.ts` está hardcodeado → alta de negocio = redeploy. Bloqueante #1 del SaaS. _Done:_ se da de alta un negocio sin tocar código.
- [ ] **B3 — Onboarding self-serve (UI en React).** Pantallas para alta de negocio, KB, servicios, credenciales. Nace en React (por eso A va primero). Depende de A y B2. _Done:_ un negocio nuevo se configura solo desde el panel.
- [ ] 🔴 **B4 — Recordatorios safe para N instancias.** `src/reminders/scheduler.ts` usa `setInterval` en cada instancia → duplicados con 2+ instancias. Necesita leader/advisory lock. _Done:_ correr 2 instancias no duplica recordatorios.
- [ ] **B5 — Observabilidad + CI/CD.** Sentry (errores), uptime monitor, métricas (msg/s, latencia LLM, profundidad de cola), backups verificados. Pipeline en vez de `git pull && pm2 restart`. _Done:_ alertas activas y deploy automatizado.

---

## Fiabilidad / hardening

- [x] ✅ **Reintentos con backoff en envíos a WhatsApp** + aviso al operador si falla + manejo de multimedia (commit `d4e1624`). _Nota: parche en la capa de envío; NO sobrevive a muerte del proceso — eso lo cierra B1._

---

## Pendientes operativos (piloto Lavacar Rosales)

- [ ] **Cambiar la contraseña temporal del panel** (`lavacar2026`, débil). Generar hash con `npx tsx scripts/hashPassword.ts` y setear `PANEL_PASSWORD_HASH_ROSALES`.
- [ ] **Plantilla de WhatsApp** (Utility, 3 variables) para recordatorios fuera de 24h — esperando aprobación de Meta. Setear `WHATSAPP_TEMPLATE_RECORDATORIO`.
- [ ] **Promos / difusión** (marketing segmentado): requiere plantilla MARKETING aprobada, costo por mensaje y opt-out. Sin empezar.

---

## Notas de contexto

- Límites de WhatsApp (throughput ~80 msg/s ampliable a 1000; tiers 250→ilimitado) son **por número/WABA = por tenant** → se reparten solos, no son un techo compartido.
- Mensajes de servicio (cliente inicia, <24h) son **gratis**; el costo variable real es **OpenAI** + templates utility/marketing.
