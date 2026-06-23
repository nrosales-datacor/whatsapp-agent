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

La versión nueva agrega el panel web en `/panel`. Necesita **dos secretos nuevos en el
`.env`** y **correr las migraciones** (la base cambió: columnas `modo`, `no_leidos`,
`notas`, `precio`, campos de Google Calendar y la tabla `wa_push_subs`).

> ⚠️ Sin `PANEL_SESSION_SECRET` el servidor **NO arranca en producción** (se cae el
> bot que ya funciona). Sin `PANEL_PASSWORD_HASH_ROSALES` nadie puede entrar al panel.

```bash
cd ~/lavacar-whatsapp-bot
nano .env        # agregá las DOS líneas que te pasó Nathan (PANEL_SESSION_SECRET y
                 # PANEL_PASSWORD_HASH_ROSALES). Guardá: Ctrl+O, Enter, Ctrl+X.
git pull
npm install
npx tsx scripts/migrar.ts        # crea/actualiza las tablas (idempotente)
pm2 restart whatsapp-bot
pm2 logs whatsapp-bot            # debe decir "Agente escuchando", sin errores de PANEL_SESSION_SECRET
```

Probá en el navegador (PC o celular): **https://wabotlavacar.selyon.app/panel**
Usuario `lavacar-rosales`, contraseña `lavacar2026` (cambiala cuanto antes).

## Mantenimiento rápido

| Acción | Comando |
|---|---|
| Ver estado | `pm2 status` |
| Ver registros | `pm2 logs whatsapp-bot` |
| Reiniciar | `pm2 restart whatsapp-bot` |
| Actualizar el código | `cd ~/lavacar-whatsapp-bot && git pull && npm install && npx tsx scripts/migrar.ts && pm2 restart whatsapp-bot` |

## Si algo falla
- El bot no arranca → `pm2 logs whatsapp-bot` (suele ser algo del `.env`).
- No llega el HTTPS → revisá que el registro A de `wabotlavacar.selyon.app` en
  Cloudflare apunte a `157.230.190.60` y que el firewall tenga abierto 80/443.
- El bot no responde por WhatsApp → repetí el paso 11 y revisá los logs.
- Cualquier duda con nginx/selyon → mandá la salida de `sudo nginx -T` y te ayudamos.
