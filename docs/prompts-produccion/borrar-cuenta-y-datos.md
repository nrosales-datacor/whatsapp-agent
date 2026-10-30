# Borrado de datos: cliente completo, cuenta de usuario, baja del negocio y retención

> **Punto del checklist:** let users delete their account and data · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P1 antes de 5 clientes
> **Tipo:** mixto · **Depende de:** privacidad-y-terminos, backups · **Esfuerzo:** 2–3 días
> **Archivos principales:** `src/modules/clients/service.ts`, `src/modules/whatsapp/eraser.ts`, `src/routes.ts`, `src/modules/team/`, `src/admin/routes.ts`, `src/jobs.ts`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
Lo que YA está:
- **Suprimir un cliente final** (solo dueño): `POST /clients/:id/anonymize` (`src/modules/clients/routes.ts:348`) → `anonymizeClient` (`src/modules/clients/service.ts:600`): confirma con teléfono/nombre, limpia nombre, teléfono, email, notas, etiquetas, `customData`, consentimiento, marca `anonymized_at`, corre los `erasers` y deja rastro sin PII en `audit_log`. Único eraser registrado: `whatsappClientEraser` (`src/routes.ts:117`, `src/modules/whatsapp/eraser.ts:23`), que borra conversaciones/mensajes y encola el borrado de adjuntos en Storage (`handleMediaEraseJob`). Tests: `test/security/clients.test.ts` ("anonimizar: …", "RLS…").
- Desactivar una membresía del equipo (`updateMember`, `src/modules/team/members.ts:198`, que sube el epoch en `:249`), desactivar un profesional (`staff.active = false`, `src/modules/team/staff.ts:407`) y pausar/reactivar un negocio desde el superadmin (`POST /admin/businesses/:id/pause|reactivate`, `src/admin/routes.ts:148/166`).
- Retención parcial que YA existe (no rehacer): `purgeRawWebhooks` (`src/modules/whatsapp/rawWebhooks.ts:109`, `WHATSAPP_RAW_WEBHOOK_RETENTION_DAYS`, default 7) y `purgeFinishedJobs` (`src/platform/queue/admin.ts:110`, llamado en el loop de `src/platform/queue/worker.ts:348`).

Lo que falta:
1. **La supresión del cliente deja PII en otras tablas:** `appointments.notes`, `appointments.custom_data`, `appointments.cancellation_reason` (`src/modules/scheduling/schema.ts:77-84`), `payments.note` (`src/modules/sales/schema.ts:73`) y `follow_ups.response_text` (la respuesta libre del cliente a la encuesta post-servicio, `followUps` en `src/modules/whatsapp/schema.ts:306`, ligada a la cita y NO a la conversación, así que `whatsappClientEraser` no la toca). `quotes` y `campaign_sends` (`src/modules/campaigns/schema.ts:74`) no guardan texto personal pero sí `client_id`. No hay eraser de scheduling ni sales.
2. **No existe borrar la propia cuenta de usuario** (persona del equipo): ni ruta ni servicio; solo desactivación por un dueño/admin. El `users` (nombre, email, hash, 2FA) queda para siempre.
3. **No existe la baja definitiva de un negocio** (borrado o anonimización de todos sus datos tras un plazo); solo pausa. Tampoco exportación completa de datos del negocio para entregarle al cerrar (solo `GET /clients/export.csv`).
4. **Retención incompleta y sin política escrita**: fuera de `raw_webhooks` y `jobs` (ver arriba), mensajes de WhatsApp, `audit_log`, tokens vencidos de `auth_tokens` (solo se borran los del mismo alcance al emitir uno nuevo, `issueAuthToken` en `src/modules/team/tokens.ts:48`) y backups (DEPLOY.md §19) se conservan sin límite; un dato suprimido sigue en backups hasta que roten.

## Objetivo
Que un dueño pueda suprimir a un cliente sin dejar PII en ninguna tabla, que una persona pueda cerrar su cuenta, que la plataforma pueda dar de baja un negocio con exportación previa y borrado verificable, y que la retención esté definida y automatizada.

## Alcance
- Erasers nuevos inyectados en `clientErasers` (`src/routes.ts:117`): scheduling (notas, `customData`, motivo de cancelación de sus citas), sales (notas de pagos) y whatsapp (`follow_ups.response_text` de las citas del cliente). Test: tras anonimizar, un `SELECT` sobre cada tabla con `client_id` no contiene el teléfono/nombre/email originales.
- `DELETE /auth/account` (o `POST /auth/account/delete`) con clave + 2FA si lo tiene: anonimiza `users` (email → marcador único, nombre, hash, TOTP), desactiva membresías, sube el epoch; bloquea si es el último dueño de un negocio activo (reusar la regla de "último dueño"). Pantalla en el panel (Configuración › Mi cuenta).
- Superadmin: `POST /admin/businesses/:id/offboard` que exige el negocio pausado N días, genera export (CSV/JSON por módulo) y luego borra o anonimiza todo lo del negocio (incluido Storage), dejando un registro mínimo en `audit_log`. Job en la cola, idempotente.
- Barrido de retención (loop con lease en `src/jobs.ts`, siguiendo el patrón de `purgeRawWebhooks`): `auth_tokens` vencidos/usados y, si se aprueba, mensajes viejos y `audit_log`; plazos por env.
- Documento corto (sección en DEPLOY.md o `docs/`) con la política de retención y qué pasa con los backups.

## Fuera de alcance
- Textos legales (política de privacidad, términos, DPA) → `privacidad-y-terminos`.
- Rotación/retención de los backups en sí y restore → `backups`, `restore-probado`.
- Banner de cookies: no aplica hoy (no hay cookies no esenciales).

## Pasos sugeridos
1. Inventariá tablas con `client_id`/`user_id`/`business_id` (`src/platform/db/schema.ts` y `src/modules/*/schema.ts`) y anotá columnas con PII.
2. Erasers por módulo (cada módulo exporta el suyo; la composición en `src/routes.ts`; respetá `test/architecture/moduleBoundaries.test.ts`).
3. Borrado de cuenta propia (backend + panel + E2E en mock).
4. Offboarding del negocio (job + export + test sobre PGlite que verifica cero filas del negocio salvo el registro de auditoría).
5. Barrido de retención + tests con reloj inyectado.
6. Docs y ROADMAP.

## Decisiones que el agente NO toma solo
- Plazos: días de pausa antes de la baja definitiva, retención de mensajes de WhatsApp, `audit_log`, webhooks crudos, backups.
- ¿Borrado físico o anonimización para el negocio dado de baja? ¿Se conservan datos de facturación por ley (Costa Rica, Hacienda)?
- ¿El cliente final puede pedir su supresión por WhatsApp (p. ej. "BORRAR") o solo vía el negocio?
- Correr cualquier borrado en producción.

## Criterios de aceptación
- [ ] Test: tras `POST /clients/:id/anonymize` no queda el nombre/teléfono/email del cliente en ninguna tabla (consulta sobre todas las tablas con `client_id`).
- [ ] Test: borrar la propia cuenta cierra sesiones, libera el email y respeta "último dueño".
- [ ] Test: offboarding deja el negocio sin filas (salvo auditoría) y encola el borrado de Storage.
- [ ] Barrido de retención con tests.
- [ ] `npm run typecheck` y `npm test` en verde (y `npm --prefix web run typecheck` + E2E mock si toca el panel).
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización").

## Reglas para este trabajo
- Rama propia `prod/borrar-cuenta-y-datos` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist de pasos humanos pendientes (plazos aprobados, revisión legal, primer barrido en producción).
