# Prompts de preparación para producción — índice y orden

Checklist de "production readiness" (40 puntos). La auditoría original se hizo sobre **`5f976e1`** (tope del stack
"Selyon CRM" en ese momento, #2 → #13). Un archivo por punto pendiente: **37 prompts**. Cada archivo es el
**único contexto** de un agente nuevo (más el `CLAUDE.md` del repo) y se ejecutan **de a uno, en el orden de abajo**.

Cómo se evaluó: un agente por área revisó el código, otro intentó refutar sus conclusiones (cambió varios estados y
corrigió referencias) y un revisor final cruzó todas las áreas para sacar solapes y ordenar las dependencias.

**Cómo arrancar:** en Claude Code, desde la raíz del repo, corré `/prod-readiness`
(`.claude/commands/prod-readiness.md`). Ese comando es el agente principal: lee este índice y orquesta la serie.

## Base: siempre el último PR abierto

La serie **no** está fijada a un commit. Antes de lanzar **cada** prompt, el orquestador:

1. Busca el **último PR abierto** del repo: el más reciente por fecha de creación que no sea borrador ni tenga la
   cabeza en `prod/*` (esos son de esta serie). Con `gh`:
   `gh pr list --state open --json number,title,headRefName,headRefOid,isDraft,createdAt --limit 50`
   (si no hay `gh`, la herramienta de GitHub que tenga la sesión; si no hay ninguna, pregunta al usuario).
2. `git fetch origin <headRefName>`.
3. Sincroniza **`prod/readiness`** con esa cabeza:
   - Si no existe: `git checkout -b prod/readiness origin/<headRefName>` y, si esa cabeza todavía no trae
     `docs/prompts-produccion/` ni `.claude/commands/prod-readiness.md`, los copia desde la rama donde estén y commitea.
   - Si existe y la cabeza no es ancestro (`git merge-base --is-ancestor origin/<headRefName> prod/readiness` falla):
     `git merge --no-ff origin/<headRefName>` en `prod/readiness`. **Nunca rebase ni force-push.** Si hay conflictos,
     para y consulta. Después del merge corre `npm run typecheck` y `npm test` (y en `web/` si cambió el panel).
   - Si el último PR abierto cambió a otro (por ejemplo, se abrió uno nuevo encima del stack), se mergea el nuevo
     igual; si el nuevo **no** contiene al anterior (rama paralela, no apilada), para y pregunta cuál usar.
4. Anota la base usada (PR #, rama, sha corto) en `PROGRESO.md` y en la sección "Decisiones del usuario" del
   subagente, para que sepa contra qué código re-verificar.

Las referencias `archivo:línea` y los estados "verificado en `5f976e1`" de cada prompt son de la auditoría original y
se corren a medida que avanza el stack: cada prompt trae una nota "Base móvil" que obliga al agente a re-verificar
contra la base actual (por nombre de función) y a no rehacer lo que ya esté resuelto.

## Antes de empezar

- Cada agente crea `prod/<slug>` desde `prod/readiness` y el orquestador la mergea de vuelta **solo si aprobás**.
- `auditoria-de-dependencias`: el arreglo de `zod` recién cumple la política de +1 mes el **2026-11-11**. Ese paso hay
  que repetirlo después de esa fecha.
- `auth-en-endpoints` vuelve obligatorio el TOTP del superadmin en producción: el servidor nuevo necesita
  `PANEL_SUPERADMIN_TOTP_SECRET` antes del primer deploy.

## Prompt del orquestador

Es el contenido de `.claude/commands/prod-readiness.md`. Si tu herramienta no soporta comandos, abrí un chat en la
raíz del repo (idealmente un worktree propio para `prod/readiness`) y pegá el cuerpo de ese archivo.

## Orden de ejecución

| # | Prompt | Prioridad | Tipo | Depende de |
|---|---|---|---|---|
| 1 | [Secretos fuera del repo](secretos-fuera-del-repo.md) | P0 | código | — |
| 2 | [Auditoría de dependencias](auditoria-de-dependencias.md) | P0 | mixto | — |
| 3 | [Auth en cada endpoint + 2FA del superadmin](auth-en-endpoints.md) | P0 | código | — |
| 4 | [Smoke tests reales](smoke-tests.md) | P0 | mixto | — |
| 5 | [Rotar llaves filtradas](rotar-llaves.md) | P0 | operativo | secretos-fuera-del-repo |
| 6 | [Staging](staging.md) | P0 | mixto | rotar-llaves |
| 7 | [Dominio y SSL](dominio-y-ssl.md) | P0 | mixto | staging, smoke-tests |
| 8 | [CI/CD del stack nuevo](ci-cd.md) | P0 | mixto | staging, dominio-y-ssl, smoke-tests |
| 9 | [Backups](backups.md) | P0 | mixto | staging |
| 10 | [Restore probado](restore-probado.md) | P0 | mixto | backups, staging |
| 11 | [Rollback y plan de corte](rollback.md) | P0 | mixto | ci-cd, backups, restore-probado, smoke-tests |
| 12 | [Correo: SPF, DKIM y DMARC](spf-dkim-dmarc.md) | P0 | mixto | dominio-y-ssl |
| 13 | [Error tracking](error-tracking.md) | P0 | mixto | secretos-fuera-del-repo |
| 14 | [Alertas](alertas.md) | P0 | mixto | — |
| 15 | [Uptime](uptime.md) | P0 | mixto | dominio-y-ssl, alertas |
| 16 | [Evals del agente](evals.md) | P0 | mixto | — |
| 17 | [Límites de tokens y contexto](limites-de-tokens.md) | P0 | código | — |
| 18 | [Prompt injection](prompt-injection.md) | P0 | código | evals |
| 19 | [Topes de gasto y alertas de facturación](topes-de-gasto.md) | P0 | mixto | alertas, limites-de-tokens |
| 20 | [Privacidad, términos y contrato](privacidad-y-terminos.md) | P0 | mixto | — |
| 21 | [Fallback del modelo](fallback-del-modelo.md) | P1 | código | alertas, limites-de-tokens |
| 22 | [Tests de regresión del agente](tests-de-regresion.md) | P1 | mixto | evals, prompt-injection |
| 23 | [Logging](logging.md) | P1 | mixto | error-tracking |
| 24 | [Monitoreo de performance](monitoreo-de-performance.md) | P1 | código | logging |
| 25 | [Rate limiting general](rate-limiting.md) | P1 | mixto | dominio-y-ssl |
| 26 | [Pantallas de 404, 500 y caída](estados-de-error-y-carga.md) | P1 | código | error-tracking |
| 27 | [Redes lentas](redes-lentas.md) | P1 | código | estados-de-error-y-carga |
| 28 | [Múltiples dispositivos](multiples-dispositivos.md) | P1 | mixto | — |
| 29 | [SEO y AEO](seo-aeo.md) | P1 | mixto | dominio-y-ssl |
| 30 | [OG y favicon](og-y-favicon.md) | P1 | código | seo-aeo |
| 31 | [Caché y compresión](cache.md) | P1 | mixto | dominio-y-ssl, seo-aeo |
| 32 | [Analytics sin cookies](analytics.md) | P1 | código | rate-limiting, privacidad-y-terminos |
| 33 | [Borrar cuenta y datos](borrar-cuenta-y-datos.md) | P1 | mixto | privacidad-y-terminos, backups |
| 34 | [Optimizar imágenes y fuentes](optimizar-imagenes.md) | P2 (parte P1) | código | og-y-favicon |
| 35 | [Tests unitarios del panel](tests-unitarios.md) | P2 | código | — |
| 36 | [Accesibilidad](accesibilidad.md) | P2 | mixto | — |
| 37 | [README](readme.md) | P1 (va al final) | docs | todo lo anterior |

P0 = antes del primer cliente que pague · P1 = antes de 5 clientes · P2 = puede esperar.
`optimizar-imagenes` es P2, pero arregla fuentes rotas y capturas con datos reales del piloto: no lo dejes para el final.

## Puntos sin prompt

| Punto | Estado en `5f976e1` | Evidencia |
|---|---|---|
| Reset de contraseña | ✅ completo | `requestPasswordReset`/`resetPassword` (`src/modules/team/recovery.ts`): no revela si la cuenta existe, token de un solo uso guardado hasheado, sube el epoch de sesión |
| Verificación de email | ✅ completo | `verifyEmail`/`resendEmailVerification` (`src/modules/team/verification.ts`); el login responde 403 `email_not_verified` |
| Consentimiento de cookies | ➖ no aplica | La landing no setea cookies y su CSP solo permite `'self'`; las únicas cookies son las de sesión. Si `analytics` agrega tracking con cookies, se vuelve obligatorio |

Que el reset y la verificación funcionen en código no garantiza que el correo llegue: eso depende de `spf-dkim-dmarc`.
