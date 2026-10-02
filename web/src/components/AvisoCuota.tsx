import { useState } from "react";
import type { ContactoPlataforma, CuotaMensual, Rol } from "../api";
import Icono from "./Iconos";

// ─────────────────────────────────────────────────────────────────────────────
// Aviso de cuota mensual al dueño (F10). `/me` ya traía `cuotaMensual` pero nadie
// lo leía: el negocio llegaba al tope sin enterarse y el bot pasaba todo a humano.
//
//   • 80%-99%: aviso amarillo, se puede cerrar (vuelve el mes siguiente).
//   • 100%:    aviso rojo, NO se puede cerrar mientras dure (el bot está en pausa).
//
// "Mejorar plan" no tiene pasarela de pago todavía: abre el WhatsApp o el correo
// de la plataforma (`contactoPlataforma`, env del backend). Sin contacto
// configurado, el aviso se muestra igual pero sin botón.
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  cuota: CuotaMensual | undefined;
  /** Tope de gasto de IA del mes agotado (G10): el bot también queda en pausa. */
  gastoIaExcedido?: boolean;
  contacto: ContactoPlataforma | undefined;
  rol: Rol;
  nombreNegocio: string;
}

function mesActual(): string {
  return new Date().toISOString().slice(0, 7);
}

function claveCerrado(): string {
  return `aviso-cuota-80-cerrado-${mesActual()}`;
}

function leerCerrado(): boolean {
  try {
    return localStorage.getItem(claveCerrado()) === "1";
  } catch {
    return false;
  }
}

function guardarCerrado(): void {
  try {
    localStorage.setItem(claveCerrado(), "1");
  } catch {
    // Sin storage (modo privado): se cierra solo por esta sesión.
  }
}

/** Link de "Mejorar plan": WhatsApp primero (es el canal del producto), correo si no hay. */
function linkMejorarPlan(contacto: ContactoPlataforma | undefined, nombreNegocio: string): string | null {
  const texto = `Hola, quiero mejorar el plan de ${nombreNegocio}.`;
  if (contacto?.whatsapp) return `https://wa.me/${contacto.whatsapp}?text=${encodeURIComponent(texto)}`;
  if (contacto?.email) {
    return `mailto:${contacto.email}?subject=${encodeURIComponent(`Mejorar plan · ${nombreNegocio}`)}&body=${encodeURIComponent(texto)}`;
  }
  return null;
}

export default function AvisoCuota({ cuota, gastoIaExcedido, contacto, rol, nombreNegocio }: Props) {
  const [cerrado, setCerrado] = useState(leerCerrado);

  // Tope de gasto de IA agotado (y la cuota de conversaciones no): mismo efecto para
  // el dueño —bot en pausa—, aviso rojo fijo.
  if (gastoIaExcedido && !cuota?.excedido) {
    const link = rol === "dueno" ? linkMejorarPlan(contacto, nombreNegocio) : null;
    return (
      <div className="aviso-cuota aviso-cuota-agotada" role="alert">
        <Icono id="alert" size={18} />
        <div className="aviso-cuota-txt">
          <strong>Llegaste al límite de uso de IA de este mes.</strong>{" "}
          El bot está en pausa: los mensajes nuevos llegan a la bandeja para que tu equipo los atienda.
          {rol !== "dueno" && " Avisale al dueño del negocio."}
        </div>
        {link && (
          <a className="aviso-cuota-btn" href={link} target="_blank" rel="noopener noreferrer">
            Mejorar plan
          </a>
        )}
      </div>
    );
  }

  if (!cuota || cuota.tope === null) return null;
  if (!cuota.excedido && !cuota.alcanzo80) return null;
  if (!cuota.excedido && cerrado) return null;

  const link = rol === "dueno" ? linkMejorarPlan(contacto, nombreNegocio) : null;
  const detalle = `${cuota.usados} de ${cuota.tope} conversaciones automáticas este mes`;

  return (
    <div className={"aviso-cuota" + (cuota.excedido ? " aviso-cuota-agotada" : "")} role={cuota.excedido ? "alert" : "status"}>
      <Icono id="alert" size={18} />
      <div className="aviso-cuota-txt">
        {cuota.excedido ? (
          <>
            <strong>Llegaste al tope de tu plan ({detalle}).</strong>{" "}
            El bot está en pausa: los mensajes nuevos llegan a la bandeja para que tu equipo los atienda.
          </>
        ) : (
          <>
            <strong>Usaste el {cuota.porcentaje}% de tu plan ({detalle}).</strong>{" "}
            Al llegar al 100%, el bot deja de responder y los mensajes nuevos pasan a tu equipo.
          </>
        )}
        {rol !== "dueno" && " Avisale al dueño del negocio."}
      </div>
      {link && (
        <a className="aviso-cuota-btn" href={link} target="_blank" rel="noopener noreferrer">
          Mejorar plan
        </a>
      )}
      {!cuota.excedido && (
        <button
          type="button"
          className="aviso-cuota-cerrar"
          title="Cerrar aviso"
          aria-label="Cerrar aviso"
          onClick={() => {
            guardarCerrado();
            setCerrado(true);
          }}
        >
          <Icono id="x" size={16} />
        </button>
      )}
    </div>
  );
}
