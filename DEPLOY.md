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
  > 🔑 **Esto vale SOLO para el sistema viejo (el bot del lavacar).** El stack nuevo (Selyon CRM)
  > **no reutiliza ningún valor** de ese `.env`: nace con un juego de secretos generado de cero,
  > propio de cada entorno (§26). Copiar el `.env` viejo heredaría cualquier exposición pasada
  > (droplet compartido con selyon, `.env` que pasó de mano en mano).
- Una cuenta gratis en **duckdns.org** (para el dominio con HTTPS, sin costo).
- La **IP pública** del Droplet (la ves en el panel de DigitalOcean).

---

## 1. Conectarse al Droplet

```bash
ssh usuario@IP_DEL_DROPLET
```

## 2. Revisar qué hay instalado (para no chocar con selyon)

```bash
node -v                                  # ¿Node 24.x? (si no, ver paso 2b)
sudo ss -tlnp | grep -E ':(80|443|3000|3001)'   # ¿qué puertos están ocupados?
```

Anotá qué puerto usa selyon (típicamente 3000). Nosotros usaremos **otro** (ej. 3001).
Anotá también si el **80/443** ya los usa algo (nginx, caddy…): lo necesitamos en el paso 6.

### 2b. (Solo si Node no es 24 o no está) Instalar Node 24 LTS

El proyecto fija **Node 24 LTS** (`.nvmrc` y `engines` en `package.json`; el CI usa la
misma versión). Node 20 quedó fuera de soporte en abril 2026 — no lo uses en producción.

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v          # debe decir v24.x
```

> Usamos **NodeSource** (Node del sistema en `/usr/bin/node`) y no `nvm` a propósito: el
> `pm2 startup` (systemd) y el `cron` del backup (§19) corren sin tu shell interactiva y
> no ven el Node de `nvm`. Si el droplet ya usa `nvm`, ver "Actualizar Node en el droplet".

### 2c. Actualizar Node en el droplet (paso MANUAL, una vez por versión mayor)

El pipeline **no** actualiza Node (es infraestructura del droplet, compartida con selyon).
Cuando el repo sube de versión mayor (p. ej. de 20 a 24), hacelo a mano por SSH, en una
ventana tranquila (el bot queda caído ~1 min):

```bash
node -v                                   # versión actual
# ⚠️ selyon comparte este Node: confirmá con quien la mantiene que soporta la versión nueva.

# Opción A — NodeSource (recomendada, la que usa el paso 2b):
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
#   (si apt no sube la versión: sudo apt-get remove -y nodejs && sudo apt-get install -y nodejs)

# Opción B — si el droplet usa nvm:
#   nvm install 24 && nvm alias default 24
#   (y en el cron del §19 usá la ruta absoluta que imprime `which node`)

node -v                                   # v24.x
sudo npm install -g pm2                   # PM2 global queda atado al Node viejo: reinstalalo
pm2 update                                # recarga el daemon de PM2 con el Node nuevo
pm2 unstartup systemd && pm2 startup      # ejecutá el comando que imprime (actualiza la ruta de Node en systemd)
cd ~/lavacar-whatsapp-bot
npm ci                                    # recompila lo nativo contra el Node nuevo
npm ci --prefix web --include=dev && npm run build --prefix web
pm2 restart whatsapp-bot && pm2 save
pm2 logs whatsapp-bot                     # debe decir "Agente escuchando..."
curl -s https://wabotlavacar.selyon.app/health
```

## 3. Bajar el código

```bash
cd ~
git clone https://github.com/nrosales-datacor/whatsapp-agent.git
cd whatsapp-agent
npm ci
```

## 4. Crear el archivo `.env`

Copiá el `.env` que te pasó Nathan dentro de la carpeta del proyecto (⚠️ solo sistema viejo;
para el stack nuevo el `.env` se arma con valores nuevos siguiendo §26.3 y §26.5):

```bash
nano .env        # pegá el contenido, guardá con Ctrl+O, Enter, y salí con Ctrl+X
```

⚠️ **Cambiá una sola cosa:** poné `PORT=3001` (o cualquier puerto libre que NO use
selyon). Ese puerto lo usamos en el paso 6.

## 5. Crear las tablas en la base (Supabase)

```bash
node --import tsx scripts/migrate.ts
```

Debe decir "Migración aplicada" y listar las tablas `wa_*`. (Si ya existían de las
pruebas, no pasa nada: es idempotente.)

## 6. Dejarlo corriendo 24/7 con PM2

```bash
sudo npm install -g pm2
pm2 start ecosystem.config.cjs   # app "whatsapp-bot" con kill_timeout para el apagado ordenado
pm2 save
pm2 startup        # ejecutá el comando que te imprime, para que arranque solo al reiniciar
pm2 logs whatsapp-bot   # para ver que diga "Agente escuchando..." (Ctrl+C para salir)
```

> 🔒 **Cómo corre el TypeScript en producción.** `npm start` = `node --import tsx src/server.ts`:
> Node carga el loader de `tsx` en el mismo proceso (sin proceso hijo, así las señales de PM2
> llegan directo). `tsx` está en **`dependencies`** con versión exacta, así que `npm ci` lo
> instala aunque el droplet tenga `NODE_ENV=production` (que omite las devDependencies).
> Los scripts (`migrate.ts`, `backupDb.ts`, …) se corren igual:
> `node --import tsx scripts/X.ts`, que usa el `tsx` del `node_modules` local. **No uses
> `npx tsx` en el droplet**: si `tsx` no estuviera instalado, `npx` bajaría la última versión
> del registry sin pasar por la política de dependencias (CLAUDE.md). No compilamos a JS
> porque el código usa imports sin extensión (`moduleResolution: Bundler`), que Node ESM no
> resuelve sin un bundler.

> 🔁 **Deploys sin cortar turnos a la mitad.** El pipeline hace `pm2 reload whatsapp-bot`:
> PM2 manda SIGINT, el server deja de aceptar requests y de reclamar jobs, y espera a que
> terminen los turnos del agente en curso (`APAGADO_ESPERA_MS`, default 25 s,
> `src/red/apagado.ts`) antes de salir. `ecosystem.config.cjs` le da a PM2 un `kill_timeout`
> de 30 s para que no lo mate antes. **Si tu droplet todavía tiene la app creada con
> `pm2 start npm --name whatsapp-bot -- start`**, migrala una vez:
> `pm2 delete whatsapp-bot && pm2 start ecosystem.config.cjs && pm2 save`.
> Mientras se reinicia (unos segundos) Meta reintenta los webhooks que fallen: no se pierde
> nada, solo se demora.

El bot ya corre en `localhost:3001`, pero todavía NO es accesible desde internet.
Para eso necesitamos un dominio con HTTPS (paso 7 y 8).

### 6b. Rotación de logs con retención corta (pm2-logrotate)

Sin esto, `~/.pm2/logs/*.log` crece sin límite (hasta llenar el disco) y guarda el
historial completo para siempre. Aunque los logs ya **no** llevan datos personales del
cliente final (teléfonos enmascarados tipo `506***7777`, y del contenido de los mensajes
solo su longitud — ver `src/observabilidad/privacidad.ts`), la retención corta es parte
de la minimización de datos (Ley 8968): lo que no se guarda no se filtra. Para depurar
una conversación concreta está el panel, no los logs.

Paso manual, una vez por droplet (versión fija, ver política de dependencias en CLAUDE.md:
`pm2-logrotate@3.0.0` es del 2025-09-02, publicado por el equipo de PM2):

```bash
pm2 install pm2-logrotate@3.0.0
pm2 set pm2-logrotate:max_size 10M              # rota un archivo al pasar 10 MB…
pm2 set pm2-logrotate:rotateInterval '0 0 * * *' # …y además todos los días a medianoche
pm2 set pm2-logrotate:retain 7                  # conserva solo 7 archivos rotados (~1 semana)
pm2 set pm2-logrotate:compress true             # gzip de los rotados
pm2 save
pm2 conf pm2-logrotate                          # verificar la config
```

> ⚠️ `pm2-logrotate` es global al usuario de PM2: también rota los logs de **selyon** si
> corre bajo el mismo usuario. Coordiná la retención con quien la mantiene. Si alguna vez
> hace falta guardar más días (p. ej. investigando un incidente), subí `retain` temporalmente.

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

> 🔒 **IP real del cliente (`TRUST_PROXY`)**: Caddy le pasa a Node la IP del visitante en
> `X-Forwarded-For` (y por defecto **pisa** la que mande el cliente, así que no se puede
> falsificar desde afuera). Para que el rate limit del login la use, en el `.env` poné
> `TRUST_PROXY=loopback` (Caddy habla con Node desde `127.0.0.1`). Ver §23.

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
    location / {
        proxy_pass http://localhost:3001;
        proxy_set_header Host $host;
        # IP real del cliente + esquema (https) para el rate limit del login y el HSTS (§23).
        # $proxy_add_x_forwarded_for AGREGA la IP real al final de lo que mandó el cliente;
        # Node solo cree el último salto agregado por un proxy de confianza (TRUST_PROXY).
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
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

> El script que apuntaba el webhook desde el droplet era del producto anterior y ya no existe.
> El webhook se configura en Meta for Developers (app → WhatsApp → Configuración → Webhook) con
> la URL `https://TU-DOMINIO/webhook/whatsapp` (`WHATSAPP_WEBHOOK_PATH`,
> `src/modules/whatsapp/webhook.ts`) y el token de verificación del `.env`.

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
> bot que ya funciona). Tampoco arranca si es el placeholder de `.env.example`, si tiene
> menos de 32 caracteres o si es un patrón adivinable (ver §23, "Secretos al arrancar"). Sin `PANEL_PASSWORD_HASH_SELYON` nadie puede entrar al panel.

Líneas a agregar al `.env`. **Las 5 te las pasa Nathan** (ya están generadas — NO las
generes vos: si las VAPID cambian, se rompen todas las suscripciones de push):

```
PANEL_SESSION_SECRET=...                # te lo pasa Nathan (obligatorio)
PANEL_PASSWORD_HASH_SELYON=salt:hash    # te lo pasa Nathan (obligatorio)
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
npm ci
node --import tsx scripts/migrate.ts        # crea/actualiza las tablas (idempotente)
npm run web:build                # compila el panel React (web/) → web/dist (ver nota abajo)
pm2 restart whatsapp-bot
pm2 logs whatsapp-bot            # debe decir "Agente escuchando" + "Notificaciones push: configuradas ✅"
```

> 🆕 **Los negocios viven en la base (no en el código).** El script de siembra de negocios del
> producto anterior ya no existe: en Selyon CRM los negocios se crean desde el alta self-service o
> el área de superadmin (§14, §25). `scripts/seedDev.ts` es **solo para desarrollo** (se niega a
> correr con `NODE_ENV=production`).

> 📅 **Google Calendar es por negocio, no por `.env`** (auditoría BLOQ-05, arreglado el
> 2026-07-30). En el `.env` van solo las credenciales de la **service account** (globales,
> son nuestras). El calendario de cada negocio vive en `wa_tenants.google_calendar_id` y lo
> pega el propio dueño en **"Mi negocio" → "Google Calendar"**, después de compartir ese
> calendario con el email de la service account (permiso "Hacer cambios en eventos").
>
> Antes `GOOGLE_CALENDAR_ID` era una env **global**: con dos clientes, las citas de uno
> —con nombre, teléfono, servicio y precio del cliente final— se escribían en el Google
> Calendar del otro, y una cancelación podía borrar eventos ajenos. Para no romper el
> piloto, la env se sigue respetando **solo** para el tenant nombrado en
> `GOOGLE_CALENDAR_TENANT_ID`; cualquier otro negocio sin su columna configurada queda con
> Calendar **apagado** (nunca redirigido a un calendario ajeno). Acción recomendada en el
> droplet: pegar el calendario del piloto desde el panel y borrar ambas variables del `.env`.

## 14. Habilitar el onboarding de negocios (área de superadmin)

El panel tiene un área protegida en **`/panel/admin`** para dar de alta un negocio nuevo
(datos, servicios, base de conocimiento) y su usuario, **sin tocar código ni SQL**. Lo opera
el dueño del SaaS (no es público). Para habilitarlo, agregá al `.env` un superadmin:

```bash
node --import tsx scripts/hashPassword.ts "UNA_CLAVE_FUERTE"   # copiá el salt:hash que imprime
nano .env
```
```
PANEL_SUPERADMIN_USERNAME=admin         # usuario DISTINTO de los de panel
PANEL_SUPERADMIN_HASH=salt:hash         # el hash recién generado
PANEL_SUPERADMIN_TOTP_SECRET=...        # segundo factor: OBLIGATORIO en producción (ver abajo)
```

**Segundo factor (TOTP) del superadmin — OBLIGATORIO en producción.** Es la llave de TODOS
los negocios (alta, planes, pausa, tokens de WhatsApp): con `NODE_ENV=production` y el
superadmin configurado (usuario + hash), si falta `PANEL_SUPERADMIN_TOTP_SECRET` o no es un
base32 de al menos 128 bits, **el proceso no arranca** (`src/platform/config/requiredSecrets.ts`).
Generalo y cargalo en el `.env` del servidor ANTES del primer deploy:

```bash
npx tsx scripts/generateTotp.ts admin
```

Imprime `PANEL_SUPERADMIN_TOTP_SECRET=...` (pegalo en el `.env`) y una URI `otpauth://...`:
cargala en la app autenticadora del celular (Google Authenticator, Authy, 1Password,
Bitwarden) — convertida en QR con un generador **offline**, o a mano con "Ingresar clave de
configuración" (tipo "basada en tiempo") usando el secreto. Comprobá que el "código vigente"
que imprime el script coincide con la app. Desde el `pm2 restart`, el login de
`/panel/admin` pide usuario + clave + **código de 6 dígitos**; un código ya usado no se
acepta dos veces, y las sesiones de admin abiertas antes de activar el 2FA dejan de valer.
La sesión del admin dura 8 h (`PANEL_ADMIN_SESSION_HOURS`, tope 12) y se puede revocar sola
subiendo `PANEL_ADMIN_SESSION_VERSION`. Los logins del admin (y los rechazados por código
inválido — señal de que la clave se filtró), los resets de clave y los exports quedan en
`wa_auditoria` (los logins con `tenant_id = '_plataforma'`).

> Si perdés el celular: entrá al droplet, generá un secreto nuevo con el mismo script,
> reemplazalo en el `.env` y `pm2 restart whatsapp-bot`.
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
> Node 24 (ver paso 2b/2c). El service worker, el manifest y los íconos de
> la PWA salen de ese mismo build.

Probá en el navegador (PC o celular): **https://wabotlavacar.selyon.app/panel**
Usuario `lavacar-rosales`; la contraseña **no va en el repo**: pedísela a Nathan (está en el gestor de contraseñas).

> ⚠️ **Ese usuario se desactiva** (§26.1, decisión del 2026-10-31): su contraseña estuvo en texto
> plano en este repo, que es público, y sigue en el historial de git. En el stack nuevo no existe
> (el login es por correo).

En el celular: abrí ese link → menú del navegador → **"Agregar a pantalla de inicio"**
para instalarla como app. Adentro, tocá la 🔔 (arriba a la derecha) para activar las
notificaciones (te pedirá permiso y te llegará una de prueba).

## 15. CI/CD — deploy automático con GitHub Actions (ROADMAP B5)

Desde que existe `.github/workflows/ci-cd.yml`, **el redeploy manual de la fila de abajo ya no es
el camino normal**: cada `push` a `main` corre typecheck (backend + panel) y build del panel; si
todo pasa, se conecta por SSH al droplet y hace exactamente esos mismos pasos, sola. Un `push` a
cualquier otra rama, o un PR contra `main`, solo corre el typecheck/build (sin tocar el droplet).

### Configuración de una sola vez

> 🔑 **Una llave por entorno.** Lo de abajo es cómo se armó la del droplet viejo. El servidor del
> stack nuevo lleva una llave **nueva** (no se reutiliza `deploy_ci` ni ninguna del droplet viejo)
> y, ANTES del primer push a `main` del stack nuevo, hay que cambiar `DEPLOY_SSH_KEY`,
> `DEPLOY_HOST_KEY` y las variables `DEPLOY_HOST`/`DEPLOY_USER`/`DEPLOY_DIR`/`BASE_URL`: sin esas
> variables el workflow cae a los valores del droplet viejo. Paso a paso en §26.4.

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
4b. **Fijar la llave del HOST (recomendado):** sin esto el workflow confía en la llave que devuelva
   la IP en el momento del deploy (`ssh-keyscan`), y un atacante en el medio podría hacerse pasar
   por el droplet. Desde tu máquina (que ya confía en el droplet):
   ```bash
   ssh-keygen -F 157.230.190.60          # imprime la línea de known_hosts del droplet
   ```
   y cargá esa línea (o `ssh-keyscan -t ed25519 157.230.190.60`, verificando la huella contra la
   del panel de DigitalOcean) como secret `DEPLOY_HOST_KEY`. Con él, el workflow usa solo esa
   llave; sin él, sigue funcionando pero avisa con un warning.
5. **Gate de aprobación (G9, recomendado):** repo → *Settings* → *Environments* → *New
   environment* `produccion` → marcá **Required reviewers** y agregate. Desde entonces cada push a
   `main` corre CI completo, pero el job de deploy **espera** a que lo apruebes en la pestaña
   *Actions* ("Review deployments"). Sin esta regla configurada, el deploy sigue siendo automático.
6. **Backup antes de migrar (G9):** si el push trae archivos nuevos en `drizzle/`, el deploy corre
   `scripts/backupDb.ts` antes de `migrate.ts`; si el backup falla, el deploy se corta **sin tocar la
   base**. Requiere lo de la §19.1 en el droplet (`postgresql-client` + `BACKUP_DATABASE_URL`).

El host y el usuario se pueden cambiar con las **variables** del repo `DEPLOY_HOST` y
`DEPLOY_USER` (Settings → Secrets and variables → Actions → Variables); sin ellas se usan los
valores actuales. Carpeta y nombre del proceso PM2 siguen en `.github/workflows/ci-cd.yml`.

**Qué hace el deploy:** compila el panel en el runner de GitHub (el droplet ya no instala Vite ni
compila), lo sube como `panel-<sha>.tgz`, hace `git checkout` del **commit exacto** que pasó CI,
`npm ci --omit=dev`, backup si hay migraciones, `migrate.ts`, cambia `web/dist` de una vez y
`pm2 reload`. Si algo falla antes del reload, el proceso viejo sigue atendiendo. Después espera el
`/health` (con reintentos) y corre el **smoke post-deploy** `scripts/ci/smoke.sh "$BASE_URL"`:
`/panel` con el bundle, router de la API (404 JSON), `GET /api/panel/auth/me` sin cookie → **401**
y `POST /api/panel/auth/login` con el correo de smoke `smoke-test@selyon-smoke.invalid` → **401**
`invalid_credentials` (CSRF + validación + base). Recién si todo pasa guarda el SHA como último
deploy bueno. El login falso es **un** intento fallido por deploy: suma al rate-limit de la IP del
runner y aparece en los logs con ese correo (dominio reservado `.invalid`); es esperable, no un
ataque. No hay usuario de smoke en producción: el login exitoso se prueba en CI (TESTING.md §9).

### Si el pipeline falla

`pm2 reload` solo corre si `git checkout`/`npm ci`/`migrate.ts`/el panel
salieron bien (`set -e` en el script remoto) — el bot sigue corriendo con el código viejo hasta que
un deploy completo tenga éxito. Mirá la pestaña **Actions** del repo para ver en qué paso falló. El
propio job de deploy imprime, en su último paso (`if: failure()`), el SHA al que revertir si hace
falta (ver **Rollback** más abajo). Como red de seguridad adicional, el redeploy manual de la tabla
de abajo sigue funcionando igual que siempre.

> 🔒 **`npm ci`, no `npm install` (ROADMAP F17).** El paso "Actualizar código y reiniciar el bot"
> usa `npm ci` (backend y panel) en vez de `npm install`: instala **exactamente** lo que dice el
> `package-lock.json`/`web/package-lock.json` — mismas versiones que ya pasaron `npm run db:check`
> y los 189 tests en CI, sin que un rango de versión (`^`/`~`) resuelva distinto en el droplet un
> día después. Como contrapartida, `npm ci` **exige que el lockfile exista y esté sincronizado con
> el `package.json`** (falla si no lo está) — si alguna vez ves el deploy romperse ahí, corré
> `npm install` local, commiteá el lockfile actualizado, y volvé a pushear.
> Además, los `package.json` (raíz y `web/`) fijan **versiones exactas** (sin `^`/`~`), y el CI
> lo verifica con `npm run ci:versions` (`scripts/ci/checkExactVersions.mjs`): un rango
> nuevo rompe el job "Typecheck + build".

### Rollback — revertir el CÓDIGO de un deploy fallido (ROADMAP F17)

Cada deploy exitoso (el que pasa el smoke post-deploy) guarda su SHA en un archivo **no versionado**
en el droplet: `~/.ultimo-deploy-ok`. Si un deploy nuevo falla, el propio job lo imprime en el log
("para revertir corré el workflow de rollback con SHA=..."); si no, ese archivo es la fuente de
verdad de "qué era lo último que funcionaba".

**Cómo revertir:**

1. Repo → pestaña **Actions** → workflow **CI/CD** → botón **Run workflow** (arriba a la derecha).
2. Elegí la rama `main` y, opcionalmente, pegá un **SHA** en el campo `sha`. Si lo dejás vacío, usa
   el `~/.ultimo-deploy-ok` que ya está guardado en el droplet — no hace falta que nadie se acuerde
   cuál era.
3. Correr. El job **`rollback`** hace `git fetch` + `git checkout <sha>` + `npm ci` (backend y
   panel) + `pm2 reload`, y corre el mismo `/health` + `scripts/ci/smoke.sh` que un deploy normal
   (el script sale del commit del workflow, no del SHA revertido). Si el smoke pasa, ese SHA queda
   guardado como el nuevo `~/.ultimo-deploy-ok`.

> ⚠️ **Este rollback es SOLO de código — nunca de la base de datos.** El job automático
> deliberadamente **no** revierte ni corre migraciones. Revertir un esquema (borrar una columna,
> deshacer un `NOT NULL`, etc.) puede perder datos que el código nuevo ya escribió y necesita
> **juicio humano**, no un botón. Si la falla del deploy vino de una migración incompatible con el
> código anterior, el rollback de código **no alcanza**: hay que decidir a mano si conviene
> arreglar la migración hacia adelante o escribir una migración correctiva — seguí el
> **Protocolo expand/contract** de abajo para que este escenario, en general, no llegue a pasar.
>
> El job deja el droplet en **detached HEAD** sobre el SHA revertido (es intencional: no se toca
> la rama `main` local). El próximo deploy normal (`push` a `main`) hace `git checkout main` antes
> del `git pull`, así que vuelve solo a la rama — no hace falta ningún paso manual para "deshacer"
> el detached HEAD.

### Protocolo expand/contract — migraciones que no son puramente aditivas (ROADMAP F17)

`node --import tsx scripts/migrate.ts` corre **antes** del `pm2 restart`, así que hay una ventana (breve, pero
real) en la que el código **viejo** sigue respondiendo pedidos contra el esquema **ya migrado**. Una
migración puramente aditiva (agregar una tabla, o una columna **nullable** o con **default**) es
segura en esa ventana: el código viejo simplemente no la usa. Una migración que **no** es aditiva —
agregar una columna `NOT NULL` sin default, renombrar una columna/tabla, cambiar el tipo de una
columna, o borrar algo que el código viejo todavía lee o escribe — puede romper esa ventana (el
código viejo falla contra el esquema nuevo) y además hace que el rollback de código de arriba sea
**inseguro** (el código de vuelta no sabría hablar con el esquema que quedó).

La salida es partir el cambio en varios deploys chicos, cada uno reversible por sí solo:

1. **Expand:** migración que solo **agrega** — la columna nueva nace `nullable` (o con `default`),
   la tabla/índice nuevo no reemplaza nada todavía. El código viejo ni se entera; convive sin
   problema con el esquema ampliado.
2. **Deploy del código que lee/escribe lo nuevo**, pero **tolerando que todavía no esté poblado**
   (la columna puede venir `null` para las filas viejas). Este es un deploy normal, revertible con
   el rollback de arriba sin drama: si algo sale mal, el código anterior sigue funcionando contra el
   esquema ampliado sin quejarse (porque el paso 1 lo dejó opcional).
3. **Backfill:** script aparte (idempotente, en lotes — mismo patrón que la purga de la cola,
   nunca un `UPDATE` masivo de una sola vez) que llena la columna/tabla nueva para las filas que
   ya existían.
4. **Contract:** recién en un deploy **posterior** (con el backfill ya confirmado 100 % completo)
   una migración que hace la columna `NOT NULL`, borra la columna vieja que quedó reemplazada, o
   saca el fallback del código. Este paso es el que ya NO es seguro revertir con un rollback de
   código simple — por eso va último, cuando ya no queda margen de error.

> Nunca hay que combinar los 4 pasos en un solo deploy: el punto entero de separarlos es que cada
> uno, individualmente, deja al bot en un estado donde el código viejo **y** el nuevo pueden hablar
> con la base sin romperse — que es justo la propiedad que hace seguro el rollback de código.

**Quiénes van a necesitar esto:** **F1** (RLS + agregar `tenant_id` a `wa_mensajes`, que hoy no la
tiene — un backfill real sobre una tabla de negocio existente) y **F9** (mover las fotos de
`wa_mensajes.media_url` a Storage — la columna cambia de "data URL completa" a "URL firmada",
así que el código tiene que leer ambos formatos durante la transición). Ambos ítems del ROADMAP
deberían seguir estos 4 pasos en vez de una migración de un solo tiro.

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
   - URL: `https://wabotlavacar.selyon.app/health`
   - Monitoring Interval: `5 minutes` (el mínimo del free tier)
3. En **Alert Contacts**, agregá tu email (y opcionalmente Slack/Telegram/SMS si querés
   más canales) y asignalo al monitor.
4. Guardá. UptimeRobot pega un GET a `/health` cada 5 min; si no devuelve `200`
   (droplet caído, proceso muerto, DNS roto, etc.) manda la alerta.

No requiere ningún cambio de código: `/health` ya existe y devuelve `200 OK` con texto
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
   cd ~/lavacar-whatsapp-bot && node --import tsx scripts/backupDb.ts
   ls -la backups/          # debe aparecer wa_bot_YYYY-MM-DD.sql.gz
   ```
4. Programarlo con cron (todos los días a las 3 am, hora del servidor):
   ```bash
   crontab -e
   ```
   Agregar la línea (ajustá la ruta si tu carpeta es otra):
   ```
   0 3 * * * cd ~/lavacar-whatsapp-bot && /usr/bin/node --import tsx scripts/backupDb.ts >> backups/backup.log 2>&1
   ```
   El script mismo poda los `.sql.gz` de más de `BACKUP_RETENCION_DIAS` (default 14
   días) — no hace falta limpiar a mano. La poda **solo corre si el backup de hoy
   salió bien** y siempre conserva los `BACKUP_MINIMO` más recientes (default 3). Un
   `pg_dump` a medias no se guarda (se escribe a `.parcial` y se verifica la marca de
   cierre del volcado).
5. **Alertas:** si falla, el script sale con código 1 y lo reporta a Sentry (si hay
   `SENTRY_DSN` en el `.env`). Sin Sentry, nadie se entera: revisá `backups/backup.log`.
6. **Copia fuera del droplet (recomendado):** si el droplet muere, se pierden los
   backups con él. Con `BACKUP_COMANDO_COPIA` el script corre ese comando tras cada
   backup bueno, con `{archivo}` reemplazado por la ruta del `.sql.gz`. Ejemplo con
   `rclone` (configurado aparte con `rclone config`) y cifrado con `gpg`:
   ```bash
   # BACKUP_COMANDO_COPIA=gpg --batch --yes --passphrase-file ~/.backup-pass -c {archivo} && rclone copy {archivo}.gpg remoto:wa-backups && rm {archivo}.gpg
   ```
   Si la copia falla, también alerta (el backup local igual queda).

### 19.2 Probar el restore (lo que realmente importa)

Tener el `.sql.gz` no sirve de nada si nunca comprobaste que se puede restaurar. Se
prueba en un **proyecto Supabase nuevo y separado** (gratis) para no arriesgar el
piloto real:

1. Creá un segundo proyecto en Supabase (plan Free alcanza para esto — es temporal), o un
   Postgres vacío cualquiera.
2. Sacá su conexión directa igual que en el paso 19.1.2.
3. En el droplet, corré el verificador (restaura el volcado más nuevo de `backups/` y compara
   conteos tabla por tabla contra la base de origen):
   ```bash
   RESTORE_DATABASE_URL="postgresql://postgres:...@db.yyyy.supabase.co:5432/postgres" \
     node --import tsx scripts/verifyRestore.ts            # o pasale un .sql.gz puntual
   ```
   Se niega a escribir en la base de la app o en una que ya tenga tablas `wa_*`. Termina con
   ✅ si el volcado se restauró completo (todas las tablas, ninguna vacía que no lo esté en el
   origen, mismas migraciones) o con ❌ y la lista de lo que no cierra (código de salida ≠ 0,
   así se puede programar en cron).
4. Anotá acá (y en el ROADMAP, B5/E14) la fecha en que se probó con éxito. Borrá el proyecto
   de prueba después (o vacialo para la próxima verificación).

**Repetir este test de restore cada 2-3 meses** — un backup que nunca se restauró no
es un backup confiable.

### 19.3 Chequeo rápido de producción (E14)

El verificador automático que corría en el droplet era del producto anterior y ya no existe.
Hasta que se reescriba (ROADMAP, Carril P), el chequeo es:

1. **Desde afuera** (cualquier máquina con `bash` y `curl`): el mismo smoke que corre el pipeline
   después de cada deploy, `bash scripts/ci/smoke.sh https://TU-DOMINIO` (§15; suma un login
   fallido con el correo de smoke, como cada deploy).
2. **En el droplet, a mano:** que `SENTRY_DSN` esté en el `.env`, que el cron de §19.1 exista
   (`crontab -l`), que haya un `.sql.gz` de menos de 48 h en `backups/` (y ningún `.partial`
   huérfano) y que `BACKUP_DATABASE_URL` y `BACKUP_COPY_COMMAND` estén configurados.

**No reemplaza** el restore de §19.2 ni confirmar las alertas de Sentry/UptimeRobot en sus
dashboards: eso sigue siendo manual.

## 20. Cifrado en reposo: `TOKENS_ENCRYPTION_KEY` (ROADMAP F2)

En Selyon CRM se guardan **cifrados** (AES-256-GCM, `src/platform/crypto/secrets.ts`) dos
secretos de terceros:

- `whatsapp_channels.access_token_encrypted`: el token de WhatsApp de cada número de cada negocio
  (permite mandar mensajes como ese negocio);
- `users.totp_secret`: el secreto del 2FA de cada persona del equipo que lo activó.

Los dos usan una sola clave maestra del `.env`:

```
TOKENS_ENCRYPTION_KEY=...   # 32 bytes en hex (64 caracteres) — obligatoria en producción
```

Generarla **una única vez por entorno, ANTES de cargar el primer dato** (staging y producción
tienen claves distintas; nunca la del sistema viejo):

```bash
openssl rand -hex 32
# o, sin openssl:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> ⚠️ Sin `TOKENS_ENCRYPTION_KEY` (o con un valor que no es 64 hex, o con un patrón) el servidor
> **NO arranca** en producción (`src/platform/config/requiredSecrets.ts` y el propio
> `secrets.ts`). En desarrollo sin base se usa una clave aleatoria por corrida.

> El script que migraba tokens guardados en texto plano era del producto anterior y ya no existe:
> en Selyon CRM los tokens se guardan cifrados desde el alta.

### Rotar la clave

**Hoy no hay herramienta de rotación** (`secrets.ts` fija la clave al importar y el blob `v1:` no
dice con qué clave se cifró). Por eso la clave se genera nueva antes de tener datos y, mientras
no exista el llavero con `kid` (ítem propuesto en el ROADMAP, P1.5), **se rota solo si hay
sospecha de filtración**. Con datos ya cargados, rotar es descifrar todo con la clave vieja y
volver a cifrar con la nueva:

1. Generá la clave nueva (comando de arriba) pero **no la reemplaces todavía** en el `.env`.
2. Ventana de mantenimiento: frená la app (`pm2 stop` de web y worker) para que nadie conecte un
   número ni active un 2FA a mitad de la rotación. Backup antes (§19).
3. Corré un script puntual (a mano, no versionado, con `DATABASE_URL_MIGRATIONS`) que recorra
   `whatsapp_channels.access_token_encrypted` y `users.totp_secret` no nulos y, por fila,
   descifre con la clave vieja y cifre con la nueva. **No importes `secrets.ts` dos veces** (la
   clave queda fija al cargar el módulo): replicá el formato `v1:<iv>:<tag>:<datos>` con
   `node:crypto` y las dos claves en variables locales del script.
4. ⚠️ **Hacelo reintentable desde el principio:** si se corta a la mitad quedan filas con la clave
   nueva y otras con la vieja. Por fila, probá la vieja; si la verificación GCM falla, probá la
   nueva y dejala como está; si fallan las dos, frená y avisá (dato corrupto).
5. Recién ahí reemplazá `TOKENS_ENCRYPTION_KEY` en el `.env`, levantá la app y verificá: "Probar"
   en un número de WhatsApp (`POST /whatsapp/channels/:id/test`) y un login con 2FA.
6. Guardá la clave nueva en el gestor y borrá la vieja de todos lados (salvo que un backup
   anterior la necesite: anotá en el gestor qué backups se cifraron con cuál).

> 🔑 **Guardá la clave donde no se pueda perder.** No hay recuperación: si se pierde
> `TOKENS_ENCRYPTION_KEY`, los tokens de WhatsApp quedan **irrecuperables** (hay que reconectar el
> WhatsApp de **cada negocio**) y nadie con 2FA puede entrar hasta que se lo resetee. Va en el
> gestor de contraseñas (§26), no solo en el `.env` del servidor: si se pierde el servidor y el
> backup de la base no trae el `.env`, se pierden los tokens de todos los clientes.

## 21. Separar procesos web/worker (ROADMAP F6, OPCIONAL — escalar más allá de 1 negocio)

Todo lo de arriba deja **un solo proceso PM2** (`whatsapp-bot`) haciendo webhook + panel +
landing + los 3 workers de cola (mensajes, campañas, rescate) + los 3 schedulers
(recordatorios, reputación, reporte de métricas). Es lo que corre hoy en producción y **no
hace falta cambiar nada** para seguir así: es el modo `ROL=todo` (default si no se toca el
`.env`).

**Por qué separarlo eventualmente:** con un solo proceso, un pico de tráfico del panel (varios
operadores mirando la Agenda a la vez) comparte el mismo event loop y el mismo pool de
Postgres que el webhook — puede degradarlo. Y un `pm2 restart` corta las conexiones de **todos**
los negocios a la vez, aunque el cambio no los afecte. Separar en dos procesos aísla esas dos
superficies: un pico del panel ya no compite con el webhook, y se puede reiniciar uno sin tocar
el otro.

**Cuándo hacerlo:** no antes de que un cliente real lo justifique. Con 1-3 negocios el proceso
único sobra. Es una palanca para cuando el número de negocios (o el tráfico del panel) empiece a
importar.

### Cómo queda

- **`ROL=web`**: sirve webhook + panel + landing + `/health` completo. NO arranca ningún worker
  de cola ni scheduler.
- **`ROL=worker`**: arranca los 3 workers de cola y los 3 schedulers. Sirve un HTTP **mínimo**
  que solo responde `/health` (health check del proceso; sin webhook, sin panel, sin landing —
  eso lo atiende la réplica `web`).
- Los workers de cola (mensajes, campañas, rescate) son seguros ante N réplicas por su claim
  atómico (`FOR UPDATE SKIP LOCKED`); se puede correr **más de una** réplica `worker` sin
  duplicar trabajo. En la cola de **mensajes** eso no alcanzaba solo: hasta E7, con 2 réplicas
  dos mensajes seguidos del MISMO cliente podían responderse en paralelo (la agrupación de
  ráfagas solo miraba los `pendiente`). Desde E7 el claim garantiza **como máximo un job en
  curso por conversación** (`NOT EXISTS` sobre los `procesando` + advisory lock de
  transacción por conversación) y reparte por tenant, así que N réplicas × N slots es seguro.
- Cada proceso que corre la cola de mensajes (`ROL=worker` o `ROL=todo`) procesa
  `WORKER_CONCURRENCIA` jobs en paralelo (default **4**). Capacidad total = réplicas ×
  `WORKER_CONCURRENCIA`. Cada slot usa una conexión del pool solo mientras consulta (no
  mientras espera a OpenAI), así que 4 conviven bien con `DB_POOL_MAX=10`; si lo subís mucho,
  subí también el pool (sin pasarte del límite del pooler de Supabase dividido por procesos).
- Los 3 schedulers usan un **lease de liderazgo** nuevo (tabla `wa_lideres`,
  `src/red/liderazgo.ts`) para que, con N réplicas `worker`, solo UNA haga el trabajo real de
  cada tick — las demás lo ven en los logs como "en espera: otro proceso tiene el liderazgo
  este tick" (no es un error).

No hay `ecosystem.config.js` en este repo — dos apps de PM2 arrancadas a mano, mismo estilo que
el paso 6:

```bash
cd ~/lavacar-whatsapp-bot

# App "web": webhook + panel + landing. Usa el puerto público (el que ya tenías).
PORT=3001 ROL=web pm2 start npm --name whatsapp-bot-web -- start

# App "worker": workers de cola + schedulers. Puerto DISTINTO (solo para su /health
# interno; no necesita quedar expuesto públicamente detrás de Caddy/nginx).
PORT=3011 ROL=worker pm2 start npm --name whatsapp-bot-worker -- start

pm2 save
```

> ⚠️ Cada app de PM2 necesita su propio `PORT` — las dos leen el mismo `.env`, pero si las dos
> intentan escuchar en el mismo puerto, la segunda que arranque falla con `EADDRINUSE`.

Migrá **antes** de arrancar la app `worker` (crea `wa_lideres`, la tabla del lease):

```bash
node --import tsx scripts/migrate.ts
```

Con esto, el resto del deploy (CI/CD, paso 15) sigue igual: `pm2 restart whatsapp-bot-web` y
`pm2 restart whatsapp-bot-worker` reemplazan al único `pm2 restart whatsapp-bot` donde
corresponda (el workflow de este repo sigue apuntando al nombre `whatsapp-bot` — si migrás a
las dos apps, actualizá el nombre hardcodeado en `.github/workflows/ci-cd.yml`).

**Revertir a un solo proceso:** borrá las dos apps (`pm2 delete whatsapp-bot-web
whatsapp-bot-worker`) y volvé al `pm2 start npm --name whatsapp-bot -- start` del paso 6 sin
`ROL` en el `.env` (o con `ROL=todo` explícito) — es exactamente el comportamiento de siempre,
la tabla `wa_lideres` queda simplemente sin usar.

## 22. Alertas de "bot mudo" a la plataforma (OPCIONAL, recomendado)

`/health` solo responde 503 si se cae la base o el caché de tenants. Hay fallas que dejan a
UN negocio sin bot sin que nada se caiga: worker colgado (cola atascada), mensajes que
agotan reintentos (DLQ), un token de Meta revocado (HTTP 401 / error Graph 190), un número
que dejó de recibir webhooks, o el tope del plan agotado. Para eso corre un scheduler de
vigilancia (`src/observabilidad/vigilancia.ts`, cada `ALERTAS_INTERVALO_MIN`, solo en el
proceso líder) y el envío a WhatsApp detecta el token inválido al momento.

1. Creá un Incoming Webhook en Slack (o un webhook de canal en Discord) y pegá la URL en
   `ALERTAS_WEBHOOK_URL` del `.env`. Sin ella, las alertas igual quedan en `pm2 logs`
   (`grep alerta_plataforma`) y en Sentry si hay `SENTRY_DSN`.
2. Ajustá los umbrales si hace falta (`ALERTA_*` en `.env.example`). El de "sin entrantes"
   cuenta horas **hábiles** según el horario y la zona horaria de cada negocio.
3. `pm2 restart whatsapp-bot`. Al arrancar se loguea `Alertas a la plataforma: log + …`.
4. Para ver el estado en vivo (requiere `HEALTH_DETAIL_TOKEN` en el `.env`): `curl -s "https://TU-DOMINIO/health?detail=1&token=$HEALTH_DETAIL_TOKEN" | jq .vigilancia`
   (sin datos personales: solo ids de negocio, conteos y tiempos). Es informativo: **no**
   cambia el 200/503 del uptime monitor.

Con procesos separados (paso 21), la marca de "token inválido" vive en el proceso
`worker`: mirá su `/health?detail=1` (puerto del worker). La alerta sale igual al momento.

Para el botón "Mejorar plan" del aviso de cuota del panel, definí
`PLATAFORMA_CONTACTO_WHATSAPP` (solo dígitos) o `PLATAFORMA_CONTACTO_EMAIL`.

## 23. Endurecimiento de seguridad (revisión pre-venta 2026-10)

Lo que hay que **setear a mano** en el `.env` del droplet (el resto es automático):

```
TRUST_PROXY=loopback                    # OBLIGATORIO detrás de Caddy/nginx (ver abajo)
PANEL_SUPERADMIN_TOTP_SECRET=...        # §14, OBLIGATORIO (npx tsx scripts/generateTotp.ts)
```

- **`TRUST_PROXY`** — el rate limit del login (por IP, por par IP+usuario y un freno
  global por usuario) necesita la IP real del cliente. `X-Forwarded-For` lo puede inventar
  cualquiera, así que solo se cree el salto que agregó un proxy de confianza. Sin la env se
  usa la IP del socket: detrás de Caddy/nginx eso es `127.0.0.1` **para todos los
  visitantes** → un solo límite compartido (10 intentos fallidos de cualquiera frenan el
  login de todos 5 min). El log avisa (`[red] Llegan requests con X-Forwarded-For…`) si
  detecta esa situación. Valores: `loopback` (proxy en el mismo servidor), un número `N` de
  proxies delante, o una lista `IP,CIDR` (p. ej. si algún día va detrás de Cloudflare con
  proxy naranja: sus rangos + loopback). Con nginx hace falta además el
  `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` de §8.
- **Cabeceras de seguridad** — todas las respuestas llevan CSP (estricta en `/panel`, sin
  scripts inline; la de `/panel/admin` permite además el SDK de Meta del Embedded Signup),
  `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`,
  `X-Frame-Options: DENY` / `frame-ancestors 'none'` y HSTS (1 año) cuando la request llegó
  por https (`X-Forwarded-Proto: https`, que Caddy manda solo y nginx con la línea de §8).
  `SEGURIDAD_HSTS=0` lo apaga, `=1` lo fuerza. Comprobar:
  `curl -sI https://wabotlavacar.selyon.app/panel | grep -iE 'content-security|strict-transport'`.
- **Logo del negocio (white-label)** — ahora solo se acepta `https://`. Un logo viejo en
  `http://` se deja de ver (el navegador ya lo bloqueaba por contenido mixto): que el dueño
  lo vuelva a cargar con https desde "Mi negocio".
- **Notificaciones push** — cada suscripción es ahora de un usuario (migración
  `0035_push_subs_por_usuario`, aditiva). Desactivar a alguien, cambiarle la clave o el
  rol, resetearle la clave o que haga logout corta sus avisos. Las suscripciones viejas (sin
  usuario) dejan de recibir y se borran solas en el próximo envío; el panel las vuelve a
  registrar a nombre de quien esté logueado la próxima vez que se abra en ese dispositivo
  (si no, basta tocar la 🔔 de nuevo). Solo se aceptan endpoints https de los servicios de
  push de los navegadores (FCM, Apple, Mozilla, Windows) y hasta
  `PANEL_PUSH_MAX_POR_USUARIO` (5) dispositivos por usuario.
- **Secretos al arrancar** (`src/platform/config/requiredSecrets.ts`) — con
  `NODE_ENV=production` el proceso **no arranca** (sale con la lista de problemas, sin
  imprimir valores) si `PANEL_SESSION_SECRET` falta, es un placeholder de `.env.example`
  (que es público), tiene menos de 32 caracteres o poca entropía (`aaaa…`, patrones
  repetidos); si `TOKENS_ENCRYPTION_KEY` no es 64 hex o es un patrón; y, **si están
  definidos**, con el mismo criterio para `WHATSAPP_APP_SECRET` y `WHATSAPP_VERIFY_TOKEN`, y
  si `HEALTH_DETAIL_TOKEN` es el placeholder. **Antes de deployar este cambio** revisá el
  `.env` del droplet: si alguno no cumple, generá uno nuevo con
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (el verify
  token nuevo hay que cargarlo también en Meta, §11; cambiar el de sesión desloguea a todos).
- **Guardrail de secretos en CI** (`npm run ci:secrets`, job `verify`) — falla si un
  archivo versionado trae una llave conocida (Stripe, Meta, PEM, OpenAI, JWT, URL de
  Postgres con clave…), una contraseña en texto plano en un `.md` o una cadena prohibida.
  Las prohibidas (p. ej. contraseñas que ya se filtraron) **no van en el repo**: van en el
  secret de GitHub `CHECK_SECRETS_DENYLIST` (Settings → Secrets → Actions; una por línea) y,
  en local, en `.secrets-denylist` (gitignoreado).
- **Anti-replay del TOTP en memoria** — con una sola réplica `web` (el deploy actual) es
  exacto. Si algún día hay varias réplicas `web` (§21), un mismo código podría usarse una
  vez en cada una dentro de sus ~90 s de validez: aceptable, pero tenelo presente.

## 24. Aislamiento entre negocios en la base (ROADMAP F1, RLS)

Desde la migración `0037`, todas las tablas tienen políticas RLS por negocio y existe el rol
`app_wa` (sin BYPASSRLS, todavía sin login). El código ya corre cada operación con el negocio
fijado (`conTenant`) o como proceso de sistema explícito (`conSistema`), ver `src/db/alcance.ts`.
Mientras la app siga conectada como `postgres`, las políticas no aplican (ese rol las saltea).

Para que el aislamiento lo garantice la base (prerrequisito: §19.2 hecho, restore probado):

1. Correr `scripts/rls/01-app-role.sql` en el SQL Editor de Supabase (le da login con
   clave al rol y verifica que no tenga BYPASSRLS).
2. Probar la conexión del rol desde el droplet (comandos en el mismo archivo).
3. En el `.env` del droplet: `DATABASE_URL_MIGRACIONES` = la URL actual (rol `postgres`, la usan
   `migrate.ts`, backups y demás scripts) y `DATABASE_URL` = la del rol `app_wa`.
4. `pm2 reload whatsapp-bot --update-env` y verificar `/health?detail=1`, un mensaje de punta a
   punta y el panel. Rollback: volver `DATABASE_URL` al rol `postgres` y recargar.

`test/security/rlsAplicado.test.ts` corre toda la app con el rol `app_wa` sobre PGlite: si una
consulta nueva se olvida del alcance, ese test falla en CI.

## 25. Cobro con Stripe y alta self-service (Carril I, I6.6–I6.7, OPCIONAL)

Sin estas variables todo sigue con el **cobro manual** (PROCESO-COBRO-MANUAL.md): Configuración
› Plan muestra el texto de siempre y `/webhook/stripe` responde 503.

**Stripe (una vez, en el dashboard de Stripe):**

1. Crear un producto por opción que se vende (Básico, Pro y, si se vende, Pro sin agente) con su
   precio recurrente mensual. Copiar cada **Price ID** (`price_…`).
2. *Developers › Webhooks › Add endpoint*: `https://<dominio>/webhook/stripe`, con los eventos
   `checkout.session.completed`, `checkout.session.async_payment_succeeded` y
   `customer.subscription.created|updated|deleted|paused|resumed`. Copiar el **signing secret**
   (`whsec_…`).
3. *Settings › Billing › Customer portal*: activarlo (cambiar tarjeta, cancelar, facturas). Si
   se permite cambiar de plan desde el portal, ofrecer SOLO los precios de arriba (un precio que
   no está en el `.env` no cambia el plan del negocio, solo el estado del cobro).
4. En el `.env` del droplet: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_BASIC`,
   `STRIPE_PRICE_PRO` y (opcional) `STRIPE_PRICE_PRO_NO_AGENT`. `pm2 reload … --update-env`.
5. Probar en **modo test** de Stripe (claves `sk_test_…`) con una tarjeta de prueba: el negocio
   debe pasar a "Al día" con el plan comprado (Configuración › Plan) y quedar en el rastro de
   auditoría (`stripe_subscription_synced`). Recién después, las claves de producción.

Qué hace el webhook: verifica la firma sobre el cuerpo crudo (tolerancia 5 min), aplica cada
evento UNA vez (`stripe_events`), lee la suscripción fresca de la API y actualiza plan, módulos
(Pro sin agente) y estado del cobro. Si el cobro deja de estar al día (pago fallido o
suscripción cancelada) arranca la gracia de la pausa por falta de pago (ver abajo); al volver a
estar al día, un negocio pausado por el cobro se reactiva solo.
Los cupos extra (más profesionales o sucursales) siguen cargándose a mano en el superadmin.

**Alta self-service** (`/panel/signup`): apagada por defecto. Antes de prenderla, cerrar el gate
de AUDIT-v2 (papeles legales terminados y revisión de seguridad del alta). Para abrirla:
`SIGNUP_ENABLED=1` (y opcional `SIGNUP_TRIAL_DAYS`, default 14). El negocio nace en prueba con la
plantilla de su rubro; la cuenta no entra hasta confirmar el correo (hace falta `RESEND_API_KEY`
y `PUBLIC_BASE_URL`); al vencer la prueba sin suscripción pasa a "Pago pendiente" (aviso en el
panel) y arranca la gracia.

**Pausa por falta de pago (I6.8):** el barrido del cobro (proceso worker, cada
`BILLING_SWEEP_INTERVAL_MS`, default 1 h) pausa el negocio cuando pasan `BILLING_GRACE_DAYS`
(default 7) desde que el cobro dejó de estar al día por Stripe o por la prueba vencida. La dueña
puede entrar solo a pagar ("Cuenta pausada" con los botones de Stripe) y, al pagar, el webhook lo
reactiva. Los demás roles ven "Cuenta pausada" sin pago. El cobro manual (estado cargado por el
superadmin) nunca se pausa solo; si el superadmin reactiva a mano un negocio que sigue sin pagar,
la gracia vuelve a empezar.

**Crecimiento (I6.1–I6.4)** no necesita configuración del servidor: cada negocio lo activa en
WhatsApp IA › Crecimiento y Campañas, y carga sus plantillas por número (GUIA-META.md §E).

## 26. Secretos: inventario, generación y rotación (Carril P, P1.5)

Qué secreto vive dónde, cómo se genera, cómo se rota y qué hacer si se filtra. **Acá nunca van
valores**, solo comandos y lugares.

**Reglas:**

- **Gestor elegido: [PENDIENTE].** Hasta que se elija, la regla es la misma: cada secreto tiene su
  copia en un gestor de contraseñas del equipo (una entrada por entorno: "Selyon CRM — producción",
  "Selyon CRM — staging"), con la fecha en que se generó. **Quién tiene acceso: [PENDIENTE]** (anotalo
  acá cuando se decida: es la lista de a quién hay que sacar si alguien se va).
- **Nunca** en el repo (es público), ni en chats, correos, issues, PRs, capturas o logs. Para pasar
  un secreto a otra persona, se comparte la entrada del gestor.
- **Un juego por entorno.** Staging y producción no comparten nada, y el stack nuevo **no reutiliza
  nada del sistema viejo** (el bot del lavacar): ni el `.env`, ni la deploy key, ni el proyecto de
  Supabase, ni la key de OpenAI.
- En el servidor, el `.env` con `chmod 600` y dueño el usuario que corre la app. Mejor un servidor
  propio para el stack nuevo; si se comparte (el droplet viejo corre también selyon), al menos un
  usuario Unix propio, para que la otra app no pueda leer este `.env`.
- Generá los valores en el servidor o en tu máquina, pegalos en el gestor y en el `.env`, y limpiá
  la terminal. Si un comando lleva un secreto como argumento, poné un espacio adelante (con
  `HISTCONTROL=ignorespace` no queda en el historial) o usá `read -rs` como en §26.3.

### 26.1 Urgente, sistema viejo (ya, antes de cualquier otra cosa)

Decisiones del usuario (2026-10-31): el usuario del piloto **se desactiva** (no se resetea), **no se
reescribe el historial de git** (el repo es público: el valor ya se da por comprometido, lo que
protege es invalidarlo), y del sistema viejo **se rotan ya OpenAI y Meta**; el resto (Supabase
viejo, etc.) se apaga al cortar (§26.8).

1. **Desactivar `lavacar-rosales`.** La hace: Nathan (o quien tenga el Supabase viejo). Dónde:
   Supabase **del sistema viejo** → SQL Editor:
   ```sql
   -- Desactiva la cuenta, invalida su clave y revoca sus sesiones abiertas.
   UPDATE wa_usuarios
      SET activo = false,
          password_hash = 'desactivado',   -- sin ":" el login nunca valida (aunque alguien la reactive)
          session_epoch = session_epoch + 1
    WHERE usuario = 'lavacar-rosales'
   RETURNING id, usuario, tenant_id, activo, session_epoch;

   -- ¿Quedan otras cuentas activas de ese negocio? (revisalas: ¿también se desactivan?)
   SELECT usuario, rol, activo FROM wa_usuarios
    WHERE tenant_id = (SELECT tenant_id FROM wa_usuarios WHERE usuario = 'lavacar-rosales');
   ```
   El bot viejo recarga las cuentas cada minuto (`TENANTS_REFRESH_MS`); para que sea al instante:
   `pm2 restart whatsapp-bot` en el droplet. Una cuenta inactiva no entra, sus sesiones abiertas
   dejan de valer y deja de recibir push. **Se confirma:** el `RETURNING` muestra `activo = false`;
   en `https://wabotlavacar.selyon.app/panel` el login con ese usuario da "Usuario o contraseña
   incorrectos", y un navegador que tenía la sesión abierta vuelve al login al recargar.
2. **Prohibir la clave filtrada en el repo.** La hace: Nathan. Dónde: GitHub → Settings → Secrets and
   variables → Actions → `CHECK_SECRETS_DENYLIST` (una cadena por línea; pendiente desde P1.1) y, en
   local, `.secrets-denylist`. **Se confirma:** el job `verify` sigue verde y
   `npm run ci:secrets` local pasa (si alguien la vuelve a pegar en el repo, falla).
3. **Rotar la key de OpenAI del sistema viejo.** La hace: Nathan (dueño de la cuenta) + quien tenga
   SSH al droplet (hoy Sebastián). Dónde: platform.openai.com → proyecto del bot viejo → API keys.
   1. Crear una key nueva (si se puede, en un proyecto con **límite de gasto** mensual).
   2. En el droplet: `nano ~/lavacar-whatsapp-bot/.env` → `OPENAI_API_KEY` = la nueva →
      `pm2 restart whatsapp-bot`.
   3. Mandar un WhatsApp al número del piloto y ver que el bot responda (y `pm2 logs whatsapp-bot`
      sin errores 401 de OpenAI).
   4. **Revocar la key vieja** en el dashboard. Mirar *Usage* de los últimos meses por consumo raro.
   **Se confirma:** la key vieja figura revocada y el bot sigue respondiendo.
4. **Rotar Meta del sistema viejo** (app secret, token y verify token). La hace: Nathan (admin de la
   app y del Business Manager) + quien tenga SSH. En horario de poco tráfico y de una sola vez: entre
   el reset y el restart, los webhooks llegan firmados con el secreto nuevo y el bot los rechaza (Meta
   los reintenta, pero se demoran).
   1. **App secret:** developers.facebook.com → la app → *Configuración de la app* → *Básica* →
      *Clave secreta de la app* → **Restablecer**. Copiala.
   2. **Token de acceso nuevo**, después del reset (resetear el secreto puede invalidar tokens
      emitidos antes): business.facebook.com → *Configuración del negocio* → *Usuarios del sistema* →
      el usuario del bot → *Generar nuevo token* (la app, permisos `whatsapp_business_messaging` y
      `whatsapp_business_management`).
   3. **Verify token nuevo:** `openssl rand -hex 32`.
   4. En el droplet: `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` y, si el bot lo usa ahí,
      `WHATSAPP_ACCESS_TOKEN` en el `.env`; si el token del negocio se cargó desde `/panel/admin`,
      reemplazarlo ahí también. `pm2 restart whatsapp-bot`.
   5. En la app de Meta → *WhatsApp* → *Configuración* → *Webhook* → *Editar*: el verify token nuevo →
      *Verificar y guardar* (Meta llama al webhook y tiene que contestar bien).
   6. **Revocar el token viejo** (en *Usuarios del sistema* → *Revocar tokens*, o la opción
      equivalente).
   **Se confirma:** un WhatsApp al número del piloto tiene respuesta, `pm2 logs whatsapp-bot` no
   muestra firmas rechazadas, y la verificación del webhook en Meta quedó en verde.

> **¿La app de Meta del stack nuevo es la misma? [DECISIÓN PENDIENTE].** El app secret es de la app:
> si el stack nuevo usa la misma app (p. ej. la del Tech Provider del Embedded Signup), comparte por
> definición `WHATSAPP_APP_SECRET` con el sistema viejo mientras los dos vivan. Opción conservadora:
> una app propia para el stack nuevo; si se reutiliza la misma, **se restablece el app secret otra vez
> el día del corte** (§26.8), cuando el `.env` viejo deja de existir.

### 26.2 Inventario del stack nuevo

Todo lo de esta tabla tiene además su copia en el gestor (§26, reglas). "Recargar" = `pm2 reload <app>
--update-env` (web y worker si están separados, §21).

| Secreto | Qué protege (si se filtra…) | Cómo se genera | Dónde vive | Cómo se rota (y qué pasa) |
|---|---|---|---|---|
| `PANEL_SESSION_SECRET` | Firma las sesiones del equipo y del superadmin: con él se **forja la sesión de cualquiera**. | `openssl rand -hex 32` | `.env` | Reemplazar y recargar. Desloguea a **todos** (no hay período de gracia). |
| `TOKENS_ENCRYPTION_KEY` | Cifra los tokens de WhatsApp de cada negocio y el 2FA de cada persona. Junto con un dump de la base, los entrega en claro. | `openssl rand -hex 32`, **antes de cargar datos** | `.env` + gestor (**copia obligatoria**: perderla no tiene arreglo) | Sin herramienta: §20 (re-cifrado manual con la app frenada). |
| `PANEL_SUPERADMIN_HASH` (+ `PANEL_SUPERADMIN_USERNAME`, que no es secreto) | La cuenta que crea, pausa y cambia planes de **todos** los negocios. | Clave larga generada en el gestor → `scripts/hashPassword.ts` (§26.3) | `.env` (solo el hash); la clave, solo en el gestor | Clave nueva → hash → reemplazar → recargar, y subir `PANEL_ADMIN_SESSION_VERSION` (echa las sesiones de admin abiertas). |
| `PANEL_SUPERADMIN_TOTP_SECRET` | Segundo factor del superadmin (obligatorio en producción). | `node --import tsx scripts/generateTotp.ts admin` | `.env` + app autenticadora + gestor | Regenerar, reemplazar, recargar la app autenticadora, recargar y subir `PANEL_ADMIN_SESSION_VERSION`. |
| `DATABASE_URL` (rol `app_runtime`) | La app en la base, con RLS. | `openssl rand -hex 32` como clave del `ALTER ROLE` de `scripts/rls/01-app-role.sql` (§24) | `.env` | Repetir el `ALTER ROLE` con una clave nueva, actualizar la URL y recargar (las conexiones viejas se caen y el pool reconecta). |
| `DATABASE_URL_MIGRATIONS`, `BACKUP_DATABASE_URL` (rol `postgres`) | Dueño de la base: lee y borra todo, sin RLS. | La genera Supabase al crear el proyecto **nuevo** (*Project Settings → Database → Reset database password*) | `.env` | Reset en Supabase y actualizar las dos URLs. La app no se corta si ya corre con `app_runtime`; migraciones y backups usan la nueva. |
| `RESTORE_DATABASE_URL` | Base de prueba del restore (§19.2), con copias de datos reales. | Igual, en ese proyecto separado | `.env` del lugar donde se prueba el restore | Igual. |
| `WHATSAPP_APP_SECRET` | Firma de los webhooks de Meta (y canje del Embedded Signup): con él se **inyectan mensajes falsos**. | Lo genera Meta (*App → Configuración → Básica*) | `.env` | *Restablecer* en Meta, reemplazar y recargar enseguida (en el medio se rechazan webhooks; Meta reintenta). |
| `WHATSAPP_VERIFY_TOKEN` | Verificación del webhook (sin él no se puede repuntar el webhook a otro servidor). | `openssl rand -hex 32` | `.env` + configuración del webhook en Meta | Reemplazar, recargar y en Meta → *Webhook* → *Verificar y guardar*. |
| Tokens de WhatsApp de cada negocio | Mandar mensajes **como el negocio**. | Los da Meta en el Embedded Signup o el alta manual | En la base, cifrados (`whatsapp_channels`) | Reconectar desde el panel (Embedded Signup) o alta manual del superadmin con el mismo `phone_number_id` y token nuevo (`POST /admin/businesses/:id/whatsapp` lo renueva); "Probar" el número; revocar el viejo en Meta. |
| `WHATSAPP_REGISTER_PIN` | PIN de verificación en dos pasos que el Embedded Signup le pone a cada número que registra. | `node -e "console.log(require('crypto').randomInt(0,1e6).toString().padStart(6,'0'))"` | `.env` + gestor | Reemplazar y recargar: aplica a los números que se registren después; los ya registrados se cambian en WhatsApp Manager. |
| `OPENAI_API_KEY` | Gasto de LLM a nuestro nombre. | platform.openai.com → **proyecto propio del stack nuevo** (uno por entorno) con límite de gasto → API keys | `.env` | Crear la nueva, reemplazar, recargar, probar una conversación y revocar la vieja. |
| `STRIPE_SECRET_KEY` | Cobros, reembolsos y datos de clientes. | Stripe → *Developers → API keys* (primero `sk_test_…` en staging; la live, solo en producción) | `.env` | *Roll key* en Stripe (deja viva la vieja el tiempo que elijas), reemplazar, recargar, expirar la vieja. |
| `STRIPE_WEBHOOK_SECRET` | Firma del webhook de Stripe: con él se **marca como pagado** un negocio que no pagó. | Stripe lo da al crear el endpoint (§25) | `.env` | *Roll secret* del endpoint (la vieja puede seguir valiendo unas horas), reemplazar y recargar. |
| `RESEND_API_KEY` | Mandar correo **como nuestro dominio** (phishing a clientes con remitente legítimo). | Resend → *API Keys*, permiso *Sending access*, restringida al dominio | `.env` | Crear la nueva, reemplazar, recargar, mandar una invitación de prueba y borrar la vieja. |
| `SUPABASE_SERVICE_ROLE_KEY` | Acceso total a la API del proyecto (Storage incluido, salteando RLS). | Supabase → *Project Settings → API Keys* del proyecto **nuevo** | `.env` (nunca en el navegador) | Con las API keys nuevas de Supabase: crear otra, reemplazar, recargar, probar una subida y borrar la vieja. Con la `service_role` legacy: solo se rota cambiando el JWT secret del proyecto (rota también la `anon`). |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Firma de las notificaciones push del panel. | `npx web-push generate-vapid-keys` en la carpeta del proyecto (usa el `web-push` 3.6.7 ya instalado; no baja nada) | `.env` (la pública también la ve el navegador: no es secreta) | Reemplazar el par y recargar: las suscripciones viejas dejan de servir y cada persona vuelve a tocar la 🔔. |
| `SENTRY_DSN` | Mandar eventos basura al proyecto de Sentry (no lee datos). | Sentry → proyecto → *Client Keys (DSN)* | `.env` | Crear una clave nueva, reemplazar, recargar y desactivar la vieja. |
| `HEALTH_DETAIL_TOKEN` | Ver el detalle de `/health` (incluye errores internos). | `openssl rand -hex 32` | `.env` + el monitor que lo use | Reemplazar en los dos. |
| `ALERTS_WEBHOOK_URL` | Publicar en el canal de alertas (Slack/Discord). | Lo genera Slack/Discord | `.env` | Regenerar el webhook, reemplazar y borrar el viejo. |
| Credenciales del destino de `BACKUP_COPY_COMMAND` (p. ej. rclone) | La copia externa de los backups (datos de todos los negocios). | En el proveedor del destino, con permiso solo de escritura a esa carpeta si se puede | Config de rclone del servidor (`chmod 600`) | Credencial nueva en el proveedor, reemplazar y borrar la vieja. |
| `DEPLOY_SSH_KEY` | **Shell en el servidor** como el usuario del deploy. | `ssh-keygen -t ed25519` **por entorno** (§26.4) | Privada: secret de GitHub. Pública: `authorized_keys` del servidor. | §26.4: alta de la nueva, prueba, baja de la vieja. |
| `DEPLOY_HOST_KEY` | No es secreto: fija la identidad del servidor (evita un MITM en el deploy). | `ssh-keyscan -t ed25519 <host>`, verificando la huella contra el panel del proveedor (§15, paso 4b) | Secret de GitHub | Cambia solo si se reinstala el servidor. |
| `CHECK_SECRETS_DENYLIST` | Cadenas prohibidas (las que ya se filtraron) para el guardrail `ci:secrets`. | A mano | Secret de GitHub + `.secrets-denylist` local (gitignoreado) | Agregar cada valor filtrado; nunca se saca. |

**No son secretos pero sirven para cortar accesos:** `PANEL_SESSION_VERSION` (+1 = desloguea a todo el
equipo de todos los negocios), `PANEL_ADMIN_SESSION_VERSION` (+1 = echa solo al superadmin) y el logout
de una persona (cierra todas sus sesiones). `META_APP_ID`, `META_ES_CONFIG_ID`, `STRIPE_PRICE_*`,
`SUPABASE_URL` y `VAPID_SUBJECT` son identificadores públicos. Google (Calendar/Places) vuelve en I6:
cuando vuelva, con una cuenta de servicio y una API key **nuevas**, propias del stack nuevo.

### 26.3 Generar el juego nuevo (por entorno)

En la carpeta del proyecto, después de `npm ci`. Cada valor va al gestor y al `.env`; nada a un archivo
suelto ni al chat.

```bash
# 64 hex al azar: PANEL_SESSION_SECRET, TOKENS_ENCRYPTION_KEY, WHATSAPP_VERIFY_TOKEN,
# HEALTH_DETAIL_TOKEN y la clave del rol app_runtime (UN valor distinto para cada uno).
openssl rand -hex 32

# Superadmin: la clave sale del gestor (generada ahí, larga). Se lee sin eco para que no quede
# en el historial ni en pantalla; se imprime solo el hash (salt:hash) → PANEL_SUPERADMIN_HASH.
read -rs PW && node --import tsx scripts/hashPassword.ts "$PW"; unset PW

# Segundo factor del superadmin → PANEL_SUPERADMIN_TOTP_SECRET (+ URI para la app autenticadora, §14).
node --import tsx scripts/generateTotp.ts admin

# Push del panel → VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.
npx web-push generate-vapid-keys

# PIN de registro de números → WHATSAPP_REGISTER_PIN.
node -e "console.log(require('crypto').randomInt(0,1e6).toString().padStart(6,'0'))"
```

Lo demás lo genera cada proveedor (tabla de §26.2). Al arrancar con `NODE_ENV=production`, el proceso
se niega a levantar si algún secreto falta, es un placeholder de `.env.example` o tiene poca entropía
(§23): si arranca, los mínimos están; que sean **nuevos** lo garantiza haberlos generado acá.

### 26.4 Llave SSH de deploy nueva por entorno

Cada servidor tiene su propia llave de CI: no se reutiliza `deploy_ci` del droplet viejo ni ninguna
llave personal.

1. En tu máquina: `ssh-keygen -t ed25519 -f deploy_selyon_prod -N "" -C "github-actions-deploy-prod"`
   (`_staging` para staging).
2. La pública al servidor nuevo, en el usuario que corre la app:
   `cat deploy_selyon_prod.pub | ssh <usuario>@<servidor> "cat >> ~/.ssh/authorized_keys"`.
   Opcional y recomendado: en esa línea de `authorized_keys`, anteponer
   `no-port-forwarding,no-agent-forwarding,no-X11-forwarding ` para que la llave solo sirva para
   el deploy.
3. GitHub → *Settings → Secrets and variables → Actions*: `DEPLOY_SSH_KEY` = el contenido de la
   privada; `DEPLOY_HOST_KEY` = la línea de known_hosts del servidor nuevo (§15, paso 4b); y en
   *Variables*: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_DIR` y `BASE_URL` del servidor nuevo. ⚠️ **Antes
   del primer push a `main` del stack nuevo:** sin esas variables el workflow usa los valores del
   droplet viejo.
4. `rm deploy_selyon_prod deploy_selyon_prod.pub` (la privada vive solo en GitHub; la pública, en el
   servidor).
5. Probar: correr el workflow (deploy o `Run workflow` del rollback con el SHA actual) y ver que el
   paso de SSH conecte y el smoke pase.

Hoy el workflow tiene un solo juego de secrets de deploy (a nivel repo): el job `deploy` usa el
environment `produccion` pero el `rollback` no declara environment. Cuando exista staging, cada
entorno lleva su `DEPLOY_SSH_KEY` como **secret del environment** (*Settings → Environments*) y el
rollback tiene que declarar el suyo; ese cambio del workflow queda para `staging`. Al reemplazar el
secret de repo por la llave nueva, el droplet viejo ya no se puede deployar desde CI (es lo buscado:
`main` pasa a ser el stack nuevo).

**Rotar la llave de deploy:** pasos 1–5 con una llave nueva, y recién con el deploy de prueba verde,
borrar la línea vieja de `authorized_keys` del servidor.

### 26.5 Checklist del día del alta del entorno nuevo

En orden. Cada paso con quién lo hace y dónde se confirma. "Nathan" = dueño de las cuentas (Supabase,
OpenAI, Meta, Stripe, Resend, Sentry, GitHub); "operador" = quien tenga SSH al servidor nuevo.

1. **Antes de empezar** (Nathan): gestor elegido y quién tiene acceso (§26, reglas: hoy
   [PENDIENTE]). Entrada nueva "Selyon CRM — producción".
2. **Servidor** (operador): servidor propio o usuario Unix propio (§26, reglas). `git clone`, `npm ci`.
3. **Secretos propios** (operador): §26.3. Al gestor y al `.env` (`chmod 600`). Se confirma: el gestor
   tiene una entrada por cada fila de §26.2 que aplique, con la fecha.
4. **Base** (Nathan): proyecto de Supabase **nuevo** (no el viejo) → clave del rol `postgres` en
   `DATABASE_URL_MIGRATIONS`/`BACKUP_DATABASE_URL`; migraciones; `scripts/rls/01-app-role.sql` con la
   clave nueva del rol `app_runtime` → `DATABASE_URL` (§24). Se confirma: la verificación del propio
   SQL (`rolbypassrls = false`) y la conexión del rol desde el servidor.
5. **OpenAI** (Nathan): proyecto propio, key nueva y límite de gasto. Se confirma: una conversación de
   prueba responde y el *Usage* aparece en ese proyecto, no en el del bot viejo.
6. **Meta** (Nathan): según la decisión de §26.1 (app propia o la misma). App secret y verify token
   nuevos; webhook apuntando al servidor nuevo (*Verificar y guardar* en verde). Se confirma: un
   mensaje de prueba entra a la bandeja.
7. **Resend, Stripe (modo test primero), Supabase Storage, Sentry, VAPID** (Nathan + operador): una
   key por servicio, propia del entorno (§26.2). Se confirma: invitación de prueba que llega, checkout
   de prueba (§25), subida de una foto, evento de prueba en Sentry, la 🔔 manda la notificación.
8. **Arranque** (operador): `NODE_ENV=production` y levantar. Se confirma: el proceso arranca (si falta
   o es débil algún secreto, sale con la lista, §23) y `/health?detail=1&token=…` da OK.
9. **Deploy key y variables del workflow** (Nathan): §26.4, **antes** del primer push a `main` del
   stack nuevo. Se confirma: primer deploy con smoke verde en *Actions*.
10. **Superadmin** (Nathan): login en `/panel/admin` con clave + código de 6 dígitos (§14). Se
    confirma: entra, y un código ya usado se rechaza.
11. **Calendario** (Nathan): recordatorios de rotación (§26.6) desde la fecha de hoy, anotados en el
    gestor.

### 26.6 Rotación periódica

| Cada | Qué | Nota |
|---|---|---|
| 90 días | `OPENAI_API_KEY`, `RESEND_API_KEY` | Baratas de rotar y caras si se filtran. |
| 6 meses | `DEPLOY_SSH_KEY`, claves de la base (`app_runtime` y `postgres`), credenciales de la copia de backups | §26.4 y tabla de §26.2. |
| 12 meses | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `WHATSAPP_APP_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `HEALTH_DETAIL_TOKEN`, `WHATSAPP_VERIFY_TOKEN` | Con *roll* en Stripe no hay corte. |
| Solo si hay sospecha | `PANEL_SESSION_SECRET` (desloguea a todos), `TOKENS_ENCRYPTION_KEY` (hasta que exista el llavero con `kid`), clave y TOTP del superadmin, VAPID | Rotarlos de rutina cuesta más de lo que protege. |
| Cuando alguien con acceso se va | **Todo** lo que esa persona pudo ver (según la lista de accesos del gestor) | Más sacarle el acceso al gestor, a GitHub y al servidor. |

Cada rotación se anota en el gestor (fecha y quién).

### 26.7 Si se filtra X, hacé Y

Primero cortar (rotar), después investigar. Si el valor pasó por el repo, además va a
`CHECK_SECRETS_DENYLIST` (§26.1, paso 2): el historial no se reescribe, el valor se da por perdido.

| Se filtró | Hacé, en este orden |
|---|---|
| El `.env` entero del servidor | Todo §26.2 que esté en el `.env`. Primero `PANEL_SESSION_SECRET`, `WHATSAPP_APP_SECRET`, `STRIPE_*`, `OPENAI_API_KEY`, `RESEND_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` y las claves de la base; si además pudo haber un dump de la base, también `TOKENS_ENCRYPTION_KEY` (§20) y el token de WhatsApp de cada negocio. |
| Un dump o backup de la base | Las claves de la base (si estaban en el volcado o el lugar del volcado). Los tokens de WhatsApp y los 2FA están cifrados: si `TOKENS_ENCRYPTION_KEY` **no** se filtró, alcanza con eso; si hay duda, §20 + reconectar los números + pedir que reactiven el 2FA. Los datos personales: protocolo de incidentes y avisos que correspondan. |
| `PANEL_SESSION_SECRET` | Generar uno nuevo y recargar (desloguea a todos). Revisar `audit_log` por acciones raras desde la filtración. |
| La clave o el TOTP del superadmin | Clave nueva (hash) y TOTP nuevo, recargar, `PANEL_ADMIN_SESSION_VERSION` +1. Revisar en `audit_log` los logins del superadmin (los rechazados por código inválido avisan que la clave ya se usó). |
| La cookie de una persona del equipo | Que cierre sesión o cambie la clave con la recuperación (las dos cierran todas sus sesiones), o cambiarle el rol o el estado desde Equipo. Si no se sabe de quién: `PANEL_SESSION_VERSION` +1. |
| `WHATSAPP_APP_SECRET` | *Restablecer* en Meta y recargar enseguida. Revisar la bandeja por mensajes que nadie mandó. |
| El token de WhatsApp de un negocio | Revocarlo en Meta, reconectar el número (§26.2) y avisar al negocio. |
| `OPENAI_API_KEY` | Revocar en el dashboard ya (no esperar a tener la nueva: mientras tanto el agente falla y las conversaciones pasan a una persona), key nueva, recargar, revisar *Usage*. |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | *Roll* con expiración inmediata, recargar, revisar en Stripe pagos, reembolsos y eventos de las últimas horas, y en Configuración › Plan que ningún negocio haya quedado "Al día" sin pagar. |
| `RESEND_API_KEY` | Borrar la key en Resend, crear otra, recargar; revisar los envíos recientes en Resend. |
| `SUPABASE_SERVICE_ROLE_KEY` | Rotarla (§26.2) y revisar los logs de Storage/API en Supabase. |
| `DEPLOY_SSH_KEY` | Borrar su línea de `authorized_keys` del servidor **ya**, generar otra (§26.4) y revisar `~/.ssh/authorized_keys`, `crontab -l`, los procesos y el último login (`last`) por cambios que nadie hizo. |
| `TOKENS_ENCRYPTION_KEY` sola | Grave solo junto con la base; igual se rota (§20) en la próxima ventana. |
| Una key de un proveedor que no está en la tabla | Revocarla en el proveedor, crear otra, sumarla a §26.2. |

### 26.8 Al cortar el sistema viejo

Cuando el bot del lavacar se apague (decisión del usuario: el resto del sistema viejo no se rota, se
apaga). La hace: Nathan + quien tenga SSH al droplet viejo.

1. `pm2 delete whatsapp-bot` en el droplet viejo (sin tocar selyon) y borrar su `.env`
   (`shred -u ~/lavacar-whatsapp-bot/.env`).
2. Revocar la key de OpenAI que usaba (o archivar ese proyecto).
3. Meta: revocar el token del usuario del sistema y, si el stack nuevo usa la **misma** app,
   restablecer el app secret (y cargar el nuevo en el stack nuevo) — §26.1, decisión pendiente.
4. Supabase viejo: backup final guardado donde corresponda y pausar/borrar el proyecto.
5. Sacar la llave de CI vieja (`github-actions-deploy`) del `authorized_keys` de `sebastian` en el
   droplet viejo, y borrar la deploy key de solo lectura (`~/.ssh/deploy_whatsapp_lavacar` en el
   droplet y GitHub → *Settings → Deploy keys*).
6. DNS: borrar o redirigir `wabotlavacar.selyon.app`.

Se confirma: `https://wabotlavacar.selyon.app/panel` deja de responder, el proyecto viejo de Supabase
figura pausado o borrado, y GitHub no tiene deploy keys ni secrets que apunten al droplet viejo.

## Mantenimiento rápido

| Acción | Comando |
|---|---|
| Ver estado | `pm2 status` |
| Ver registros | `pm2 logs whatsapp-bot` |
| Reiniciar | `pm2 restart whatsapp-bot` |
| Actualizar el código (manual, red de seguridad — lo normal es el push a `main`) | `cd ~/lavacar-whatsapp-bot && git checkout main && git pull && npm ci && node --import tsx scripts/migrate.ts && npm ci --prefix web --include=dev && npm run build --prefix web && pm2 restart whatsapp-bot` |
| Revertir un deploy malo (solo código, ver **Rollback** arriba) | Actions → CI/CD → **Run workflow**, con `sha` vacío o el commit al que volver |

**Landing de venta (ROADMAP C4.4):** vive en `landing/` (HTML/CSS estático, sin build) y la sirve
el mismo proceso Node en el root del dominio (`GET /`). No agrega pasos al redeploy — el `git pull`
de la fila de arriba ya la trae. Si algo (uptime monitor, script de verificación) usaba `GET /` como
health check, ahora es `GET /health` (el texto "Agente de WhatsApp corriendo ✅" se movió ahí).

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
