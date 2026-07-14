# TESTING.md — Estrategia de pruebas del agente de WhatsApp

> **Objetivo:** probar la app desde todos los ángulos para asegurar funcionamiento **correcto** (no rompe),
> **fiable** (no duplica, no pierde mensajes, aislado por tenant) y **de valor** (el bot cotiza/agenda/escala bien).
>
> **Este doc es un plan, no un estado.** A medida que se implemente cada ángulo, marcar su casilla y anotar
> el comando/archivo real. Mantener vivo igual que `ROADMAP.md`.
>
> **Última actualización:** 2026-07-14 (ángulos 1 y 2 implementados)

---

## Punto de partida (qué hay hoy)

- **No hay pruebas automatizadas permanentes.** No hay runner (vitest/jest) ni carpeta de tests.
- Lo que se hizo hasta hoy: `typecheck` (`tsc --noEmit`) + **"sanity scripts"** desechables (`tsx` de un solo uso,
  descritos en cada ítem del ROADMAP pero **no versionados**) + verificación manual con Playwright.
  → Cada feature se verificó **una vez** y esa verificación se botó. **No hay red contra regresiones.**
- **Andamiaje ya disponible (barato de aprovechar):**
  - `src/booking/inMemoryRepository.ts` — repo completo sin Postgres.
  - `SEED_DEMO=1` — levanta el server con datos de demo, sin tocar producción.
  - Patrón de `fetch` mockeado para Graph API / OpenAI (ya usado en los sanity scripts).
  - `.github/workflows/ci-cd.yml` — pipeline listo para colgarle un paso `npm test`.

**Decisión de herramienta:** usar **`node:test`** (runner nativo de Node ≥18) + `node:assert`.
Cero dependencias nuevas → cumple la política supply-chain del `CLAUDE.md` sin trámite.
Para el panel se sigue con **Playwright** (ya en uso). Evals del agente: script propio con `tsx`.

---

## Los ángulos, priorizados por palanca

Orden = mayor retorno primero. Un ✅ significa "implementado y corriendo en CI (o documentado como manual)".

### 1. ✅ Suite unitaria de lógica pura (LA PRIORIDAD)

Runner `node:test` vía `tsx --test`, script `npm test` (corre en CI antes del typecheck, ver `.github/workflows/ci-cd.yml`). 56 casos en `test/unit/*.test.ts` + fabricadores en `test/helpers/fixtures.ts`:

| Módulo | Qué probar | Archivo |
|---|---|---|
| `booking/availability.ts` | espacios libres, choque con cita existente, **bloqueos/feriados**, horario por día | `test/unit/availability.test.ts` |
| `campaigns/segmentos.ts` | cada segmento: todos / inactivos ≥N días / servicio hace ≥N meses, con datasets armados a mano | `test/unit/segmentos.test.ts` |
| `billing/planes.ts` | `tenantPuede(tenant, "campanias"\|"multiUsuario"\|"whiteLabel")` para básico/pro | `test/unit/planes.test.ts` |
| `config/validadores.ts` | hex `#rrggbb`, URLs http(s)/vacío, horarios, servicios, precios | `test/unit/validadores.test.ts` |
| `panel/metricas.ts` | `noShowPct`, `ahorroBotPct`, nuevos vs. recurrentes, bot vs. manual — con conteos exactos | `test/unit/metricas.test.ts` |
| `whatsapp/client.ts` | round-trip protocolo de botones (`confirmar\|`, `mover\|`, `postbien\|`, `postmal\|`, `opcionHorario`), `verificarWebhook`, `firmaValida` | `test/unit/whatsappClient.test.ts` |
| `whatsapp/client.ts` (`parsearEntrante`) | decodifica texto / audio / imagen / interactivo (button_reply) → frase | `test/unit/whatsappClient.test.ts` |
| `queue/cola.ts` | lógica de backoff exponencial y decisión de reintento (sin el SQL) | `test/unit/cola.test.ts` |

**Nota:** `campaigns/segmentos.ts` y `queue/cola.ts` tenían la lógica pura entrelazada con I/O (DB). Se extrajeron
`calcularSegmento(citas, conversaciones, filtro, hoy)` y `calcularBackoffSeg`/`agotoIntentos` (mismo patrón que
`calcularMetricas`, ya puro) para poder probarlas sin mockear Postgres/Drizzle. Comportamiento sin cambios.

**Pendiente de este ángulo:** `handleWebhook` completo (el handler que orquesta parseo + dedup + cola) queda para
el ángulo 3 (E2E del webhook), ya que necesita repo en memoria + Graph API mockeado.

**Meta:** convertir los sanity scripts ya descritos en el ROADMAP en tests **permanentes**. Logrado para lo determinista.

### 2. ✅ Invariante multi-tenant (SEGURIDAD)

Suite en `test/tenant/aislamiento.test.ts` (corre en CI vía `npm test`; el glob ya incluye `test/tenant/*.test.ts`).
Siembra **2 tenants** con el **mismo número de cliente** (la prueba más dura de la clave `tenantId:clienteWa`) y afirma:

- **Lecturas scopeadas:** un tenant sin datos no ve NADA del otro — `citasPorFecha`, `citasEnRango`,
  `citasActivasCliente`, `listarConversaciones`, `obtenerConversacionPorId`, `obtenerModo`, `fichaCliente`,
  `listarPushSubs`, `metricas`. Y con el mismo cliente en ambos, cada uno ve **solo lo suyo** (nombre/ficha/servicio/subs).
- **Escrituras rechazadas:** test parametrizado que recorre cada mutación con el `tenantId` equivocado y espera
  rechazo + estado intacto: mutaciones de cita (`reprogramar`/`cancelar`/`confirmar`/`completar`/`marcarNoShow`
  → `null`) y de conversación (`setModo`/`marcarEstado`/`guardarNotas`/`marcarLeidas` → no-op). Cada test tiene
  su **control positivo**: el dueño legítimo SÍ puede, para no pasar por un bug genérico.
- **Recordatorios** (sin `tenantId`, keyed por `citaId` único): el claim de una cita no bloquea la del otro tenant.

**Fuera de alcance de este repo:** `usuarios` / `config` / `campañas` viven en auth y stores propios (no en
`RepositorioEnMemoria`); su aislamiento se cubre en el panel E2E (ángulo 6, guards de rol 403).
- **Una fuga acá es un incidente, no un bug cosmético.** Bloque propio, sin excepciones.

### 3. ⬜ End-to-end del webhook (in-process, sin red)

Repo en memoria + Graph API mockeado. Simular entrantes y afirmar la salida de `responderEntrante`:

- [ ] Cotiza con precio del prompt (no alucinado) ante texto y ante **foto** (visión).
- [ ] Agenda: ofrece horarios (lista), confirma con tap, sincroniza (mock) Calendar.
- [ ] Reprograma / cancela por el bot (C1.1) y **reinicia recordatorios**.
- [ ] **Escala a humano** cuando corresponde; respeta la ventana de modo humano.
- [ ] **`BAJA`** marca opt-out y NO pasa al agente; "bajar" en una frase NO es falso positivo.
- [ ] Confirmación de cita por botón (C1.3) es **acción directa** (no pasa por el agente).
- [ ] Post-servicio (C3.1): "Todo bien" manda link reseñas; "Tuve un problema" escala + notifica.
- [ ] **Dedup por `wamid`**: reenviar el mismo mensaje no re-procesa.

### 4. ⬜ Evals del agente (LLM — no determinista, corre aparte)

- Set de transcripciones fijas (JSON) → correr `correrAgente` contra OpenAI (real o grabado).
- Aserciones **laxas**: ¿tool correcta? ¿precio del prompt? ¿escaló ante lo desconocido? ¿no inventó horarios?
- **No en cada push** (cuesta tokens): job nocturno o manual (`npm run eval`).
- Es el ángulo de **calidad/valor** que ningún unit test cubre.

### 5. ⬜ Fiabilidad y concurrencia (validar lo que B1/B4 prometen)

- [ ] Cola durable: un entrante sobrevive a "restart" (dejar job pendiente, re-arrancar worker, se procesa).
- [ ] **2 instancias no duplican recordatorios** (claim atómico B4) — simular carrera.
- [ ] **2 instancias no duplican envíos de campaña** (mini-cola `wa_campania_envios`).
- [ ] Throttling de campañas respeta `CAMPANIA_ENVIO_INTERVALO_MS`.
- [ ] Reaper recupera jobs colgados.

### 6. ⬜ Panel E2E (Playwright — formalizar lo que hoy es manual)

- [ ] Login → responder → toggle bot/humano → marcar atendido/reabrir.
- [ ] Agenda: crear manual / confirmar / reprogramar / completar / cancelar / no-show.
- [ ] **Guards de rol:** operador recibe **403** en `/usuarios` y `POST /config` (no basta esconder la pestaña).
- [ ] Admin/onboarding: CSRF, 409 por duplicado, no-sombra de sesión operador.
- [ ] White-label: colores/logo se aplican; se limpian al logout.
- [ ] Responsivo 390/1440px × claro/oscuro; sin errores de consola.
- [ ] PWA: `sw.js` con `Service-Worker-Allowed`, manifest, íconos.

### 7. ⬜ Guardrail de migraciones en CI (tu trampa conocida)

- Cambiar `src/db/schema.ts` **sin** migración drizzle rompe TODO el deploy en silencio
  (`seedTenants` aborta antes del `pm2 restart`).
- [ ] Paso en CI: levantar Postgres efímera (service container), correr `db:migrate`, y validar
  con `drizzle-kit check` que el schema aplicado == `schema.ts`. Falla el build si hay drift.

### 8. ⬜ Seguridad

- [ ] `/security-review` sobre el diff antes de cada merge grande.
- [ ] Auth: anti-timing en login, sesión firmada, token de WhatsApp **nunca** vuelve al navegador (C4.2).
- [ ] CSRF en rutas admin; validación server-side (no confiar en el front).
- [ ] Verificación de firma del webhook de Meta (`WHATSAPP_APP_SECRET`).

### 9. ⬜ Smoke test post-deploy

- [ ] Ampliar el smoke del pipeline (`/salud`) a: `/me` responde, un login real de demo funciona,
      el bundle React sirve (no cae al 503 por falta de build).

### 10. ⬜ QA manual en dispositivo (lo único que no se automatiza barato)

- [ ] Entrega de push **iOS/Android** real (pendiente en ROADMAP A5/A8).
- [ ] Plantillas Meta aprobadas fuera de ventana 24h (Utility quick-reply, MARKETING opt-out).
- [ ] Embedded Signup contra el popup real de Meta (C4.2, tras Business Verification).

---

## Estructura propuesta de archivos

```
test/
  unit/            # node:test — availability, planes, segmentos, validadores, metricas, botones
  tenant/          # aislamiento multi-tenant
  e2e-webhook/     # responderEntrante con repo en memoria + fetch mockeado
  reliability/     # cola, recordatorios, campañas (concurrencia)
  helpers/         # fabricadores de tenant/cita/conversación, mock de Graph/OpenAI
eval/
  transcripciones/ # casos fijos del agente
  correrEval.ts
web/
  e2e/             # Playwright (formaliza shotPanel.mjs y las verificaciones manuales)
```

`package.json`:
```jsonc
"scripts": {
  "test": "tsx --test test/**/*.test.ts",   // rápido, determinista, en cada push
  "test:e2e": "playwright test",             // panel
  "eval": "tsx eval/correrEval.ts"           // LLM, manual/nocturno
}
```

CI (`.github/workflows/ci-cd.yml`): agregar `npm test` **antes** del build; `test:e2e` y el guardrail
de migraciones como jobs separados. `eval` NO en el push (tokens).

---

## Principios

1. **Determinista en cada push, no determinista aparte.** Nada que cueste tokens o toque red real corre en el hot path de CI.
2. **Sin tocar producción.** Todo lo automatizado usa repo en memoria o Postgres efímera; jamás el `.env` real ni el droplet.
3. **El sanity script de hoy es el test de mañana.** No botar verificaciones: al terminar una feature, dejar su prueba en `test/`.
4. **Aislamiento por tenant = seguridad, no calidad.** Se prueba siempre, no es opcional.
5. **Cubrir el modo de fallo caro.** Migración silenciosa y fuga entre tenants antes que cobertura cosmética.
