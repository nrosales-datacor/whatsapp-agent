# ROADMAP — Evolución a SaaS escalable

> **Este archivo es la fuente de verdad del plan de arquitectura.** No vive en el chat: vive en el repo, en git, y lo ve todo el equipo.
>
> **Cómo se mantiene:** cada vez que se completa o avanza materialmente un ítem, se actualiza su estado (la casilla) **en el mismo commit que hace el cambio**. Si aparece trabajo nuevo que no encaja en ningún ítem, se agrega. Al editar, actualizar la fecha de abajo.

**Leyenda:** ✅ hecho · 🔵 en progreso · ⬜ pendiente · 🔴 bloqueante crítico para escalar

**Última actualización:** 2026-06-25

---

## Contexto en una línea

El **código** es sólido para el piloto; lo que no escala todavía es la **topología** (un proceso en un droplet) y 3 decisiones estructurales (B1, B2, B4). Decisión: **migrar el panel a React + TS primero** (porque las features nuevas son UI-pesadas), corriendo la **cola durable (B1) en paralelo** porque es el hueco de fiabilidad más urgente. El panel y el backend están desacoplados por la API JSON `/api/panel/*` (costura estable) → se migra pantalla por pantalla sin riesgo.

---

## Carril A — Panel a React + TypeScript

> Stack: **Vite + React + TS + TanStack Query + vite-plugin-pwa + React Router.** Mismo proceso Node sirve el `dist/`. Reusar tokens CSS de `src/panel/inbox.html` y los tipos de `src/types.ts`. La API `/api/panel/*` NO cambia.

- [ ] **A1 — Scaffold del frontend.** Workspace `web/` con Vite+React+TS; el server sirve `web/dist` en `/panel`. _Done:_ `npm run build` genera el bundle y se sirve.
- [ ] **A2 — Portar el sistema de diseño.** Mover los tokens Swiss-minimal (variables CSS de `inbox.html`) a un `global.css`. Sin rediseño. _Done:_ look idéntico al actual.
- [ ] **A3 — Capa de API tipada.** `api.ts` con funciones por endpoint `/api/panel/*`, reusando tipos de `src/types.ts`. _Done:_ front y back comparten tipos.
- [ ] **A4 — Migrar pantallas.** Login → Inbox (lista+chat) → Ficha CRM → Dashboard. El polling 4s pasa a `useQuery` con `refetchInterval`. _Done:_ las 4 pantallas contra la API real.
- [ ] **A5 — PWA con vite-plugin-pwa.** Generar SW + manifest; portar la suscripción push (VAPID) a un hook. Mismos endpoints push. _Done:_ instalable + push OK en iOS/Android.
- [ ] **A6 — Servir el build + deploy.** Server sirve `dist/index.html` + assets hasheados (cache largo). Agregar `npm run build` al flujo de `DEPLOY.md`. _Done:_ deploy nuevo documentado y probado.
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
