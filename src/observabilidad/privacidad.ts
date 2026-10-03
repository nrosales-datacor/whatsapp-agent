// ─────────────────────────────────────────────────────────────────────────────
// Datos personales en los logs (revisión pre-venta 2026-10, Ley 8968).
//
// Los logs (`pm2 logs`, Sentry, un colector externo) NO son un lugar para datos
// personales del cliente final: los lee más gente que el panel, se copian a otros
// sistemas y no los alcanza el borrado de un cliente (src/config/supresionCliente.ts).
// Reglas para cualquier console.* / log.* del backend:
//   - El teléfono del cliente final va SIEMPRE enmascarado: enmascararTelefono().
//   - El CONTENIDO de un mensaje (texto entrante, transcripción, respuesta del bot,
//     nombres de archivo/contacto) NO se loguea: solo su tipo y su longitud
//     (describirTexto()). Para depurar una conversación está el panel.
// test/security/logsSinPii.test.ts falla si un log interpola esas variables sin
// pasar por estos helpers.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "50688887777" → "506***7777". Deja el prefijo de país (3 dígitos) y los últimos 4
 * para poder correlacionar con el panel sin exponer el número completo. Con 8
 * dígitos o menos solo deja los últimos 2. Idempotente: un valor ya enmascarado
 * (con `*`) se devuelve tal cual.
 */
export function enmascararTelefono(telefono: string | null | undefined): string {
  if (!telefono) return "—";
  if (telefono.includes("*")) return telefono;
  const digitos = telefono.replace(/\D/g, "");
  if (digitos.length === 0) return "***";
  if (digitos.length <= 8) return `***${digitos.slice(-2)}`;
  return `${digitos.slice(0, 3)}***${digitos.slice(-4)}`;
}

/** Describe un contenido sin revelarlo: "[42 car.]" (o "[vacío]"). */
export function describirTexto(texto: string | null | undefined): string {
  if (!texto) return "[vacío]";
  return `[${texto.length} car.]`;
}

// Campos que, si llegan a log.* (src/observabilidad/log.ts), se sanean solos como
// red de seguridad, aunque quien loguea se olvide del helper.
const CAMPOS_TELEFONO = new Set(["clienteWa", "telefono", "to"]);
const CAMPOS_CONTENIDO = new Set(["texto", "contenido", "respuesta", "body", "transcripcion"]);

/** Copia de `campos` con teléfonos enmascarados y contenidos reemplazados por su longitud. */
export function sanearCamposLog(campos: Record<string, unknown>): Record<string, unknown> {
  let copia: Record<string, unknown> | null = null;
  for (const [clave, valor] of Object.entries(campos)) {
    let saneado: unknown = valor;
    if (CAMPOS_TELEFONO.has(clave) && typeof valor === "string") saneado = enmascararTelefono(valor);
    else if (CAMPOS_CONTENIDO.has(clave) && typeof valor === "string") saneado = describirTexto(valor);
    if (saneado !== valor) {
      copia ??= { ...campos };
      copia[clave] = saneado;
    }
  }
  return copia ?? campos;
}
