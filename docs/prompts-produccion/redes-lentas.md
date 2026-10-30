# Panel usable con red lenta o intermitente

> **Punto del checklist:** test it on slow networks · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P1 antes de 5 clientes
> **Tipo:** código · **Depende de:** estados-de-error-y-carga (reusa sus pantallas de error) · **Esfuerzo:** 1-2 días
> **Archivos principales:** `web/src/lib/api.ts`, `web/src/main.tsx`, `web/src/sw.ts`, `web/vite.config.ts`, `web/src/modules/whatsapp/ChatPane.tsx`, `test/e2e/`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
Los clientes objetivo (negocios con cita en Costa Rica/LatAm) usan el panel desde el teléfono, con datos
móviles. Hoy:

**Lo que hay:**
- Errores de red con mensaje claro: `web/src/lib/api.ts`, `apiRequest` y la descarga de CSV atrapan el fallo de
  `fetch` y lanzan `ApiError(0, NETWORK_MESSAGE, "network_error")` ("No pudimos conectar con el servidor…").
- Las pantallas muestran `ErrorState` con "Reintentar" y los botones se deshabilitan mientras la mutación corre
  (evita doble envío).
- Assets del panel con `cache-control: immutable` (`src/platform/http/staticPanel.ts`).

**Lo que falta:**
1. **Sin timeout**: `httpTransport` (`web/src/lib/api.ts:164`) hace `fetch(...)` sin `AbortSignal`; igual
   `apiDownload` (`api.ts:269`). Con señal mala, una carga o
   un "Guardar" quedan girando indefinidamente; el usuario no sabe si se guardó.
2. **Cero reintentos**: `main.tsx:26` configura `QueryClient` con `retry: false` para todo ("un 401/403/404 no se
   arregla reintentando"), lo que también apaga el reintento ante `network_error` y 502/503 transitorios.
3. **Sin aviso de desconexión**: no hay `navigator.onLine` ni eventos `online`/`offline`; no se refrescan las
   consultas al volver la red (`refetchOnReconnect` queda por defecto, pero sin reintento la consulta fallida
   no se recupera sola).
4. **Service worker passthrough**: `web/src/sw.ts` no precachea nada (comentario "Sin precache (passthrough de
   red…)"; `vite.config.ts` usa `injectManifest` con `injectionPoint: undefined`). Sin red, el panel instalado
   como PWA no abre ni el shell.
5. **Mutaciones no idempotentes ante timeout**: si se agrega un timeout, un "Cobrar" o "Crear cita" que llegó al
   server pero cuya respuesta se perdió puede duplicarse al reintentar a mano.
6. **Bundle único**: el único `lazy()` es la ayuda del modo mock (`web/src/modules/auth/AuthLayout.tsx:7`);
   las páginas van todas en un chunk. No se midió su peso ni el tiempo de carga en 3G.
7. **Nunca se probó**: ningún E2E usa `page.route` con demora, `context.setOffline` ni throttling CDP.

## Objetivo
Que con 3G lento o cortes cortos el panel avise qué pasa, reintente lo seguro, no duplique operaciones de
dinero/citas y abra el shell aunque no haya red; con tests que lo prueben.

## Alcance
- `api.ts`: timeout configurable por request (p. ej. 15 s lectura, 30 s escritura) con `AbortController`,
  código nuevo `timeout` en `ERROR_MESSAGES` ("La conexión está lenta…"), sin romper la costura `/api/panel/*`.
- `main.tsx`: `retry` como función: reintenta hasta 2 veces con backoff solo `network_error`, `timeout`,
  `server_error` (5xx) en **queries**; nunca mutaciones, nunca 4xx.
- Banner global "Sin conexión" (en `AppLayout`) con `online`/`offline`, y refetch al reconectar.
- Mutaciones de riesgo (cobro, crear cita, enviar mensaje de WhatsApp): clave de idempotencia por intento
  (header `Idempotency-Key` generado en el cliente) si el backend ya la soporta; si no, documentar el riesgo y
  proponer el cambio de backend como decisión.
- Service worker: precache del shell (index + assets con hash) para abrir sin red y mostrar el banner; los
  datos siguen siempre de red (no cachear respuestas de la API: son datos personales).
- Medir el bundle (`vite build` reporta tamaños) y, si pasa de ~300 kB gzip, `lazy()` por módulo (Reportes,
  Campañas, Admin).
- Tests E2E (`panel-mock` y/o `server`): demora de 20 s con `page.route` → aparece el mensaje de timeout;
  `context.setOffline(true)` → banner, y al volver se recupera sin recargar; un 503 transitorio en una query se
  reintenta y la pantalla carga; un "Guardar" con la red cortada no queda girando.

## Fuera de alcance
- Pantallas de error base y error boundary → `estados-de-error-y-carga`.
- Caché HTTP del server y CDN → `cache`. Imágenes → `optimizar-imagenes`.
- Métricas de rendimiento reales en producción → `monitoreo-de-performance`.

## Pasos sugeridos
1. Leer `api.ts` (`httpTransport`, `apiRequest`, descarga CSV), `main.tsx`, `sw.ts`, `vite.config.ts`.
2. Revisar si el router o los servicios de cobro/citas aceptan una clave de idempotencia. En `5f976e1` la
   idempotencia está solo en procesos de fondo y entradas externas: cola (`dedupe_key`,
   `src/platform/queue/schema.ts:54`), correo (`src/platform/email/job.ts:43`), webhook de Stripe
   (`src/modules/billing/stripeWebhook.ts`, `subscriptions.ts`), ingesta de WhatsApp por `wa_message_id` y
   recordatorios. **Ninguna ruta de `/api/panel/*`** (cobros, citas, envío de mensajes) lee una clave de
   idempotencia: no inventarla en el front sin backend.
3. Implementar timeout + retry selectivo + banner; luego el precache del SW.
4. `npm run build --prefix web` y anotar el peso del bundle antes/después.
5. Escribir los E2E de red; prueba manual con DevTools "Slow 3G" y anotar tiempos en `TESTING.md`.

## Decisiones que el agente NO toma solo
- Valores de timeout y cantidad de reintentos (afectan la percepción del usuario).
- ¿Se agrega idempotencia en el backend para cobros y citas? Es un cambio de API que toca módulos de dinero.
- ¿El panel debe abrir sin conexión (PWA con shell precacheado) o basta con avisar?

## Criterios de aceptación
- [ ] Una request colgada termina con mensaje de timeout en ≤ el tiempo configurado (E2E nuevo).
- [ ] Offline → banner visible; al volver la red las consultas se recargan solas (E2E nuevo).
- [ ] Un 503 transitorio en una query se reintenta y la pantalla carga; una mutación con 503 **no** se reintenta.
- [ ] Peso del bundle documentado en `TESTING.md` y carga en "Slow 3G" medida.
- [ ] `npm run typecheck`, `npm run typecheck --prefix web`, `npm test` y `npm run test:e2e` en verde.
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización").

## Reglas para este trabajo
- Rama propia `prod/redes-lentas` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, peso del bundle antes/después, tiempos medidos en Slow 3G, y pasos humanos pendientes
(probar en un teléfono real con datos móviles, decisión sobre idempotencia).
