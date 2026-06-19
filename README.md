# Agente de WhatsApp con IA — soporte + agenda

Proyecto **individual y ejecutable**: un agente de atención por WhatsApp para un
lavacar (o cualquier negocio de servicios), potenciado con IA. Responde dudas de
precios/horarios/servicios y agenda pulidos. Tenant cargado: **Lavacar Rosales**.

Cumple la política de Meta: es un agente de **soporte acotado**, no un asistente
general. Si le piden algo fuera de alcance, redirige con amabilidad.

## Cómo correrlo (rápido, sin base de datos)

1. Instalá dependencias:
   ```
   npm install
   ```
2. Copiá `.env.example` a `.env` y llená:
   - `OPENAI_API_KEY` (tu llave de OpenAI)
   - las credenciales del **número de prueba** de Meta (`WHATSAPP_*`)
3. Levantá el servidor:
   ```
   npm run dev
   ```
   Vas a ver: `Agente escuchando en http://localhost:3000` y el webhook en `/webhook`.
4. Exponé el `localhost` con un túnel para que Meta lo alcance:
   ```
   npx ngrok http 3000
   ```
5. En el panel de Meta, configurá el webhook con la URL de ngrok + `/webhook` y tu
   `WHATSAPP_VERIFY_TOKEN`. Escribile al número de prueba desde tu WhatsApp. ✅

> Sin `DATABASE_URL`, el agente usa almacenamiento **en memoria** (no persiste,
> ideal para probar). Reiniciás el server y se borra.

## Cómo funciona

```
WhatsApp → POST al webhook (src/server.ts)
             │  valida la firma, responde 200 rápido
             ▼
        handleWebhook.ts ── rutea por número, opt-in, escotilla a humano
             ▼
        runAgent.ts ──▶ OpenAI (gpt-4o-mini) + herramientas
             │              ├─ consultar_disponibilidad (pulidos)
             │              └─ agendar_cita (pulidos) ──▶ Google Calendar (opcional)
             ▼
        Repositorio (memoria  ó  PostgreSQL/Drizzle)
             ▲
        reminders/scheduler.ts ── recordatorios por WhatsApp (día antes + mismo día)
```

Regla de negocio: los **lavados son por orden de llegada** (sin cita); solo los
**pulidos se agendan**.

## Mapa de archivos

| Archivo | Qué hace |
|---|---|
| `src/server.ts` | Servidor HTTP. El punto de entrada (`npm run dev`). |
| `src/handleWebhook.ts` | Orquestador: ruteo, opt-in, agente, envío, monitoreo. |
| `src/config/tenants.ts` | Datos del negocio (Lavacar Rosales ya cargado). **Editá acá.** |
| `src/agent/systemPrompt.ts` | Prompt acotado (cumplimiento Meta). |
| `src/agent/tools.ts` | Herramientas (consultar disponibilidad, agendar). |
| `src/agent/runAgent.ts` | Loop con OpenAI + candado de agendado. |
| `src/booking/availability.ts` | Cálculo de espacios libres. |
| `src/booking/inMemoryRepository.ts` | Almacenamiento en memoria (default). |
| `src/booking/drizzleRepository.ts` | Almacenamiento en PostgreSQL. |
| `src/db/schema.ts` · `src/db/client.ts` | Tablas y cliente de base de datos. |
| `src/whatsapp/client.ts` | Verificación, firma, parseo y envío a Meta (texto y plantillas). |
| `src/calendar/googleCalendar.ts` | Crea el evento de cada cita en Google Calendar. |
| `src/reminders/scheduler.ts` | Recordatorios por WhatsApp: día antes y mismo día. |

## Google Calendar (opcional)

Cada cita agendada se crea como evento en el calendario del negocio, con el
**nombre y teléfono del cliente**, el servicio y la placa, más alertas para el
negocio (1 día antes y 2 h antes).

Setup (una vez, ~10 min):

1. En [Google Cloud Console](https://console.cloud.google.com): creá un proyecto
   y habilitá la **Google Calendar API**.
2. Creá una **Service Account** (IAM y administración → Cuentas de servicio) y
   descargá su llave JSON.
3. En el Google Calendar del negocio → Configuración → *Compartir con
   determinadas personas* → agregá el email de la service account con permiso
   **"Hacer cambios en eventos"**.
4. En `.env` llená `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY` (la
   `private_key` del JSON, en una línea con `\n`) y `GOOGLE_CALENDAR_ID` (el ID
   del calendario; para el principal es el propio gmail).

Si las variables no están, la integración queda apagada y todo lo demás funciona.

## Recordatorios de cita (automáticos)

El servidor revisa las citas cada 5 min y envía por WhatsApp:

- **Día antes**: a partir de las 17:00 del día anterior (`RECORDATORIO_DIA_ANTES_HORA`).
- **Mismo día**: 2 horas antes de la cita (`RECORDATORIO_HORAS_ANTES`), nunca antes de las 6 am.

Cada envío queda marcado en la cita para no duplicarse. Si el servidor estaba
apagado a la hora del envío, lo manda al arrancar (si todavía tiene sentido).

> ⚠️ **Ventana de 24 h de Meta**: fuera de las 24 h del último mensaje del
> cliente, WhatsApp solo acepta **plantillas aprobadas**. Para producción, creá
> en el WhatsApp Manager una plantilla (categoría *Utility*) con 3 variables —
> `{{1}}` nombre, `{{2}}` servicio, `{{3}}` cuándo — y poné su nombre en
> `WHATSAPP_TEMPLATE_RECORDATORIO`. Ejemplo de cuerpo:
> *"¡Hola {{1}}! Te recordamos tu cita en Lavacar Rosales {{3}}: {{2}}. Si
> necesitás reprogramar, escribinos por acá. ¡Te esperamos!"*
> Sin plantilla configurada se intenta texto libre, que sirve para probar con
> el número de prueba de Meta.

## Usar base de datos (opcional, para producción)

1. Poné tu `DATABASE_URL` en `.env` (PostgreSQL).
2. Creá las tablas:
   ```
   npm run db:generate
   npm run db:migrate
   ```
3. Reiniciá: al detectar `DATABASE_URL`, el agente guarda en PostgreSQL solo.

## Notas de seguridad

- `drizzle-orm` fijado en `^0.45.2` (cierra el CVE-2026-39356).
- `openai` 6.x; los mensajes pasan por su API (no se usan para entrenar por
  defecto, retención de 30 días). Valorar Zero Data Retention si se requiere.
- El `.env` con secretos **no se sube al repo** (está en `.gitignore`).
- Confirmá la versión vigente del Graph API (`GRAPH_API_VERSION`) y el costo por
  mensaje de Meta antes de producción.
