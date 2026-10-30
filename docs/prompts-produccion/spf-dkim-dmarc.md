# Correo de plataforma que llega: Resend, SPF, DKIM y DMARC

> **Punto del checklist:** configure email auth (SPF/DKIM/DMARC) · **Estado en `5f976e1`:** ❌ falta · **Prioridad:** P0 antes del primer cliente que pague
> **Tipo:** mixto · **Depende de:** dominio-y-ssl · **Esfuerzo:** 0,5 día de código + DNS (propagación 1–48 h)
> **Archivos principales:** `src/platform/email/email.ts`, `src/platform/email/resend.ts`, `src/platform/config/requiredSecrets.ts`, `.env.example`, `DEPLOY.md`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
- El código de correo está completo: `sendEmail()` (`src/platform/email/email.ts:95`) con proveedor por env (`resolveEmailConfig`, `:44`): `resend` (API HTTP, `src/platform/email/resend.ts`) o `log` (no envía). En producción sin config válida falla cerrado con alerta. Remitente por defecto `DEFAULT_EMAIL_FROM` = `no-reply@selyon.app` (`email.ts:32`). Todo sale por la cola (`email.send`, `src/platform/email/job.ts`) con outbox transaccional (`queueEmail`, `src/platform/email/enqueue.ts`).
- De ese correo dependen funciones críticas: invitaciones (incluida la del dueño que crea el superadmin, `inviteMember` en `src/admin/routes.ts`), recuperación de clave (`requestPasswordReset`, `src/modules/team/recovery.ts`), verificación del alta (`src/modules/team/verification.ts`) y recordatorios por correo.
- **Falta todo lo de entrega real:** no hay ninguna mención de SPF, DKIM ni DMARC en el repo (grep en `*.md`); DEPLOY.md solo nombra `RESEND_API_KEY` en §25 (alta self-service). `.env.example:215-226` deja `EMAIL_PROVIDER`/`RESEND_API_KEY`/`EMAIL_FROM` comentadas. `productionConfigWarnings` (`src/platform/config/requiredSecrets.ts:35`) avisa por `PUBLIC_BASE_URL` pero NO por un correo sin configurar: el problema recién aparece cuando el primer dueño no recibe su invitación.
- No hay manejo de rebotes/quejas (sin webhook de Resend): un correo inválido se reintenta o se pierde sin que el negocio lo sepa.

## Objetivo
Que los correos de la plataforma salgan desde un dominio propio verificado, con SPF, DKIM y DMARC alineados, que el arranque en producción avise si el correo no está configurado, y que haya un procedimiento repetible para comprobar la entrega.

## Alcance
- Código:
  - `productionConfigWarnings`: aviso (o problema, según decisión) si `EMAIL_PROVIDER` ≠ `resend` o falta `RESEND_API_KEY`; validar `EMAIL_FROM` con `resolveEmailConfig()` al arrancar. Test unitario.
  - Script `scripts/sendTestEmail.ts` (`npm run email:test -- destino@…`) que manda un correo de prueba por `sendEmail()` y reporta el id del proveedor; NO se corre en CI.
  - Opcional, si el usuario lo aprueba: default de plataforma `EMAIL_REPLY_TO` para que las respuestas no vayan a `no-reply`. El campo por mensaje YA existe y se valida (`replyTo` en `EmailMessage`, `src/platform/email/message.ts:18`, validación en `:107`); falta solo el default por env.
- Docs: sección nueva en DEPLOY.md "Correo de la plataforma" con: dominio de envío (subdominio dedicado, p. ej. `mail.selyon.app` o `send.`), registros que pide Resend (SPF `include:` del proveedor en el subdominio de retorno, los CNAME/TXT de DKIM), DMARC empezando en `p=none; rua=mailto:…` y plan para subir a `quarantine` tras 2–4 semanas de reportes limpios, cómo verificar (`dig TXT`, panel de Resend, cabeceras `Authentication-Results` de un Gmail con `spf=pass dkim=pass dmarc=pass`).
- `.env.example`: comentarios actualizados con el dominio verificado.

## Fuera de alcance
- Comprar/configurar el dominio y HTTPS → `dominio-y-ssl`.
- Webhook de rebotes/quejas de Resend y supresión de direcciones: proponerlo como ítem nuevo si el usuario quiere.
- Correo de marketing a clientes finales (no existe: campañas van por WhatsApp).

## Pasos sugeridos
1. Leé `email.ts`, `resend.ts`, `requiredSecrets.ts` y DEPLOY.md §25.
2. Agregá el aviso de arranque + test; el script de correo de prueba.
3. Escribí la sección de DEPLOY.md con la tabla de registros DNS como plantilla (valores reales los da el panel de Resend; NO inventarlos).
4. Dejá en el reporte la checklist humana: crear dominio en Resend, cargar DNS, esperar verificación, cargar env en el droplet, correr `email:test` a una casilla Gmail y otra Outlook y revisar `Authentication-Results`.

## Decisiones que el agente NO toma solo
- Proveedor definitivo (Resend está implementado; ¿se queda?) y plan pago según volumen.
- Dominio/subdominio de envío y dirección del remitente (`no-reply@` vs. `hola@`), y casilla para `rua` de DMARC.
- Si la falta de correo en producción frena el arranque (problema) o solo avisa.
- Cualquier cambio de DNS o de env en producción lo hace o aprueba el usuario.

## Criterios de aceptación
- [ ] Con `NODE_ENV=production` y sin `EMAIL_PROVIDER=resend`/`RESEND_API_KEY`, el arranque lo reporta (test).
- [ ] `npm run email:test` existe y documentado (no corre en CI).
- [ ] DEPLOY.md tiene la sección de SPF/DKIM/DMARC con verificación paso a paso.
- [ ] (Humano) Un correo de recuperación real llega a Gmail con `spf=pass`, `dkim=pass`, `dmarc=pass`.
- [ ] `npm run typecheck`, `npm test` y `npm run ci:env` en verde.
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización").

## Reglas para este trabajo
- Rama propia `prod/spf-dkim-dmarc` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist de pasos humanos pendientes (Resend, DNS, env del droplet, prueba de entrega).
