# GUÍA — Trámites en Meta (plantilla de recordatorios + Embedded Signup)

> Dos trámites que corren por fuera del código y conviene arrancar YA porque tienen tiempos de
> espera de Meta. Esta guía deja los pasos exactos. Actualizá el estado acá cuando avance cada uno.

**Última actualización:** 2026-07-03

| Trámite | Estado | Bloquea |
|---|---|---|
| A. Plantilla Utility `recordatorio_cita` | ⏳ esperando aprobación de Meta | Recordatorios fuera de 24h (y C1.3/C3.1 construyen encima) |
| B. Tech Provider + Embedded Signup | ⬜ sin empezar | C4.2 (alta self-serve). No bloquea nada del piloto |

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
  web** público. _Ojo: hoy no hay landing (C4.4) — el sitio web es requisito práctico de la
  verificación, así que C4.4 puede necesitar adelantarse a una página mínima._

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
6. Con todo aprobado: implementar el flujo técnico (Facebook Login for Business + config de
   Embedded Signup + intercambio de token → guardar `phone_number_id` + token en `wa_tenants`).
   **Eso es C4.2 del `PLAN-VALOR-PRODUCTO.md`** — el alta sin redeploy ya quedó lista con B2/B3.

### Mientras tanto

El alta asistida por admin (`/panel/admin`) sigue siendo el camino: funciona hoy y no depende de
este trámite.

**Fuentes:** [Become a Tech Provider (Meta)](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers) ·
[Embedded Signup overview (Meta)](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview) ·
[Guía del programa Tech Provider (Twilio)](https://www.twilio.com/docs/whatsapp/isv/tech-provider-program/integration-guide)
