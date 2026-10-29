# legacy/ — el dominio viejo (agente del lavacar), solo como referencia

Esta carpeta es una **foto del código anterior a la reestructura** (Carril I, `PLAN-GESTION.md`): el agente de
WhatsApp, el webhook, el panel viejo (router y rutas), booking, campañas, rescate, recordatorios, la config de
tenants, el esquema `wa_*` con sus 40 migraciones, los evals y sus tests.

- **No compila ni corre.** Está fuera del build: `tsconfig.json` la excluye, `npm test` no la recorre y el
  guardrail de `.env.example` tampoco. Nada de `src/` ni de `test/` puede importar de acá.
- **Es solo referencia para portar** lo que sirva en I1–I2 (agente y tools, ingesta del webhook, ráfagas, bandeja,
  recordatorios, rescate, campañas…) sobre el esquema nuevo y los servicios del núcleo.
- Para que se pueda leer de corrido, además del dominio quedó una **copia sin traducir de los archivos de
  plataforma** que ese código importa (`src/red`, `src/db`, `src/observabilidad`, `src/panel/{auth,http,…}`,
  `src/config/{secretos,moneda,auditoria}`, `src/storage`) y de los tests mixtos (plataforma + dominio). La versión
  viva de esa plataforma, traducida al inglés, está en `src/platform/`.
- La historia de cada archivo se conserva en git (`git log --follow legacy/src/...`).

**Se borra entera al cerrar I2.**
