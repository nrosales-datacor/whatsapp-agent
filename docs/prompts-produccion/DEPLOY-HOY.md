# Prompt — Publicar Selyon CRM hoy en el droplet nuevo

> Para pegar en una sesión NUEVA de Claude Code corriendo en la Mac (no en la nube), con Chrome abierto y la
> extensión **Claude in Chrome** conectada. Escrito el 2026-10-31. Si lo lee otra persona: es autocontenido.

---

Sos el encargado de dejar **Selyon CRM** publicado HOY en un servidor nuevo de DigitalOcean, con el último avance
posible del código, para que la primera usuaria (la hermana del dueño, con su negocio) pueda empezar a usarlo. Vas a
trabajar desde la terminal de esta Mac (SSH al servidor) y con la extensión de Chrome para los paneles web
(DigitalOcean, Supabase, Meta, OpenAI, DuckDNS o el registrador del dominio).

## 0. Antes de tocar nada

1. Repo: `https://github.com/nrosalesselyoncr-boop/whatsapp-agent` (público). Si no está clonado en esta Mac,
   clonalo en `~/selyon/whatsapp-agent`. Rama de trabajo: **`prod/readiness`** (`git fetch origin && git checkout
   prod/readiness && git pull`).
2. Leé completos: `CLAUDE.md`, `docs/prompts-produccion/PROGRESO.md` (estado y pendientes de cada prompt),
   `DEPLOY.md` §26 (inventario de secretos, §26.3 generación, §26.5 checklist del alta) y `.env.example`.
   **Ojo:** partes de `DEPLOY.md` §1–§14 y §24 todavía describen el droplet viejo y nombres viejos (`whatsapp-bot`,
   `app_wa`, `DATABASE_URL_MIGRACIONES`, `conTenant`…). Ante la duda, manda el código: `.env.example`,
   `ecosystem.config.cjs`, `package.json`, `scripts/` y `src/platform/config/requiredSecrets.ts`.
3. **Último avance:** revisá en GitHub el último PR abierto (no borrador, cabeza que no sea `prod/*`). Si su cabeza
   no está contenida en `prod/readiness`, mergealo a `prod/readiness` (merge, nunca rebase ni force-push), corré
   `npm ci`, `npm run typecheck` y `npm test`, y si algo falla, pará y avisá. Lo que se publica es `prod/readiness`.
4. **NO hagas push a `main` ni mergees PRs del stack**: el CI de `main` todavía despliega al droplet VIEJO
   (`DEPLOY.md` §26.4). Hoy el deploy es a mano desde `prod/readiness`.

## 1. Datos que le pedís al usuario al empezar (todos juntos, una sola vez)

- IP pública del droplet nuevo y su tamaño (512 MB, 1 GB o 2 GB). Ya existe, con Ubuntu 24.04 y la llave SSH de esta
  Mac (`~/.ssh/id_ed25519`); entra como `root`.
- Dominio: ¿compró uno (cuál) o usamos DuckDNS gratis por ahora (`DEPLOY.md` §7)?
- ¿Ya tiene cuenta y tarjeta en OpenAI, Supabase y Meta for Developers? ¿Gestor de contraseñas (recomendado
  Bitwarden)?
- Nombre del negocio de la hermana, rubro (estética, uñas, dental u otro), su correo (será la dueña en el panel) y
  su número de WhatsApp (para registrarlo como destinatario de prueba en Meta).
- Correo y usuario para el superadmin (el dueño de Selyon).

## 2. Reglas (no negociables)

- **Secretos:** nunca los pegues en el chat, en el repo, en commits ni en el reporte. Los que se generan
  (`openssl rand`, `scripts/hashPassword.ts`, `scripts/generateTotp.ts`) se generan **en el servidor** y se escriben
  directo al `.env` (`chmod 600`); al usuario solo le decís "copiá este valor del servidor a Bitwarden" con el comando
  para verlo él. Las llaves de paneles (OpenAI, Meta, Supabase) las copia el usuario a Bitwarden y al `.env` (por
  ejemplo con `nano` por SSH); con Chrome solo navegás hasta la pantalla correcta.
- **Pagos, tarjetas, logins, 2FA y captchas:** los hace el usuario. Vos navegás y le decís dónde hacer clic.
  Antes de cualquier cosa que cueste plata (crear proyecto pago, cargar crédito, comprar dominio), pedí confirmación.
- **Chrome:** primero `tabs_context_mcp`, trabajá en pestañas nuevas, no toques las pestañas del usuario, no hagas
  clic en botones que abran diálogos de confirmación sin avisar, y si algo falla 2–3 veces, pará y preguntá.
- **Dependencias:** política de `CLAUDE.md` (popular, publisher conocido, versión con +1 mes, exacta). En el servidor
  se instala solo lo que el repo ya fija (`npm ci`) más Node 24, PM2, `pm2-logrotate@3.0.0` y Caddy.
- Al terminar cada fase, contale al usuario en 1–2 líneas qué quedó y qué sigue.

## 3. Fases

**A. Servidor base** (SSH como root)
- Actualizar el sistema; crear usuario `selyon` con sudo y la misma llave SSH; desde ahí trabajar con `selyon`.
- Firewall `ufw`: solo 22, 80 y 443. Zona horaria `America/Costa_Rica`.
- Swap: 2 GB si el droplet tiene ≤ 1 GB de RAM (con 512 MB, solo producción; staging queda para después).
- Node 24 LTS (NodeSource, verificá `node -v` = 24.x, igual que `.nvmrc`), `git`, PM2 (versión fija con +1 mes) y
  `pm2-logrotate@3.0.0` (`DEPLOY.md` §6b), Caddy por su repo oficial (`DEPLOY.md` §8 caso A).

**B. Base de datos (Supabase, con Chrome)**
- Proyecto NUEVO (no el viejo del piloto), región **East US (N. Virginia)**, plan Free. La clave del rol `postgres`
  la genera Supabase: va a `DATABASE_URL_MIGRATIONS` y `BACKUP_DATABASE_URL`.
- Correr las migraciones desde el servidor (`npm run db:migrate` con esas URLs) y después `scripts/rls/01-app-role.sql`
  con una clave nueva (`openssl rand -hex 32`) para el rol `app_runtime`; `DATABASE_URL` = la URL de ese rol. Verificá
  `rolbypassrls = false`.

**C. Código y `.env`** (en el servidor, como `selyon`)
- Clonar en `~/selyon-crm`, `git checkout prod/readiness`, `npm ci`, `npm run web:build`.
- `.env` desde `.env.example`, con secretos NUEVOS generados según `DEPLOY.md` §26.3 (nunca copiar el `.env` del
  sistema viejo). Mínimos para que arranque en producción: `NODE_ENV=production`, `PUBLIC_BASE_URL`,
  `DATABASE_URL`, `DATABASE_URL_MIGRATIONS`, `PANEL_SESSION_SECRET` (≥ 32 al azar), `TOKENS_ENCRYPTION_KEY`
  (64 hex), `PANEL_SUPERADMIN_USERNAME` / `PANEL_SUPERADMIN_HASH` / `PANEL_SUPERADMIN_TOTP_SECRET` (obligatorio en
  producción), `HEALTH_DETAIL_TOKEN`, `TRUST_PROXY`, `OPENAI_API_KEY` y las de WhatsApp. El chequeo de arranque
  (`productionSecretProblems`) te dice exactamente qué falta: usalo.
- `chmod 600 .env`. El usuario registra el TOTP del superadmin en su app autenticadora.

**D. Dominio y HTTPS**
- DuckDNS (o el DNS del dominio comprado) apuntando a la IP. Caddyfile con el dominio → `localhost:PORT`,
  `systemctl reload caddy`, y verificar `https://<dominio>/health`.

**E. Arranque 24/7**
- `pm2 start ecosystem.config.cjs`, `pm2 save`, `pm2 startup` (y correr el comando que imprime).
- `bash scripts/ci/smoke.sh https://<dominio>` → los 5 ✅. `curl` a `/health?detail=1` con el token → base OK.

**F. OpenAI (con Chrome)**
- Proyecto `selyon-prod` con su propia key y **límite mensual de gasto** (p. ej. US$20, aviso al 50 %). Modelo por
  defecto el que use el código (`gpt-4o-mini` salvo que el `.env.example` diga otro).

**G. WhatsApp (Meta, con Chrome)**
- App de Meta (nueva, recomendado; ver la decisión pendiente en `PROGRESO.md`), producto WhatsApp, **número de
  prueba**. Registrar el número de la hermana como destinatario de prueba.
- Webhook: URL `https://<dominio>/webhook` (verificá la ruta real en `src/app.ts`/el módulo de WhatsApp) con el verify
  token nuevo del `.env`; suscribir `messages`. App secret → `.env`. Token: el que pida el canal del negocio en el
  panel (ver cómo se conecta un número en el panel: WhatsApp IA › canales / Embedded Signup o carga manual).
- Para atender clientes reales con un número propio hace falta la verificación del negocio en Meta (días): dejalo
  explicado como pendiente.

**H. Alta del negocio**
- Entrar al superadmin (`/panel` → acceso de superadmin, con TOTP), crear el negocio de la hermana con la plantilla de
  su rubro y su correo como dueña. Si el correo no sale (no hay Resend configurado), buscá la forma prevista en el
  código para el primer acceso (invitación, link en el log en desarrollo, etc.); si no hay, configurá Resend (gratis)
  o pedí decisión al usuario.
- Conectar el número de prueba al negocio, cargar horario y servicios mínimos, y probar **de punta a punta**: la
  hermana escribe al número de prueba → el bot responde → aparece en la bandeja del panel.

**I. Mínimos de operación (si queda tiempo hoy)**
- Alertas por Telegram (`DEPLOY.md` §22; `scripts/sendTestAlert.ts` debe llegar al celular).
- Backup diario (`DEPLOY.md` §19.1 con `scripts/backupDb.ts`) y un restore probado (`scripts/verifyRestore.ts`).
- Sentry opcional (`DEPLOY.md` §16).

## 4. Al terminar

- Actualizá `docs/prompts-produccion/PROGRESO.md` con una sección "Deploy del 2026-10-31": IP (sin secretos),
  dominio, región, tamaño, qué quedó funcionando, qué no y los pendientes humanos. Si corregiste pasos de
  `DEPLOY.md` que estaban viejos, actualizalos también. Commit en `prod/readiness` y **push solo de `prod/readiness`**
  (preguntá antes de pushear).
- Reporte final al usuario, corto y en español: URL del panel, cómo entra la hermana, qué probar, qué falta (número
  propio verificado en Meta, dominio propio, pendientes urgentes de `rotar-llaves` §26.1 del sistema viejo) y cuánto
  se está pagando por mes.
