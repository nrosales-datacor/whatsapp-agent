# Privacidad, términos y contrato: completar, cubrir el CRM y registrar la aceptación

> **Punto del checklist:** add a privacy policy and terms · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P0 antes del primer cliente que pague (registro de aceptación: Gate self-service)
> **Tipo:** mixto · **Depende de:** nada (la revisión del abogado es externa) · **Esfuerzo:** 1 día de código + revisión legal
> **Archivos principales:** `landing/privacidad.html`, `landing/terminos.html`, `landing/contrato.html`, `src/signup.ts`, `web/src/modules/auth/SignupPage.tsx`, `src/modules/whatsapp/texts.ts`, `src/platform/audit/auditLog.ts`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
Existe y se sirve:
- Tres documentos en `landing/` servidos por `serveLanding` (`src/platform/http/landing.ts`, mapa `PAGES`): `/privacidad`, `/terminos`, `/contrato` (contrato B2B + acuerdo de tratamiento de datos). Modelan bien los roles (el negocio es responsable, Selyon encargado) y la Ley 8968.
- El alta self-service exige el check: `SignupBody.acceptTerms: z.literal(true, …)` en `src/signup.ts:83`; `SignupPage` enlaza `/terminos` y `/privacidad` (`web/src/modules/auth/SignupPage.tsx:188-193`).

Lo que falta:
- **Son borradores con marcadores**: banner "Borrador — pendiente de revisión legal" (`privacidad.html:42`, `terminos.html:39`, `contrato.html:43`, que además dice "no es una oferta vinculante"). Corchetes (`grep -o "\[[^]]*\]"`, incluido el `[corchetes]` del banner): 13 en privacidad, 8 en términos, 46 en contrato — `[RAZÓN SOCIAL]`, `[CÉDULA JURÍDICA]`, `[DOMICILIO]` (`privacidad.html:52-53`), `[CORREO DE PRIVACIDAD]` (`:184,208`), regiones de Supabase/DigitalOcean (`:149-150`), precios `[PRECIO PLAN BÁSICO]`/`[PRECIO PLAN PRO]` (`contrato.html:68-69`), IVA, jurisdicción, PRODHAB (`contrato.html:180`), plazos ARCO.
- **Describen el producto viejo**: `terminos.html:44-46` define Selyon como "atender su WhatsApp con un asistente de IA (“Recepcionista IA”)". No cubren lo que hoy hace "Selyon CRM": clientes/CRM, ventas y pagos, comisiones y datos del personal, varias sucursales, prueba gratis y cobro con Stripe, alta self-service, correo transaccional. Stripe aparece 1 vez en privacidad/contrato y 0 en términos; el proveedor de correo (`EMAIL_PROVIDER=resend`, `.env.example:220`) no aparece como subencargado. No hay sección de cookies (el panel usa cookies de sesión estrictamente necesarias, `src/modules/team/session.ts:121` y `src/admin/session.ts:97`; la landing ninguna).
- **SDK de Meta sin declarar**: al conectar el número (`/panel/whatsapp/settings` y `/panel/admin`, `isMetaSdkPath` en `src/platform/net/securityHeaders.ts`) el panel carga `connect.facebook.net` bajo demanda (`loadSdk`, `web/src/modules/whatsapp/embeddedSignup.ts:34-55`) con `FB.init({ autoLogAppEvents: true, … })` (`:42`): manda eventos de uso a Meta que el Embedded Signup no necesita. Ni privacidad ni términos lo mencionan.
- **La aceptación no queda registrada**: `signUp` (`src/signup.ts:136`) guarda `business_signed_up` con `{ industry, plan, trialDays }`, sin versión de términos/privacidad ni fecha de aceptación. Si el texto cambia, no se puede probar qué aceptó cada negocio. Los usuarios invitados (`src/modules/team/`) no aceptan nada.
- **El cliente final no recibe el aviso**: el `botNotice` (`src/modules/whatsapp/texts.ts:24-28`) solo dice "Soy el asistente automatizado de {negocio}…"; no menciona IA de terceros en EE. UU. ni enlaza `/privacidad`, aunque `terminos.html` A.2 promete que "se identifica como automatizado" y remite a la política.

## Objetivo
Documentos legales vigentes, sin marcadores, que describan el producto real; aceptación versionada y auditable en el alta; y aviso de privacidad al cliente final de WhatsApp.

## Alcance
- Constante única de versión legal (p. ej. `LEGAL_VERSION = "2026-11-xx"` en `src/platform/`) mostrada en cada documento ("Versión del …").
- Registrar en el alta `termsVersion`, `privacyVersion` y `acceptedAt` (en el payload del audit `business_signed_up` como mínimo; columna en `businesses` o tabla `legal_acceptances` si el usuario lo prefiere, con migración probada en PGlite).
- Reaceptación: si la versión vigente es mayor que la aceptada por el dueño, el panel muestra un aviso para aceptar de nuevo (endpoint bajo `/api/panel/*`, auditado).
- Actualizar los textos: secciones del CRM (clientes, ventas, personal, sucursales), Stripe y proveedor de correo como subencargados, cookies estrictamente necesarias, prueba gratis y cobro. **Solo con datos que dé el usuario; nunca inventar razón social, cédula, precios ni plazos.**
- `autoLogAppEvents: false` en `loadSdk` (`embeddedSignup.ts:42`) y una línea en privacidad sobre el SDK de Meta (solo al conectar WhatsApp, cookies de Meta en su propio dominio).
- `botNotice` (los 3 registros vos/tú/usted): una línea con "IA (proveedores en EE. UU.)" y `<base>/privacidad`, usando `publicBaseUrl()`.
- Quitar el banner de borrador solo cuando el usuario confirme la revisión del abogado.

## Fuera de alcance
- Banner de cookies: no aplica mientras no haya cookies no esenciales (no hay prompt para eso).
- Supresión y exportación de datos de un negocio o cliente → `borrar-cuenta-y-datos`.
- Verificación del correo del alta: ya funciona en `5f976e1` (no hay prompt).
- Medición de la landing y su línea en la política de privacidad → `analytics` (corre después).

## Pasos sugeridos
1. Listá todos los marcadores (`grep -n "\[" landing/*.html`) y pasáselos al usuario en una sola tabla para que los complete.
2. Implementá la versión legal, el registro de aceptación y su test (alta en PGlite → audit/columna con versión y fecha).
3. Reaceptación en el panel + test del endpoint (permiso de dueño, auditoría).
4. Ajustá `botNotice` y sus tests de textos; verificá que el largo siga dentro del límite de WhatsApp.
5. Reescribí las secciones del producto con el texto aprobado; agregá un test que falle si queda un `[` de marcador en `landing/privacidad.html` y `landing/terminos.html` (el contrato puede conservar los campos del cliente).

## Decisiones que el agente NO toma solo
- Razón social, cédula jurídica, domicilio, correos de privacidad y soporte, regiones de Supabase/DigitalOcean, precios con o sin IVA, jurisdicción, plazos (ARCO, aviso de incidentes, retención de backups).
- ¿Revisión por abogado antes del primer cliente que pague? ¿Inscripción ante la PRODHAB y quién la hace?
- ¿El número `wa.me/50683658231` es el canal oficial de Selyon o el del piloto? (`privacidad.html:209`).
- ¿Guardar la aceptación en una tabla propia o en el audit? ¿Los usuarios invitados también aceptan?

## Criterios de aceptación
- [ ] Un alta en PGlite deja versión de términos, versión de privacidad y fecha de aceptación consultables (test nuevo).
- [ ] Subir `LEGAL_VERSION` hace que el panel pida reaceptar al dueño, y la reaceptación queda auditada (test nuevo).
- [ ] `botNotice` enlaza `/privacidad` en los 3 registros (test de textos).
- [ ] Privacidad y términos sin marcadores `[…]` (test nuevo) y mencionan CRM, Stripe, correo y cookies de sesión.
- [ ] `npm run typecheck` y `npm test` en verde (y en `web/`).
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización").

## Reglas para este trabajo
- Rama propia `prod/privacidad-y-terminos` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist de pasos humanos pendientes (completar marcadores, revisión del abogado, firmar el contrato con cada negocio antes de conectar su número, PRODHAB).
