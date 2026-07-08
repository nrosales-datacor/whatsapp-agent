# Guía de despliegue — Bot de WhatsApp de Lavacar Rosales

Guía para dejar el bot corriendo **24/7** en el Droplet de DigitalOcean.
Tiempo estimado: ~45 min. Está pensada para hacerse por SSH.

> ⚠️ **OJO con selyon:** en este Droplet ya corre **selyon** (otra app de WhatsApp).
> No vamos a tocarla, pero hay que (1) usar un **puerto distinto** y (2) cuidar el
> servidor web que ya maneja el HTTPS. Los pasos lo contemplan.

---

## 0. Lo que necesitás antes de empezar

- **Acceso SSH** al Droplet (usuario y clave/llave).
- El **archivo `.env`** con los valores reales. ⚠️ NO está en el repo (tiene secretos).
  Pediselo a Nathan y copialo tal cual (es el mismo que se usó en las pruebas).
- Una cuenta gratis en **duckdns.org** (para el dominio con HTTPS, sin costo).
- La **IP pública** del Droplet (la ves en el panel de DigitalOcean).

---

## 1. Conectarse al Droplet

```bash
ssh usuario@IP_DEL_DROPLET
```

## 2. Revisar qué hay instalado (para no chocar con selyon)

```bash
node -v                                  # ¿Node 20 o superior? (si no, ver paso 2b)
sudo ss -tlnp | grep -E ':(80|443|3000|3001)'   # ¿qué puertos están ocupados?
```

Anotá qué puerto usa selyon (típicamente 3000). Nosotros usaremos **otro** (ej. 3001).
Anotá también si el **80/443** ya los usa algo (nginx, caddy…): lo necesitamos en el paso 6.

### 2b. (Solo si Node es viejo o no está) Instalar Node 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## 3. Bajar el código

```bash
cd ~
git clone https://github.com/nrosales-datacor/whatsapp-agent.git
cd whatsapp-agent
npm install
```

## 4. Crear el archivo `.env`

Copiá el `.env` que te pasó Nathan dentro de la carpeta del proyecto:

```bash
nano .env        # pegá el contenido, guardá con Ctrl+O, Enter, y salí con Ctrl+X
```

⚠️ **Cambiá una sola cosa:** poné `PORT=3001` (o cualquier puerto libre que NO use
selyon). Ese puerto lo usamos en el paso 6.

## 5. Crear las tablas en la base (Supabase)

```bash
npx tsx scripts/migrar.ts
```

Debe decir "Migración aplicada" y listar las tablas `wa_*`. (Si ya existían de las
pruebas, no pasa nada: es idempotente.)

## 6. Dejarlo corriendo 24/7 con PM2

```bash
sudo npm install -g pm2
pm2 start npm --name whatsapp-bot -- start
pm2 save
pm2 startup        # ejecutá el comando que te imprime, para que arranque solo al reiniciar
pm2 logs whatsapp-bot   # para ver que diga "Agente escuchando..." (Ctrl+C para salir)
```

El bot ya corre en `localhost:3001`, pero todavía NO es accesible desde internet.
Para eso necesitamos un dominio con HTTPS (paso 7 y 8).

## 7. Dominio gratis con DuckDNS

1. Entrá a **duckdns.org** e iniciá sesión (con Google/GitHub).
2. Creá un subdominio, por ej. **`rosalescarwash-bot`** → te queda
   `rosalescarwash-bot.duckdns.org`.
3. En el campo "current ip" poné la **IP pública del Droplet** y dale **"update ip"**.

## 8. HTTPS — elegí según lo que viste en el paso 2

### Caso A: los puertos 80 y 443 estaban LIBRES → usar Caddy (lo más fácil)

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Editá el Caddyfile:

```bash
sudo nano /etc/caddy/Caddyfile
```

Dejalo así (cambiá el dominio y el puerto si usaste otro):

```
rosalescarwash-bot.duckdns.org {
    reverse_proxy localhost:3001
}
```

```bash
sudo systemctl reload caddy
```

Caddy saca el certificado HTTPS solo. Listo, salteá al paso 9.

### Caso B: el 80/443 YA los usa nginx (porque selyon ya tiene web)

No instales Caddy. Hay que agregarle un "sitio" a nginx + sacar el certificado.
**Esto es más delicado — si no tenés experiencia, mandale a Nathan/Claude la salida
de `sudo nginx -T` y te pasamos el bloque exacto.** En resumen:

```bash
sudo nano /etc/nginx/sites-available/whatsapp-bot
```
```
server {
    listen 80;
    server_name rosalescarwash-bot.duckdns.org;
    location / { proxy_pass http://localhost:3001; proxy_set_header Host $host; }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/whatsapp-bot /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d rosalescarwash-bot.duckdns.org
```

## 9. Abrir el firewall (si está activo)

```bash
sudo ufw allow 80
sudo ufw allow 443
```

## 10. Probar que el servidor responde por HTTPS

Desde tu compu o el navegador, abrí:
```
https://rosalescarwash-bot.duckdns.org/
```
Debe decir: **"Agente de WhatsApp corriendo ✅"**

## 11. Apuntar el webhook de Meta al servidor

En la carpeta del proyecto, en el Droplet:

```bash
npx tsx scripts/configurarWebhook.ts https://rosalescarwash-bot.duckdns.org/webhook
```

Debe decir "✅ Webhook apuntado a …". (La cuenta de WhatsApp ya está suscrita a la
app desde las pruebas, no hay que hacer nada más en Meta.)

## 12. ¡Probar de verdad!

Escribile al número del bot por WhatsApp. Debe responder.
Para ver los registros en vivo:

```bash
pm2 logs whatsapp-bot
```

---

## Datos reales de este deploy (ya hecho — 2026-06-19)

Esto ya está corriendo. Quedó así, distinto del genérico de arriba en algunos puntos
(por selyon):

- **IP**: `157.230.190.60`
- **Usuario SSH**: `sebastian` (solo con SSH key, sin password)
- **Carpeta del proyecto**: `~/lavacar-whatsapp-bot` (⚠️ NO `~/whatsapp-agent` —
  esa carpeta ya la usa selyon, es otro repo)
- **Dominio**: `https://wabotlavacar.selyon.app` (no se usó DuckDNS — se aprovechó
  que ya tenemos `selyon.app`; registro DNS tipo A en Cloudflare, proxy **gris**
  /DNS-only, igual que `api.selyon.app`)
- **Puerto interno**: `3001` (selyon sigue en `3000`, sin tocar)
- **Proceso PM2**: `whatsapp-bot` (con `pm2 startup` ya configurado — systemd lo
  reinicia solo si el droplet reboota)
- **Repo privado → acceso del droplet**: deploy key dedicada de solo lectura
  (`~/.ssh/deploy_whatsapp_lavacar` en el droplet, alias SSH `github.com-lavacar`
  en `~/.ssh/config`), agregada en GitHub → Settings → Deploy keys de este repo.
  No se tocó la deploy key que ya usa selyon (`~/.ssh/github_deploy`).

## 13. Actualizar a la versión con PANEL (bandeja humana + CRM + dashboard)

La versión nueva agrega el panel web en `/panel`, **instalable como app (PWA)** y con
**notificaciones push** al celular. Necesita secretos nuevos en el `.env` y **correr las
migraciones** (la base cambió: columnas `modo`, `no_leidos`, `notas`, `precio`, campos de
Google Calendar y la tabla `wa_push_subs`).

> ⚠️ Sin `PANEL_SESSION_SECRET` el servidor **NO arranca en producción** (se cae el
> bot que ya funciona). Sin `PANEL_PASSWORD_HASH_ROSALES` nadie puede entrar al panel.

Líneas a agregar al `.env`. **Las 5 te las pasa Nathan** (ya están generadas — NO las
generes vos: si las VAPID cambian, se rompen todas las suscripciones de push):

```
PANEL_SESSION_SECRET=...                # te lo pasa Nathan (obligatorio)
PANEL_PASSWORD_HASH_ROSALES=salt:hash   # te lo pasa Nathan (obligatorio)
VAPID_PUBLIC_KEY=...                     # te lo pasa Nathan
VAPID_PRIVATE_KEY=...                    # te lo pasa Nathan (SECRETA)
VAPID_SUBJECT=mailto:soporte@selyon.app
```

> Es **un solo redeploy** para todo lo nuevo (bandeja + CRM + dashboard + PWA + push):
> está todo en `main`. Si todavía no habías actualizado desde la versión vieja, este
> redeploy lo trae junto.
>
> _(Las llaves VAPID se generan una única vez por toda la vida del producto con
> `npx web-push generate-vapid-keys`. Ya se hizo; solo sirve si algún día se levanta
> una instancia nueva desde cero.)_

Luego, en el droplet:

```bash
cd ~/lavacar-whatsapp-bot
nano .env        # pegá las líneas de arriba. Guardá: Ctrl+O, Enter, Ctrl+X.
git pull
npm install
npx tsx scripts/migrar.ts        # crea/actualiza las tablas (idempotente)
npx tsx scripts/seedTenants.ts   # siembra el negocio + usuario del panel en la base (idempotente, ver nota 🆕 tenants)
npm run web:build                # compila el panel React (web/) → web/dist (ver nota abajo)
pm2 restart whatsapp-bot
pm2 logs whatsapp-bot            # debe decir "Agente escuchando" + "Notificaciones push: configuradas ✅"
```

> 🆕 **Los negocios ahora viven en la base (no en el código).** `scripts/seedTenants.ts`
> inserta/actualiza el negocio `lavacar-rosales` y su usuario de panel en las tablas
> `wa_tenants`/`wa_usuarios` a partir de la config + `PANEL_PASSWORD_HASH_ROSALES` del
> `.env`. **Corre DESPUÉS de `migrar.ts` y ANTES del `pm2 restart`** para que al reiniciar
> el bot ya encuentre al negocio en la base. Es idempotente (se puede correr en cada deploy).
> **Red de seguridad:** si la base quedara sin negocios o no respondiera, el bot cae a una
> copia interna de `lavacar-rosales` y sigue atendiendo (en los logs aparece un aviso
> ruidoso indicando que hay que correr el seed) — así esta migración no puede dejar el bot
> caído. Dar de alta OTRO negocio = insertar filas en `wa_tenants`/`wa_usuarios` (el bot lo
> toma solo en ~1 min, sin redeploy); también se puede por pantalla (onboarding, ver paso 14).

## 14. Habilitar el onboarding de negocios (área de superadmin)

El panel tiene un área protegida en **`/panel/admin`** para dar de alta un negocio nuevo
(datos, servicios, base de conocimiento) y su usuario, **sin tocar código ni SQL**. Lo opera
el dueño del SaaS (no es público). Para habilitarlo, agregá al `.env` un superadmin:

```bash
npx tsx scripts/hashPassword.ts "UNA_CLAVE_FUERTE"   # copiá el salt:hash que imprime
nano .env
```
```
PANEL_SUPERADMIN_USUARIO=admin          # usuario DISTINTO de los de panel
PANEL_SUPERADMIN_HASH=salt:hash         # el hash recién generado
```
```bash
pm2 restart whatsapp-bot
```

Luego entrá a **https://wabotlavacar.selyon.app/panel/admin**, logueate con ese usuario y
completá el formulario. Para conectar WhatsApp del negocio pegás su **`phone_number_id`** y
**`accessToken`** (los sacás del WhatsApp Manager de Meta). Al crear, el negocio queda
**vivo al instante** (sin `pm2 restart`) y ya puede entrar al panel con el usuario que le
pusiste. El alta requiere `DATABASE_URL` (ya está en prod). Si `PANEL_SUPERADMIN_*` quedan
vacíos, el área existe pero nadie puede entrar.

> 🆕 **El panel ahora es React (Vite).** `npm run web:build` instala las dependencias
> de `web/` y genera `web/dist` (que NO está en git). El bot sirve ese build en
> `/panel`; **si `web/dist` no existe, cae automáticamente al panel viejo (`inbox.html`)**,
> así que un deploy sin el build no rompe nada — solo no trae la versión nueva del panel.
> El `pm2 restart` del final hace que el bot tome el build recién generado. Necesita
> Node 18+ (el droplet ya tiene Node 20). El service worker, el manifest y los íconos de
> la PWA salen de ese mismo build.

Probá en el navegador (PC o celular): **https://wabotlavacar.selyon.app/panel**
Usuario `lavacar-rosales`, contraseña `lavacar2026` (cambiala cuanto antes).
En el celular: abrí ese link → menú del navegador → **"Agregar a pantalla de inicio"**
para instalarla como app. Adentro, tocá la 🔔 (arriba a la derecha) para activar las
notificaciones (te pedirá permiso y te llegará una de prueba).

## 15. CI/CD — deploy automático con GitHub Actions (ROADMAP B5)

Desde que existe `.github/workflows/ci-cd.yml`, **el redeploy manual de la fila de abajo ya no es
el camino normal**: cada `push` a `main` corre typecheck (backend + panel) y build del panel; si
todo pasa, se conecta por SSH al droplet y hace exactamente esos mismos pasos, sola. Un `push` a
cualquier otra rama, o un PR contra `main`, solo corre el typecheck/build (sin tocar el droplet).

### Configuración de una sola vez

1. **Generar una llave SSH dedicada a CI** (no la personal de Sebastián — así se puede revocar sin
   afectar su acceso):
   ```bash
   ssh-keygen -t ed25519 -f deploy_ci -N "" -C "github-actions-deploy"
   ```
2. **Agregar la pública al droplet** (usuario `sebastian`):
   ```bash
   cat deploy_ci.pub | ssh sebastian@157.230.190.60 "cat >> ~/.ssh/authorized_keys"
   ```
3. **Cargar la privada como secret en GitHub**: repo → *Settings* → *Secrets and variables* →
   *Actions* → *New repository secret* → nombre `DEPLOY_SSH_KEY`, valor el contenido completo de
   `deploy_ci` (la privada, no la `.pub`). Borrá `deploy_ci`/`deploy_ci.pub` de tu disco después.
4. Borrá el par de llaves local (`rm deploy_ci deploy_ci.pub`) una vez cargada — ya vive solo en
   el droplet (pública) y en GitHub (privada).

El host, usuario, carpeta y nombre del proceso PM2 están hardcodeados en el workflow (no son
secretos: ya están documentados en este mismo archivo, que vive en un repo privado). Si el droplet
cambia de IP o de carpeta, hay que actualizar `.github/workflows/ci-cd.yml`.

### Si el pipeline falla

`pm2 restart` solo corre si `git pull`/`npm install`/`migrar.ts`/`seedTenants.ts`/`web:build` salieron
bien (`set -e` en el script remoto) — el bot sigue corriendo con el código viejo hasta que un
deploy completo tenga éxito. Mirá la pestaña **Actions** del repo para ver en qué paso falló.
Como red de seguridad, el redeploy manual de la tabla de abajo sigue funcionando igual que siempre.

## 16. Sentry — alertas de errores (ROADMAP B5, OPCIONAL)

Sin esto el bot funciona igual, solo que un error en el server o el worker se pierde en
`pm2 logs` y nadie se entera hasta que un cliente se queja.

1. Creá una cuenta gratis en [sentry.io](https://sentry.io) y un proyecto tipo **Node**.
2. Copiá el DSN que te da (`https://...@...ingest.sentry.io/...`) y agregalo al `.env`
   del droplet:
   ```bash
   nano .env        # agregá la línea: SENTRY_DSN=https://...
   pm2 restart whatsapp-bot
   ```
3. Confirmá en los logs (`pm2 logs whatsapp-bot`) que aparece `Sentry: activo ✅` al
   arrancar. Sin el DSN dice "no configurado (opcional)" y el bot sigue igual.
4. En el dashboard de Sentry, activá alertas por email/Slack para "nuevo issue" del
   proyecto — así te avisa sin tener que entrar a mirar.

Qué se reporta: excepciones no atrapadas y rechazos de promesa sin manejar (crashean o
casi crashean el proceso), más los errores ya atrapados que valen alerta (falla
persistir un mensaje entrante, un job de la cola agota reintentos, un loop del worker o
de recordatorios muere). Los reintentos intermedios (backoff normal) NO se reportan
para no generar ruido.

## 17. Uptime monitor — avisa si el bot se cae (ROADMAP B5, OPCIONAL)

Sentry (§16) avisa de errores mientras el proceso sigue vivo; esto cubre el caso
distinto: el droplet se cayó, PM2 no pudo revivir el proceso, se acabó el disco, DNS
roto, etc. — algo que Sentry no puede reportar porque el proceso ni está corriendo.

Con **UptimeRobot** (gratis, no hace falta tarjeta):

1. Creá una cuenta en [uptimerobot.com](https://uptimerobot.com).
2. **+ Add New Monitor**:
   - Monitor Type: `HTTP(s)`
   - Friendly Name: `Lavacar Rosales — bot WhatsApp`
   - URL: `https://wabotlavacar.selyon.app/salud`
   - Monitoring Interval: `5 minutes` (el mínimo del free tier)
3. En **Alert Contacts**, agregá tu email (y opcionalmente Slack/Telegram/SMS si querés
   más canales) y asignalo al monitor.
4. Guardá. UptimeRobot pega un GET a `/salud` cada 5 min; si no devuelve `200`
   (droplet caído, proceso muerto, DNS roto, etc.) manda la alerta.

No requiere ningún cambio de código: `/salud` ya existe y devuelve `200 OK` con texto
plano (`src/server.ts`). Es 100% configuración externa — no hay nada para deployar.

## 18. Métricas internas (ROADMAP B5)

No requiere setup: cada `METRICAS_INTERVALO_MIN` minutos (default 5) el proceso vuelca
un resumen a los logs. Para verlo:

```bash
pm2 logs whatsapp-bot | grep metricas
```

Ejemplo: `[metricas] 3.20 msg/min · turno del bot: avg=1840ms p95=3200ms (n=16) · cola
pendiente=0`. Si `cola pendiente` crece sostenido, el worker no da abasto (revisar
`pm2 logs` por errores repetidos). Si la latencia del turno sube mucho, sospechar de
OpenAI lento o de una herramienta (Calendar/Google) colgándose.

## 19. Backups verificados (ROADMAP B5)

Supabase **Free** no incluye backups automáticos (eso es de Pro en adelante), así que
los armamos nosotros con `pg_dump` vía cron + un script (`scripts/backupDb.ts`), y
después **probamos el restore de verdad** en un destino separado (nunca sobre la base
real del piloto).

### 19.1 Setup del backup diario (en el droplet)

1. Instalar el cliente de Postgres (trae `pg_dump`/`psql`; no es una dependencia npm):
   ```bash
   sudo apt-get update && sudo apt-get install -y postgresql-client
   ```
2. Sacar la conexión **DIRECTA** de Supabase (puerto 5432 — NO el pooler 6543 que usa
   la app): Dashboard del proyecto → **Project Settings → Database → Connection
   string** → pestaña **URI**, con el toggle en **"Direct connection"** (no
   "Transaction pooler"). Agregala al `.env` del droplet:
   ```bash
   nano .env
   # BACKUP_DATABASE_URL=postgresql://postgres:TU_PASSWORD@db.xxxxxxxx.supabase.co:5432/postgres
   ```
3. Probar a mano:
   ```bash
   cd ~/lavacar-whatsapp-bot && npx tsx scripts/backupDb.ts
   ls -la backups/          # debe aparecer wa_bot_YYYY-MM-DD.sql.gz
   ```
4. Programarlo con cron (todos los días a las 3 am, hora del servidor):
   ```bash
   crontab -e
   ```
   Agregar la línea (ajustá la ruta si tu carpeta es otra):
   ```
   0 3 * * * cd ~/lavacar-whatsapp-bot && /usr/bin/npx tsx scripts/backupDb.ts >> backups/backup.log 2>&1
   ```
   El script mismo poda los `.sql.gz` de más de `BACKUP_RETENCION_DIAS` (default 14
   días) — no hace falta limpiar a mano.

### 19.2 Probar el restore (lo que realmente importa)

Tener el `.sql.gz` no sirve de nada si nunca comprobaste que se puede restaurar. Se
prueba en un **proyecto Supabase nuevo y separado** (gratis) para no arriesgar el
piloto real:

1. Creá un segundo proyecto en Supabase (plan Free alcanza para esto — es temporal).
2. Sacá su conexión directa igual que en el paso 19.1.2 (llamalo `RESTORE_TEST_URL`).
3. Restaurá el dump más reciente ahí:
   ```bash
   gunzip -c backups/wa_bot_YYYY-MM-DD.sql.gz | psql "postgresql://postgres:...@db.yyyy.supabase.co:5432/postgres"
   ```
4. Verificá que los datos llegaron íntegros comparando conteos contra producción
   (mismo comando, apuntado a cada URL):
   ```bash
   psql "$URL" -c "select count(*) from wa_tenants;"
   psql "$URL" -c "select count(*) from wa_citas;"
   psql "$URL" -c "select count(*) from wa_mensajes;"
   ```
5. Anotá acá (y en el ROADMAP) la fecha en que se probó con éxito. Borrá el proyecto
   de prueba después (o dejalo para la próxima verificación).

**Repetir este test de restore cada 2-3 meses** — un backup que nunca se restauró no
es un backup confiable.

## Mantenimiento rápido

| Acción | Comando |
|---|---|
| Ver estado | `pm2 status` |
| Ver registros | `pm2 logs whatsapp-bot` |
| Reiniciar | `pm2 restart whatsapp-bot` |
| Actualizar el código (manual, red de seguridad — lo normal es el push a `main`) | `cd ~/lavacar-whatsapp-bot && git pull && npm install && npx tsx scripts/migrar.ts && npx tsx scripts/seedTenants.ts && npm run web:build && pm2 restart whatsapp-bot` |

**Landing de venta (ROADMAP C4.4):** vive en `landing/` (HTML/CSS estático, sin build) y la sirve
el mismo proceso Node en el root del dominio (`GET /`). No agrega pasos al redeploy — el `git pull`
de la fila de arriba ya la trae. Si algo (uptime monitor, script de verificación) usaba `GET /` como
health check, ahora es `GET /salud` (el texto "Agente de WhatsApp corriendo ✅" se movió ahí).

## Si algo falla
- **El panel se ve VIEJO (no es el React nuevo)** → el server está sirviendo el
  fallback `inbox.html` porque no encuentra `web/dist`. Verificá:
  `ls -la ~/lavacar-whatsapp-bot/web/dist/index.html`. Si NO existe, el build no se
  generó: corré `npm run web:build` **a solas** (sin encadenar) y mirá el error.
  Causa típica: con `NODE_ENV=production`, `npm install` **omite las devDependencies**
  (y `vite` es una devDependency), así que el build falla con "vite: not found". El
  script `web:build` ya fuerza `--include=dev` para evitarlo; si igual falla, pegá la
  salida. Tras un build exitoso, `pm2 restart whatsapp-bot` (el proceso cachea el index
  una sola vez → sin restart sigue con el viejo). Confirmá con:
  `curl -s https://wabotlavacar.selyon.app/panel | grep -o '/panel/assets/[^"]*'`
  (si imprime `.js`/`.css` → React está vivo; vacío → sigue el fallback).
- El bot no arranca → `pm2 logs whatsapp-bot` (suele ser algo del `.env`).
- No llega el HTTPS → revisá que el registro A de `wabotlavacar.selyon.app` en
  Cloudflare apunte a `157.230.190.60` y que el firewall tenga abierto 80/443.
- El bot no responde por WhatsApp → repetí el paso 11 y revisá los logs.
- Cualquier duda con nginx/selyon → mandá la salida de `sudo nginx -T` y te ayudamos.
