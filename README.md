# Selyon CRM

> **Nombre provisional.** Software de gestión para negocios de servicios con cita (dentistas, estéticas, uñas y
> similares), multi-sucursal, con un **agente de WhatsApp con IA** como módulo. Está en reestructura (Carril I): el
> plan, la arquitectura y las fases están en [`PLAN-GESTION.md`](PLAN-GESTION.md) y el estado de cada ítem en
> [`ROADMAP.md`](ROADMAP.md). La versión anterior (agente de WhatsApp para lavacar) quedó en el tag
> `whatsapp-agent-final` (los comentarios que citan `legacy/…` se refieren a ese tag).

**Stack:** TypeScript · Node 24 (`node:http`, sin framework) · Postgres (Supabase en producción, PGlite en desarrollo y
tests) · Drizzle · Zod · React 19 + Vite + TanStack Query (PWA) · OpenAI · WhatsApp Cloud API.

---

## Entorno de prueba local

### 1. Requisitos e instalación

- Node 24 (`.nvmrc`) y Git.

```bash
npm ci
```

```bash
npm --prefix web ci
```

### 2. Configuración (`.env`)

Copiá `.env.example` a `.env`. **Sin `DATABASE_URL` la app usa un Postgres dentro del proceso (PGlite)**: no hace falta
instalar Postgres. Para que los datos sobrevivan entre arranques y que el seed y el servidor compartan la base, dejá
en el `.env`:

```dotenv
PGLITE_DIR=.pglite
# Sesiones estables entre reinicios (sin esto, cada arranque invalida las sesiones):
PANEL_SESSION_SECRET=una-cadena-larga-al-azar-de-al-menos-32-caracteres
# Necesaria para activar 2FA en local (64 caracteres hex):
TOKENS_ENCRYPTION_KEY=
```

Para generar la clave de cifrado:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Datos demo

Crea (o recrea) un negocio de estética con 2 sucursales, profesionales con horario, servicios de la plantilla del
rubro, clientes y citas de esta semana:

```bash
npm run seed:dev
```

### 4. Levantar la app

Backend (API, landing y panel compilado) en `http://localhost:3000`, con recarga al guardar:

```bash
npm run dev
```

El panel en `http://localhost:3000/panel/` es el compilado: para verlo ahí, compilalo antes con
`npm --prefix web run build`. Para trabajar en el panel conviene el modo desarrollo de abajo.

Panel en modo desarrollo en `http://localhost:5173/panel/` (recarga en caliente; las llamadas a `/api` van al backend
del puerto 3000, así que tiene que estar corriendo):

```bash
npm run web:dev
```

**Panel sin backend (modo mock):** API simulada en el navegador, ideal para revisar pantallas. Abre en
`http://localhost:5173/panel/`:

```bash
npm --prefix web run dev:mock
```

### 5. Usuarios de prueba

**Contra el backend real** (después de `npm run seed:dev`), en `http://localhost:5173/panel/login` o
`http://localhost:3000/panel/login`:

| Usuario | Clave | Rol |
|---|---|---|
| `owner@demo-estetica.test` | `demo1234` | Dueña (ve todo) |
| `recepcion@demo-estetica.test` | `demo1234` | Recepción, solo sucursal Escazú |
| `ana@demo-estetica.test` | `demo1234` | Especialista: solo su agenda |

**En modo mock** (`dev:mock`), todas con clave `demo1234`; el código de 2FA es `123456`:

| Usuario | Para probar |
|---|---|
| `duena@demo.test` | Dueña, plan Pro, 2 sucursales y 2 negocios |
| `basico@demo.test` | Plan Básico (Ventas, Reportes y Campañas con candado) |
| `sinagente@demo.test` | Pro sin agente (sin WhatsApp IA) |
| `recepcion@demo.test` | Recepción, fija a una sucursal |
| `profesional@demo.test` | Profesional (Mi agenda) |
| `2fa@demo.test` | Dueña con 2FA |
| `temporal@demo.test` | Clave temporal (cambio obligatorio) |
| `sinnegocio@demo.test` | Cuenta sin negocio activo (no entra) |
| `pausada@demo.test` | Negocio pausado por el superadmin (no entra) |
| `pago@demo.test` | Negocio pausado por falta de pago (entra solo a pagar) |

Otros atajos del mock: invitación nueva en `/panel/accept-invitation?token=demo`, invitación a una cuenta existente con
`?token=cuenta-existente`, link de recuperación vencido con `/panel/reset-password?token=vencido`, y superadmin en
`/panel/admin/login` con usuario `admin` / `demo1234`.

**Superadmin contra el backend real** (alta de negocios): poné en el `.env` `PANEL_SUPERADMIN_USERNAME` y
`PANEL_SUPERADMIN_HASH` con el hash que imprime este comando, y entrá en `/panel/admin/login`:

```bash
npx tsx scripts/hashPassword.ts "tu-clave"
```

> En local el correo usa el proveedor `log`: los correos (invitaciones, recuperación, recordatorios) no salen ni se
> muestran con su link. Para probar esos flujos de punta a punta están los tests.

### 6. Tests y chequeos

Backend completo (unitarios, seguridad, confiabilidad y arquitectura, sobre PGlite):

```bash
npm test
```

E2E del panel con Playwright (compila el panel; la primera vez instalá el navegador con
`npx playwright install chromium`):

```bash
npm run test:e2e
```

Solo el E2E del panel en modo mock:

```bash
npx playwright test --project panel-mock
```

Chequeos que corre el CI:

```bash
npm run typecheck
```

```bash
npm --prefix web run typecheck
```

```bash
npm run db:check
```

```bash
npm run ci:env
```

```bash
npm run ci:versions
```

---

## Estructura

```
src/
  platform/   base técnica: http (router declarativo), db (RLS), cola, red, observabilidad, correo, auth
  modules/    un módulo por dominio: business, team, catalog, clients, scheduling, sales,
              commissions, reports, whatsapp, campaigns, billing
  admin/      superadmin
  routes.ts   composición de la API (/api/panel/*)
  jobs.ts     composición de la cola y los loops de fondo
web/src/      panel React: app (rutas, layout, sesión), modules (secciones), ui, lib
drizzle/      migraciones
```

## Documentación

- [`PLAN-GESTION.md`](PLAN-GESTION.md): plan de la reestructura (arquitectura, modelo de datos, planes, fases).
- [`ROADMAP.md`](ROADMAP.md): estado de cada ítem.
- [`CLAUDE.md`](CLAUDE.md): convenciones del repo (identificadores en inglés, flujo con PRs, política de dependencias).
- `DEPLOY.md` y `TESTING.md`: todavía describen la versión anterior; se actualizan antes del primer despliegue de
  Selyon CRM.
