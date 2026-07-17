import { useMemo, useState } from "react";
import type { ResumenConversacion } from "../api";
import { fmtNum, hora, transcurrido } from "../lib/formato";
import Icono from "./Iconos";

interface Props {
  conversaciones: ResumenConversacion[];
  abiertaId: string | null;
  escondida: boolean;
  onAbrir: (id: string) => void;
}

type Filtro = "todos" | "bot" | "humano" | "necesita" | "atendida";

const FILTROS: { key: Filtro; label: string; alerta?: boolean }[] = [
  { key: "todos",    label: "Todos" },
  { key: "bot",      label: "Bot" },
  { key: "humano",   label: "Vos" },
  { key: "necesita", label: "Necesita respuesta", alerta: true },
  { key: "atendida", label: "Atendidas" },
];

/** Bucketiza el lead score (0-100) para el medidor de interés: 3 barras + etiqueta. */
function interesBucket(s: number): { clase: string; llenas: number; label: string } {
  if (s >= 80) return { clase: "alto", llenas: 3, label: "alto" };
  if (s >= 55) return { clase: "medio", llenas: 2, label: "medio" };
  return { clase: "bajo", llenas: 1, label: "bajo" };
}

/** Necesita intervención humana: en modo humano (el bot ya no responde solo)
 *  y con mensajes del cliente sin leer — no alcanza con "sin_resp" a secas,
 *  porque una conversación en modo bot con mensajes sin leer no requiere que
 *  el operador entre (el bot ya la está atendiendo). */
function necesitaRespuesta(c: ResumenConversacion): boolean {
  return c.modo === "humano" && c.sinLeer > 0;
}

export default function Lista({ conversaciones, abiertaId, escondida, onAbrir }: Props) {
  const [busqueda, setBusqueda] = useState("");
  const [filtro, setFiltro] = useState<Filtro>("todos");

  const conteos = useMemo(() => ({
    todos:    conversaciones.length,
    bot:      conversaciones.filter(c => c.modo === "bot").length,
    humano:   conversaciones.filter(c => c.modo === "humano").length,
    necesita: conversaciones.filter(necesitaRespuesta).length,
    atendida: conversaciones.filter(c => c.estado === "atendida").length,
  }), [conversaciones]);

  const filtradas = useMemo(() => {
    let r = conversaciones;
    if (busqueda) {
      const q = busqueda.toLowerCase();
      r = r.filter(c =>
        c.clienteWa.toLowerCase().includes(q) ||
        (c.ultimoMensaje?.toLowerCase().includes(q))
      );
    }
    if (filtro === "bot")      r = r.filter(c => c.modo === "bot");
    else if (filtro === "humano")   r = r.filter(c => c.modo === "humano");
    else if (filtro === "necesita") r = r.filter(necesitaRespuesta);
    else if (filtro === "atendida") r = r.filter(c => c.estado === "atendida");
    return r;
  }, [conversaciones, busqueda, filtro]);

  return (
    <section id="lista" className={escondida ? "escondida" : undefined}>
      <div className="lista-buscador">
        <div className="buscador">
          <Icono id="search" size={15} />
          <input
            type="search"
            placeholder="Buscar..."
            value={busqueda}
            onChange={e => setBusqueda(e.target.value)}
            autoComplete="off"
          />
        </div>
      </div>

      <div className="filtros-pill">
        {FILTROS.map(f => (
          <button
            key={f.key}
            type="button"
            className={"filtro-pill" + (f.alerta ? " filtro-alerta" : "") + (filtro === f.key ? " activo" : "")}
            onClick={() => setFiltro(f.key)}
          >
            {f.alerta && <span className="filtro-dot" />}
            {f.label}
            <span className="filtro-count">{conteos[f.key]}</span>
          </button>
        ))}
      </div>

      <div id="convs">
        {filtradas.length === 0 ? (
          <div className="convs-vacio">
            {busqueda || filtro !== "todos"
              ? "Sin resultados para este filtro."
              : "Todavía no hay conversaciones."}
          </div>
        ) : (
          filtradas.map((c) => {
            const necesita = necesitaRespuesta(c);
            const interes = c.leadScore !== undefined ? interesBucket(c.leadScore) : null;
            return (
              <div
                key={c.id}
                className={"conv" + (abiertaId === c.id ? " activa" : "") + (necesita ? " necesita" : "")}
                onClick={() => onAbrir(c.id)}
              >
                <div className="avatar">{c.clienteWa.slice(-2)}</div>
                <div className="info">
                  <div className="fila">
                    <span className={"num" + (c.sinLeer > 0 ? " negrita" : "")}>
                      {c.nombre || fmtNum(c.clienteWa)}
                    </span>
                    <span className={"hora" + (c.sinLeer > 0 ? " hora-accent" : "")}>
                      {hora(c.ultimaActividadEn)}
                    </span>
                  </div>
                  <div className="fila">
                    <span className="ultimo">{c.ultimoMensaje || "—"}</span>
                    <span className="badges">
                      <span className={"pill " + c.modo}>
                        {c.modo === "humano" ? "vos" : "bot"}
                      </span>
                      {c.sinLeer > 0 && <span className="badge">{c.sinLeer}</span>}
                    </span>
                  </div>
                  {(interes || necesita) && (
                    <div className="fila">
                      {interes && (
                        <span
                          className="interes"
                          title="Interés estimado del cliente, según intención de agendar y actividad reciente."
                        >
                          <span className="interes-barras">
                            <span className={"interes-barra" + (interes.llenas >= 1 ? " on" : "")} />
                            <span className={"interes-barra" + (interes.llenas >= 2 ? " on" : "")} />
                            <span className={"interes-barra" + (interes.llenas >= 3 ? " on" : "")} />
                          </span>
                          <span className="interes-label">Interés {interes.label}</span>
                        </span>
                      )}
                      {necesita && (
                        <span className="chip-alerta">
                          <Icono id="alert" size={11} sw={2.2} />
                          Sin responder {transcurrido(c.ultimaActividadEn)}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
