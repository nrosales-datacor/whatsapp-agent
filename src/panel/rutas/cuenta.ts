import { cambiarClavePropia, hayBaseDeDatos, obtenerUsuarioPorId, recargar } from "../../config/tenantStore";
import { featuresDeTenant } from "../../billing/planes";
import { estadoCuotasDelMes } from "../../observabilidad/cuotas";
import { crearSesion, hashearPassword, verificarPassword } from "../auth";
import { clavePublicaVapid } from "../push";
import { COOKIE, json, leerBody } from "../http";
import type { ContextoOperador } from "./contexto";

// ─────────────────────────────────────────────────────────────────────────────
// Cuenta del operador: /me (sesión, plan, cuotas) y cambio de clave propio.
// ─────────────────────────────────────────────────────────────────────────────

/** /me y cambiar-clave. */
export async function manejarRutasCuenta(ctx: ContextoOperador): Promise<boolean> {
  const { req, res, ruta, metodo, tenant, rol, usuarioId } = ctx;
  if (ruta === "me" && metodo === "GET") {
    // Tope mensual de conversaciones (F10): el dueño ve acá su propio consumo/tope,
    // igual que el superadmin lo ve en admin/tenants (misma fuente, calcularEstadoCuota).
    const { conversaciones: cuota, gastoLlm } = await estadoCuotasDelMes(tenant);
    json(res, 200, {
      ok: true,
      nombre: tenant.nombre,
      tenantId: tenant.id,
      usuarioId,
      rol,
      // Reset de contraseña desde el admin (Carril D, 0.5): el panel fuerza el cambio
      // de clave antes de mostrar nada más mientras esto esté en true.
      debeCambiarClave: obtenerUsuarioPorId(usuarioId)?.debeCambiarClave ?? false,
      vapidPublica: clavePublicaVapid(),
      servicios: tenant.servicios.filter((s) => s.agendable),
      // Moneda del negocio (E11): el panel formatea montos con ella en vez de "₡" fijo
      // (ver web/src/lib/formato.ts). Texto libre: símbolo ("₡") o código ISO ("USD").
      moneda: tenant.moneda,
      // Equipo para los carriles y el selector de la Agenda (ALTO-07). Se mandan también
      // los inactivos: una cita vieja puede estar asignada a alguien que ya no atiende y
      // la Agenda igual tiene que poder mostrar su nombre.
      empleados: tenant.empleados ?? [],
      // White-label (C4.1): el panel se pinta con esto al cargar (ver web/src/lib/marca.ts).
      marca: {
        colorAcento: tenant.colorAcento ?? null,
        colorHeader: tenant.colorHeader ?? null,
        logoUrl: tenant.logoUrl ?? null,
      },
      // Gating de planes (Carril D, 0.1): el panel muestra/oculta sin adivinar.
      plan: tenant.plan,
      features: featuresDeTenant(tenant),
      // Ventana de 24h (Carril D, 0.3): si hay plantilla de reapertura configurada,
      // el chat ofrece el botón "Reabrir conversación" fuera de ventana.
      reaperturaConfigurada: !!tenant.plantillaReapertura,
      // Tope mensual de conversaciones (F10): null en `tope` = sin tope (Pro, o
      // interruptor activado) — el panel del dueño usa esto para el aviso al 80%
      // y el mensaje "el bot está en pausa por límite mensual" al 100%.
      cuotaMensual: {
        tope: cuota.tope,
        usados: cuota.usados,
        porcentaje: cuota.porcentaje,
        alcanzo80: cuota.alcanzo80,
        excedido: cuota.excedido,
      },
      // Tope mensual de GASTO de LLM en USD (revisión pre-venta 2026-10, por plan con
      // override por tenant): misma forma que `cuotaMensual`. Al 100% el bot deja de
      // llamar al LLM y pasa las conversaciones nuevas a humano. `topeUsd` null = sin tope.
      gastoLlmMensual: {
        topeUsd: gastoLlm.topeUsd,
        gastoUsd: gastoLlm.gastoUsd,
        porcentaje: gastoLlm.porcentaje,
        alcanzo80: gastoLlm.alcanzo80,
        excedido: gastoLlm.excedido,
      },
      mensajeTopeExcedido: tenant.mensajeTopeExcedido ?? "",
      // Botón "Mejorar plan" del aviso de cuota (80%/100%): no hay pasarela de pago
      // todavía, así que abre un WhatsApp/correo de la plataforma (env). null = sin
      // configurar (el panel muestra el aviso sin botón).
      contactoPlataforma: {
        whatsapp: (process.env.PLATAFORMA_CONTACTO_WHATSAPP ?? "").replace(/\D/g, "") || null,
        email: process.env.PLATAFORMA_CONTACTO_EMAIL?.trim() || null,
      },
    });
    return true;
  }

  // Cambio de clave propio (Carril D, 0.5): lo usa tanto el cambio obligatorio tras un
  // reset del admin como un cambio voluntario. Requiere la clave actual (o la temporal).
  if (ruta === "cambiar-clave" && metodo === "POST") {
    if (!hayBaseDeDatos()) return json(res, 503, { ok: false, error: "Requiere base de datos (no configurada)." }), true;
    const body = await leerBody(req);
    if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
    const claveActual = String(body?.claveActual ?? "");
    const claveNueva = String(body?.claveNueva ?? "");
    if (claveNueva.length < 8) return json(res, 400, { ok: false, error: "La contraseña debe tener al menos 8 caracteres" }), true;
    const cuenta = obtenerUsuarioPorId(usuarioId);
    if (!cuenta || !(await verificarPassword(claveActual, cuenta.passwordHash))) {
      // 400, no 401: la sesión SÍ es válida. El panel trata cualquier 401 como "sesión
      // vencida" y manda al login, así que un typo en la clave temporal sacaba al usuario
      // de la pantalla de cambio obligatorio sin mostrarle este mensaje.
      return json(res, 400, { ok: false, error: "La contraseña actual no es correcta" }), true;
    }
    try {
      await cambiarClavePropia(tenant.id, usuarioId, await hashearPassword(claveNueva));
    } catch (e) {
      if (e instanceof Error && e.message === "SIN_DB") return json(res, 503, { ok: false, error: "Requiere base de datos." }), true;
      console.error("[panel] cambiarClavePropia:", e);
      return json(res, 500, { ok: false, error: "No se pudo cambiar la contraseña." }), true;
    }
    await recargar();
    // cambiarClavePropia sube el sessionEpoch (revoca TODAS las sesiones, E13/ALTO-06).
    // Este dispositivo acaba de probar la clave: se le reemite la cookie con el epoch
    // nuevo para que siga adentro. Sin esto, tras el cambio obligatorio el usuario caía
    // al login sin ningún aviso; las sesiones de otros dispositivos siguen revocadas.
    const vigente = obtenerUsuarioPorId(usuarioId);
    if (!vigente) return json(res, 200, { ok: true }), true;
    const cookie = `${COOKIE}=${crearSesion(tenant.id, vigente.id, vigente.rol, vigente.sessionEpoch)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 60 * 60}`;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "set-cookie": cookie });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }
  return false;
}
