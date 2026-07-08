import type { Bloqueo, HorarioDia, Service } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Validación server-side de la config de un negocio (horario/servicios/faq/
// bloqueos). Compartida por el alta de negocios (onboarding B3, superadmin) y
// la config self-service del operador (ROADMAP C2.2) — nunca se confía en el
// cliente, ambos caminos revalidan acá.
// ─────────────────────────────────────────────────────────────────────────────

export const RE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
export const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

export function limpiarLineas(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((s) => String(s ?? "").trim()).filter(Boolean);
}

export function validarHorario(v: any): Record<number, HorarioDia> | null {
  const out: Record<number, HorarioDia> = {};
  for (let d = 0; d < 7; d++) {
    const dia = v && typeof v === "object" ? v[d] : undefined;
    if (dia === undefined || dia === null) {
      out[d] = { abre: "06:00", cierra: "18:00" }; // default razonable para días sin especificar
      continue;
    }
    const abre = dia.abre ?? null;
    const cierra = dia.cierra ?? null;
    if (abre === null && cierra === null) {
      out[d] = { abre: null, cierra: null }; // cerrado
      continue;
    }
    if (typeof abre !== "string" || typeof cierra !== "string" || !RE_HORA.test(abre) || !RE_HORA.test(cierra)) {
      return null;
    }
    out[d] = { abre, cierra };
  }
  return out;
}

export function validarServicios(v: unknown): Service[] | null {
  if (!Array.isArray(v)) return null;
  const vistos = new Set<string>();
  const out: Service[] = [];
  for (const s of v) {
    if (!s || typeof s !== "object") return null;
    const r = s as Record<string, unknown>;
    const id = String(r.id ?? "").trim();
    const nombre = String(r.nombre ?? "").trim();
    const duracionMin = Number(r.duracionMin);
    if (!RE_SLUG.test(id) || id.length > 50 || vistos.has(id)) return null;
    if (!nombre || nombre.length > 120) return null;
    if (!Number.isInteger(duracionMin) || duracionMin <= 0 || duracionMin > 600) return null;
    vistos.add(id);
    const serv: Service = { id, nombre, duracionMin };
    if (r.agendable) serv.agendable = true;
    if (r.precioVariable) serv.precioVariable = true;
    if (r.precio !== undefined && r.precio !== null && r.precio !== "") {
      const p = Number(r.precio);
      if (!Number.isInteger(p) || p < 0) return null;
      serv.precio = p;
    }
    const precioNota = String(r.precioNota ?? "").trim();
    if (precioNota) serv.precioNota = precioNota.slice(0, 200);
    const descripcion = String(r.descripcion ?? "").trim();
    if (descripcion) serv.descripcion = descripcion.slice(0, 500);
    out.push(serv);
  }
  return out;
}

export function validarFaq(v: unknown): { pregunta: string; respuesta: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { pregunta: string; respuesta: string }[] = [];
  for (const f of v) {
    if (!f || typeof f !== "object") continue;
    const r = f as Record<string, unknown>;
    const pregunta = String(r.pregunta ?? "").trim();
    const respuesta = String(r.respuesta ?? "").trim();
    if (pregunta && respuesta) out.push({ pregunta: pregunta.slice(0, 300), respuesta: respuesta.slice(0, 1000) });
  }
  return out;
}

/**
 * Valida los bloqueos (feriados/vacaciones puntuales, ROADMAP C2.2). Los solapados se
 * permiten tal cual: espaciosDisponibles() solo hace un chequeo de pertenencia por fecha,
 * así que un rango redundante es inofensivo — no vale la pena la complejidad de mergearlos.
 */
export function validarBloqueos(v: unknown): Bloqueo[] | null {
  if (!Array.isArray(v)) return null;
  if (v.length > 50) return null;
  const out: Bloqueo[] = [];
  for (const b of v) {
    if (!b || typeof b !== "object") return null;
    const r = b as Record<string, unknown>;
    const desde = String(r.desde ?? "");
    const hasta = String(r.hasta ?? "");
    if (!RE_FECHA.test(desde) || !RE_FECHA.test(hasta) || desde > hasta) return null;
    const bloqueo: Bloqueo = { desde, hasta };
    const motivo = String(r.motivo ?? "").trim();
    if (motivo) bloqueo.motivo = motivo.slice(0, 200);
    out.push(bloqueo);
  }
  return out;
}
