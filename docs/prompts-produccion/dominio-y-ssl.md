# Dominio y HTTPS del stack nuevo

> **Punto del checklist:** set up your custom domain and SSL · **Estado en `5f976e1`:** 🟡 parcial · **Prioridad:** P0 antes del primer cliente que pague
> **Tipo:** mixto · **Depende de:** staging, smoke-tests · **Esfuerzo:** 3-5 h
> **Archivos principales:** `DEPLOY.md` (§7, §8, §23), `.env.example`, `src/platform/net/securityHeaders.ts`, `src/platform/net/clientIp.ts`, `src/platform/http/http.ts`, `.github/workflows/ci-cd.yml`

## Contexto (verificado en `5f976e1`; re-verificalo en la base actual, ver abajo)
> **Base móvil:** la serie corre sobre la cabeza del último PR abierto (la anota el orquestador en "Decisiones del usuario" / `PROGRESO.md`), no sobre `5f976e1`. Antes de cambiar nada, confirmá cada hallazgo de abajo contra el código actual, ubicándolo por nombre de función. Si en la base actual ya está resuelto, no lo rehagas: reportalo como "ya resuelto en la base" con la evidencia.
- Lado código, listo: `applySecurityHeaders` (`src/platform/net/securityHeaders.ts`) manda CSP, nosniff, `frame-ancestors` y HSTS cuando la request llegó por https (`cameOverHttps`, forzable con `SECURITY_HSTS`); la cookie de sesión sale `HttpOnly; SameSite` y agrega `Secure` cuando `NODE_ENV=production` (no según el request: `src/platform/http/http.ts:34`, helper que arma `Set-Cookie`). Consecuencia: staging con `NODE_ENV=production` sin HTTPS no puede iniciar sesión, así que el TLS de staging es requisito, no un extra; IP real detrás de proxy con `TRUST_PROXY` (`src/platform/net/clientIp.ts`). Links de correos y Stripe usan `PUBLIC_BASE_URL` (aviso en `productionConfigWarnings` si falta).
- Lado infraestructura, solo existe el del sistema viejo: `wabotlavacar.selyon.app` (registro A en Cloudflare, DNS-only, nginx/Caddy del droplet compartido, DEPLOY.md §7-§8 y "Datos reales de este deploy").
- Para el stack nuevo no hay: subdominio elegido (`.env.example` sugiere `PUBLIC_BASE_URL=https://app.selyon.app`; `PLAN-GESTION.md` §8 dice "arranca en un subdominio de `selyon.app`"), bloque de proxy (Caddy/nginx), certificado, ni `BASE_URL` del pipeline (sigue en `wabotlavacar`, `ci-cd.yml:104`).
- Superficies que dependen del dominio y hay que repuntar: webhook de Meta (`/webhook/whatsapp`), webhook de Stripe (`/webhook/stripe`, DEPLOY.md §25), links de invitación/recuperación/confirmación en correos, `VAPID_SUBJECT`, landing en `/`, panel en `/panel` (PWA: el service worker queda atado al origen).
- No hay verificación automática de que HTTPS + HSTS + redirección http→https funcionen en el dominio desplegado.

## Objetivo
El stack nuevo servido en su propio (sub)dominio con TLS válido y renovación automática, redirección a https, HSTS, y todas las URLs públicas (Meta, Stripe, correos, PWA) apuntando ahí.

## Alcance
- `DEPLOY.md`: reescribir §7-§8 para el stack nuevo (registro DNS, bloque Caddy o nginx con `X-Forwarded-For/Proto`, `TRUST_PROXY=loopback`), y §23 con el chequeo `curl -sI` del dominio nuevo.
- Plantillas versionadas de proxy en `deploy/` (p. ej. `deploy/Caddyfile.example` o `deploy/nginx-selyon-crm.conf.example`) sin secretos.
- Sumar al script `scripts/ci/smoke.sh` (lo crea `smoke-tests`; lo usan `deploy` y `rollback`) chequeos que verifiquen: `http://` redirige a `https://`, HSTS presente en `/panel`, certificado vence en más de 14 días (`openssl s_client` o `curl -w %{ssl_verify_result}`).
- Lista de URLs a actualizar en Meta y Stripe el día del corte (coordinada con `rollback`).

## Fuera de alcance
- SPF/DKIM/DMARC del dominio de correo → `spf-dkim-dmarc`. Pipeline por entorno y `BASE_URL` por environment de GitHub → `ci-cd` (corre después de este prompt). SEO de la landing → `seo-aeo`.

## Pasos sugeridos
1. Leer DEPLOY.md §7, §8, §23 y `securityHeaders.ts`.
2. Escribir la plantilla de proxy (Caddy es lo más simple si el 443 está libre en el destino; si es el droplet compartido, nginx con server block nuevo).
3. Agregar el chequeo TLS/HSTS/redirección a `scripts/ci/smoke.sh` (de `smoke-tests`), sin duplicar el script.
4. Actualizar `.env.example` (`PUBLIC_BASE_URL`, `TRUST_PROXY`, `SECURITY_HSTS`) y correr `npm run ci:env`.

## Decisiones que el agente NO toma solo
- ¿Subdominio definitivo (`app.selyon.app`, otro) o comprar dominio propio ya?
- ¿Cloudflare en modo proxy (naranja) o DNS-only como hoy? Cambia `TRUST_PROXY` y quién emite el certificado.
- ¿Caddy o nginx en el destino?

## Criterios de aceptación
- [ ] Plantilla de proxy versionada y documentada en DEPLOY.md, sin referencias a `wabotlavacar` para el stack nuevo.
- [ ] El smoke del deploy falla si no hay HSTS, si http no redirige o si el certificado vence en <14 días.
- [ ] Checklist de URLs a repuntar (Meta, Stripe, `PUBLIC_BASE_URL`, `VAPID_SUBJECT`) en DEPLOY.md.
- [ ] `npm run typecheck` y `npm test` en verde (y en web/ si toca el panel)
- [ ] ROADMAP.md actualizado en el MISMO commit (ítem en "Carril P — Preparación para producción" —creá la sección si todavía no existe—, fecha de "Última actualización")

## Reglas para este trabajo
- Rama propia `prod/dominio-y-ssl` creada desde `prod/readiness`, que el orquestador sincroniza con la cabeza del **último PR abierto** antes de lanzarte (ver "Base: siempre el último PR abierto" en `00-INDICE.md`). Commit al terminar, en español, estilo del repo. Sin push ni PR salvo pedido. El orquestador la mergea a `prod/readiness` si el usuario aprueba.
- Nunca uses un `.env` con `DATABASE_URL` remota: desarrollo y tests van sobre PGlite. Nunca toques producción ni servicios externos (Supabase, Meta, OpenAI, Stripe, correo, droplet) sin confirmación del usuario.
- Política de dependencias de CLAUDE.md antes de cualquier `npm install` (popular, publisher conocido, versión con +1 mes, versión exacta).
- Sin secretos en código, docs ni respuestas.
- Respetá las fronteras entre módulos (hay un test de arquitectura) y la costura `/api/panel/*`.

## Al terminar, reportá
Archivos cambiados, cómo se verificó, y checklist de pasos humanos pendientes (registro DNS, instalar/configurar el proxy, emitir certificado, repuntar Meta y Stripe).
