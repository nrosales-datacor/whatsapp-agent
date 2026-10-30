#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Smoke de un servidor ya levantado: `scripts/ci/smoke.sh <BASE_URL>`.
#
# Lo corren el job `deploy` (después del /health con reintentos) y el job `rollback` de
# .github/workflows/ci-cd.yml, y se puede correr a mano contra un server local
# (`npm run dev` sobre PGlite):  bash scripts/ci/smoke.sh http://localhost:3000
#
# Cada chequeo falla si se rompe una capa distinta, sin credenciales reales ni datos:
#   1. GET  /health                → 200 "…: ok" (proceso + ping a la base).
#   2. GET  /panel                 → 200 con <div id="root"> (el bundle de React está).
#   3. GET  /api/panel/<inexistente> → 404 JSON `not_found` (el router de la API está montado).
#   4. GET  /api/panel/auth/me     → 401 JSON `unauthorized` (la sesión se valida; un 404
#                                    delata que la ruta desapareció, un 500 que algo se rompió).
#   5. POST /api/panel/auth/login  → 401 JSON `invalid_credentials` con un correo de smoke del
#                                    dominio reservado `.invalid` (RFC 2606) y `Origin` del host:
#                                    pasa CSRF + validación y consulta la base (un 500 la delata).
#                                    Es UN intento fallido por corrida: suma al rate-limit de la IP
#                                    del runner y queda en los logs con ese correo (aceptado,
#                                    decisión del 2026-10-30; ver DEPLOY.md §15 y TESTING.md §9).
#
# Sale con código ≠ 0 si cualquiera falla (y los corre todos, para ver el panorama entero).
# El login EXITOSO no se prueba acá (no hay usuario de smoke en producción): lo cubre el
# E2E de CI contra la base efímera (test/e2e/smoke.spec.ts).
# Sin dependencias: bash + curl + grep.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

if [ $# -ne 1 ] || [ -z "$1" ]; then
  echo "Uso: $0 <BASE_URL>   (p. ej. https://app.ejemplo.com o http://localhost:3000)" >&2
  exit 2
fi
BASE_URL="${1%/}"

SMOKE_EMAIL="smoke-test@selyon-smoke.invalid"
SMOKE_PASSWORD="smoke-not-a-real-password"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail=0

ok() { echo "✅ $*"; }
err() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::error::$*"; else echo "❌ $*"; fi
  fail=1
}

# request <método> <ruta> [args extra de curl…] → deja el cuerpo en $tmp/body y
# "<código> <content-type>" en $code / $ctype.
request() {
  local method="$1" path="$2"
  shift 2
  local out
  out="$(curl -sS -o "$tmp/body" -w '%{http_code} %{content_type}' --max-time 20 -X "$method" "$@" "$BASE_URL$path" 2>"$tmp/curl.err")" || {
    code="000"
    ctype=""
    : >"$tmp/body"
    echo "   curl: $(tr -d '\n' <"$tmp/curl.err")"
    return 0
  }
  code="${out%% *}"
  ctype="${out#* }"
}

is_json() { printf '%s' "$ctype" | grep -qi 'application/json'; }
has_code() { grep -q "\"code\":\"$1\"" "$tmp/body"; }

echo "Smoke contra $BASE_URL"

# 1) /health
request GET /health
if [ "$code" = "200" ] && grep -q ': ok$' "$tmp/body"; then
  ok "/health → 200 (proceso y base OK)"
else
  err "/health devolvió HTTP $code; se esperaba 200 '…: ok'"
fi

# 2) Panel compilado
request GET /panel
if [ "$code" = "200" ] && grep -qi '<div id="root"' "$tmp/body"; then
  ok "/panel sirve el bundle de React (200 + #root)"
else
  err "/panel no sirvió el bundle (HTTP $code); ¿falta web:build?"
fi

# 3) Router de la API montado
request GET /api/panel/smoke-route-that-does-not-exist
if [ "$code" = "404" ] && is_json && has_code not_found; then
  ok "/api/panel/<ruta inexistente> → 404 JSON not_found (router montado)"
else
  err "/api/panel/<ruta inexistente> devolvió HTTP $code ($ctype); se esperaba 404 JSON not_found"
fi

# 4) Sesión: /auth/me sin cookie
request GET /api/panel/auth/me
if [ "$code" = "401" ] && is_json && has_code unauthorized; then
  ok "/api/panel/auth/me sin cookie → 401 JSON unauthorized (sesión viva)"
else
  err "/api/panel/auth/me devolvió HTTP $code ($ctype); se esperaba 401 JSON unauthorized"
fi

# 5) Login con credenciales inexistentes (CSRF por Origin + validación + base)
request POST /api/panel/auth/login \
  -H "Origin: $BASE_URL" \
  -H "Content-Type: application/json" \
  --data "{\"email\":\"$SMOKE_EMAIL\",\"password\":\"$SMOKE_PASSWORD\"}"
if [ "$code" = "401" ] && is_json && has_code invalid_credentials; then
  ok "POST /api/panel/auth/login (smoke, credenciales inexistentes) → 401 invalid_credentials"
else
  err "POST /api/panel/auth/login devolvió HTTP $code ($ctype); se esperaba 401 JSON invalid_credentials"
fi

if [ "$fail" -ne 0 ]; then
  echo "Smoke FALLÓ contra $BASE_URL"
else
  echo "Smoke OK contra $BASE_URL"
fi
exit "$fail"
