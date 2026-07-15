# GUÍA — Trámites en Meta (plantilla de recordatorios + Embedded Signup)

> Dos trámites que corren por fuera del código y conviene arrancar YA porque tienen tiempos de
> espera de Meta. Esta guía deja los pasos exactos. Actualizá el estado acá cuando avance cada uno.

**Última actualización:** 2026-07-10 (C4.2: código de Embedded Signup implementado; falta el trámite Meta + las env vars)

| Trámite | Estado | Bloquea |
|---|---|---|
| A. Plantilla Utility `recordatorio_cita` | ⏳ esperando aprobación de Meta | Recordatorios fuera de 24h (y C1.3/C3.1 construyen encima) |
| B. Tech Provider + Embedded Signup | ⬜ trámite Meta sin empezar (⚠️ el **código** de C4.2 ya está listo) | Que el botón "Conectar WhatsApp" del onboarding funcione contra Meta. No bloquea nada del piloto (el alta manual sigue). |
| C. Plantilla MARKETING para campañas | ⬜ sin empezar | Envío real de campañas (C3.2). El código y el panel ya están listos; sin la plantilla aprobada, "Campañas" queda configurada pero no puede enviar. |

---

## A. Plantilla Utility de recordatorios

### Qué es y por qué

Fuera de la ventana de 24h del último mensaje del cliente, WhatsApp solo acepta **plantillas
aprobadas**. El recordatorio del día antes casi siempre cae fuera de esa ventana → sin plantilla,
ese recordatorio **no sale**. El código ya está listo (`src/reminders/scheduler.ts` +
`enviarPlantilla` en `src/whatsapp/client.ts`); solo falta la plantilla aprobada y su nombre en
el `.env`.

### Contenido exacto para crearla

En **WhatsApp Manager** (business.facebook.com → cuenta de WhatsApp del bot) → *Herramientas de
cuenta* → *Plantillas de mensaje* → **Crear plantilla**:

- **Categoría:** Utility (NO Marketing — Utility se aprueba más fácil y cuesta menos).
- **Nombre:** `recordatorio_cita` (minúsculas y guiones bajos; este nombre va al `.env`).
- **Idioma:** Español (`es`).
- **Cuerpo** (3 variables, como espera el código: `{{1}}` nombre, `{{2}}` servicio, `{{3}}` cuándo):

  > ¡Hola {{1}}! Te recordamos tu cita en Lavacar Rosales {{3}}: {{2}}. Si necesitás reprogramar,
  > escribinos por acá. ¡Te esperamos!

- **Ejemplos de variables** (Meta los pide para revisar): `{{1}}` = "María", `{{2}}` = "Pulido de
  parabrisas", `{{3}}` = "mañana a las 8:00 a.m.".
- **Sin botones por ahora** (el flujo de confirmación con botones es C1.3 del plan de valor; se
  puede editar la plantilla o crear una segunda versión cuando toque).

### Cómo verificar la aprobación y activarla

1. El estado se ve en WhatsApp Manager → Plantillas (Pendiente → Aprobada/Rechazada). Utility
   suele resolverse en minutos u horas; si pasa de 48h, revisar si pidió cambios.
2. Aprobada → en el droplet, en `~/lavacar-whatsapp-bot/.env`:
   ```
   WHATSAPP_TEMPLATE_RECORDATORIO=recordatorio_cita
   ```
3. `pm2 restart whatsapp-bot`.
4. Probar: crear una cita para mañana y esperar el tick de las 17:00 (o bajar
   `RECORDATORIO_DIA_ANTES_HORA` temporalmente) → el cliente debe recibir la plantilla.

### Si la rechazan

Los rechazos de Utility casi siempre son por texto que "suena a marketing". Quitar exclamaciones
promocionales, dejar solo el dato de la cita, y re-someter. Se puede apelar desde el mismo panel.

---

## B. Tech Provider + Embedded Signup (para C4.2)

### Qué es y por qué arrancarlo ya

El **Embedded Signup** permite que un negocio nuevo conecte su WhatsApp Business desde nuestro
onboarding con un popup de Facebook (sin tocar Meta a mano ni `.env`). Para ofrecerlo hay que ser
**Tech Provider** de Meta, y ese trámite tiene revisiones (verificación de negocio + App Review)
que toman días o semanas. **No bloquea nada del piloto** — por eso conviene meterlo a la cola ya y
que "cocine" mientras seguimos con C1–C3.

Dato clave de capacidad: sin completar el proceso se pueden dar de alta **10 negocios por semana**;
con Business Verification + App Review + Access Verification completos, el límite sube a **200 por
semana** — más que suficiente para la etapa SaaS.

### Requisitos previos

- **App de Meta** con caso de uso WhatsApp (ya existe: es la app del bot) conectada a un
  **portafolio de negocio** (Business Manager).
- **Negocio verificable**: nombre legal, dirección, teléfono, email con dominio propio y **sitio
  web** público. _La landing ya existe (C4.4, `landing/`): sirve como sitio web público y trae la
  URL de política de privacidad que pide App Review: `https://<dominio>/privacidad`._

### Pasos del trámite (en orden)

1. **Business Verification** (Business Manager → Configuración del negocio → Centro de seguridad →
   Verificación del negocio): datos legales + documento de respaldo si Meta no encuentra el negocio.
   Es el paso más lento; arrancarlo primero.
2. **Preparar la app para App Review** (developers.facebook.com → la app):
   - Ícono de la app, **URL de política de privacidad** (otra razón para la página mínima),
     categoría.
   - **Dos videos de demostración**: (a) un mensaje creado y enviado desde nuestra app (el panel
     sirve), (b) la creación de una plantilla desde nuestra app — si no tenemos UI de plantillas,
     mostrar el flujo que sí existe y documentar el caso de uso.
3. **App Review — pedir acceso avanzado** a los dos permisos:
   - `whatsapp_business_messaging` (enviar mensajes en nombre de los clientes),
   - `whatsapp_business_management` (administrar las WABAs de los clientes).
4. **Elegir modalidad**: Tech Provider independiente (nuestro caso — cada negocio paga su propia
   cuenta de WhatsApp con su método de pago) — NO hace falta Solution Partner.
5. **Access Verification** (aparece tras el App Review) para subir el límite de onboarding a 200/semana.
6. **Crear una "configuración de Embedded Signup"** (en la app de Meta → WhatsApp → Configuración de
   Embedded Signup): define qué permisos y qué pasos ve el negocio en el popup. Anotá su **config id**.

### El código de C4.2 ya está implementado

El flujo técnico ya vive en el repo (no espera al trámite): el onboarding (`/panel/admin`) muestra
un botón **"Conectar WhatsApp con Meta"** que abre el popup (FB Login for Business), y el backend
canjea el código por el token, suscribe la app a los webhooks del WABA y registra el número —
guardando todo en `wa_tenants` con el alta sin redeploy de B2/B3. Piezas: `src/whatsapp/embeddedSignup.ts`,
rutas `/api/panel/admin/embedded-signup/*` en `src/panel/router.ts`, y `web/src/lib/embeddedSignup.ts`.

**Para activarlo** (una vez aprobado el trámite de arriba), en el `.env` del droplet:

```
META_APP_ID=<id público de la app de Meta>
META_ES_CONFIG_ID=<config id del paso 6>
WHATSAPP_REGISTER_PIN=<PIN de 6 dígitos para registrar el número; elegilo y guardalo>
# (WHATSAPP_APP_SECRET ya está: se reutiliza para el intercambio del código)
```

Con esas variables presentes, el botón aparece solo en el onboarding. Sin ellas es un **no-op total**:
el formulario cae al ingreso manual de `phone_number_id` + `accessToken` de siempre.

### Mientras tanto

El alta asistida por admin (`/panel/admin`) con ingreso manual sigue siendo el camino: funciona hoy y
no depende de este trámite (y queda como fallback "avanzado" incluso con Embedded Signup activo).

**Fuentes:** [Become a Tech Provider (Meta)](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers) ·
[Embedded Signup overview (Meta)](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview) ·
[Guía del programa Tech Provider (Twilio)](https://www.twilio.com/docs/whatsapp/isv/tech-provider-program/integration-guide)

---

## C. Plantilla MARKETING para campañas segmentadas (para C3.2)

### Qué es y por qué

Las campañas del panel ("Campañas" → armar un segmento del CRM y mandarle una promo) salen
SIEMPRE por plantilla **MARKETING** — a diferencia del recordatorio (Utility), acá SÍ es
publicidad, así que Meta exige la categoría correcta. El código y el panel ya están listos
(`src/campaigns/`, pestaña "Campañas"); sin la plantilla aprobada, el dueño puede armar y
previsualizar campañas pero no enviarlas.

Cada tenant necesita **su propia** plantilla aprobada en su propio WhatsApp Manager (no se
comparte entre negocios) — el nombre se configura por negocio en el panel, pestaña "Mi negocio"
→ "Plantilla de marketing aprobada".

### Contenido exacto para crearla

En **WhatsApp Manager** (business.facebook.com → cuenta de WhatsApp del negocio) → *Herramientas
de cuenta* → *Plantillas de mensaje* → **Crear plantilla**:

- **Categoría:** Marketing.
- **Nombre:** el que prefieras (minúsculas y guiones bajos, ej. `promo_general`); ese nombre exacto
  va en "Mi negocio" → "Plantilla de marketing aprobada".
- **Idioma:** Español (`es`).
- **Cuerpo** (2 variables: `{{1}}` nombre del cliente, `{{2}}` el mensaje libre que el dueño escribe
  al armar cada campaña). El opt-out DEBE estar en el texto que Meta aprueba (no alcanza con
  manejarlo aparte en el código):

  > ¡Hola {{1}}! {{2}} Escribinos si querés agendar. Para no recibir más promociones de nuestra
  > parte, respondé *BAJA*.

- **Ejemplos de variables**: `{{1}}` = "María", `{{2}}` = "Tenemos 20% de descuento en pulido de
  parabrisas esta semana 🚗✨".
- **Sin botones**: el opt-out es por palabra clave ("BAJA", que el bot ya detecta como comando
  exacto — ver `handleWebhook.ts`), no por botón — más simple de aprobar y de mantener.

### Cómo verificar la aprobación y activarla

1. El estado se ve en WhatsApp Manager → Plantillas. Marketing tarda un poco más que Utility en
   aprobarse (puede pasar de horas a 1-2 días); si la rechazan, casi siempre es por texto ambiguo
   o por faltar la opción de baja explícita.
2. Aprobada → en el panel del negocio, pestaña "Mi negocio" → "Plantilla de marketing aprobada" →
   escribir el nombre exacto (ej. `promo_general`) → Guardar. Sin redeploy: el cambio queda activo
   apenas se guarda (mismo mecanismo que el resto de "Mi negocio", C2.2).
3. Probar con una campaña chica (2-3 destinatarios de prueba, ej. tu propio número) antes de
   mandarla a un segmento real.

### Si la rechazan

Igual que la Utility: quitar ambigüedad, dejar el opt-out ("BAJA") explícito en el cuerpo, y
re-someter. Meta es más estricto con Marketing que con Utility — evitar mayúsculas sostenidas,
signos de exclamación excesivos o lenguaje que suene a spam.

---

## D. Plantilla de UTILIDAD para reabrir conversaciones (para Carril D, 0.3)

### Qué es y por qué

La ventana de sesión de WhatsApp dura 24 h desde el último mensaje del cliente; pasado ese
tiempo, el panel bloquea el texto libre (chip 🔴 "ventana cerrada" en el chat) y el único
camino para retomar la conversación es una plantilla **aprobada**. El botón "Reabrir
conversación" del chat manda esta plantilla (`src/whatsapp/client.ts`, `enviarPlantilla` con
categoría `"utilidad"`); sin ella configurada, el botón no aparece y solo queda esperar a que
el cliente escriba de nuevo.

Cada tenant necesita su propia plantilla aprobada; el nombre se configura en "Mi negocio" →
"Ventana de 24 horas" → "Plantilla de reapertura aprobada".

### Contenido exacto para crearla

En **WhatsApp Manager** → *Plantillas de mensaje* → **Crear plantilla**:

- **Categoría:** Utility (no Marketing — no es una promoción, es continuar una conversación
  de servicio ya iniciada).
- **Nombre:** minúsculas y guiones bajos (ej. `reapertura_conversacion`); ese nombre exacto va
  en "Mi negocio" → "Ventana de 24 horas".
- **Idioma:** Español (`es`).
- **Cuerpo** (sin variables, el código hoy la manda sin parámetros):

  > ¡Hola! Quedamos pendientes de tu consulta 🙂 Escribinos cuando quieras y seguimos donde lo
  > dejamos.

### Cómo verificar la aprobación y activarla

1. Utility suele aprobarse más rápido que Marketing (horas, no días).
2. Aprobada → "Mi negocio" → "Ventana de 24 horas" → escribir el nombre exacto → Guardar (sin
   redeploy, mismo mecanismo que el resto de "Mi negocio").
3. Probar reabriendo una conversación de prueba (tu propio número) antes de depender de ella
   con un cliente real.
