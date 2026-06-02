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
             │              └─ agendar_cita (pulidos)
             ▼
        Repositorio (memoria  ó  PostgreSQL/Drizzle)
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
| `src/whatsapp/client.ts` | Verificación, firma, parseo y envío a Meta. |

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
