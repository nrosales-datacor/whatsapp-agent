import { useMemo, useState } from "react";
import type { ResumenConversacion } from "../api";
import { fmtNum, hora } from "../lib/formato";
import Icono from "./Iconos";

interface Props {
  conversaciones: ResumenConversacion[];
  abiertaId: string | null;
  escondida: boolean;
  onAbrir: (id: string) => void;
}

type Filtro = "todos" | "bot" | "humano" | "sin_resp" | "atendida";

const FILTROS: { key: Filtro; label: string }[] = [
  { key: "todos",    label: "Todos" },
  { key: "bot",      label: "Bot" },
  { key: "humano",   label: "Humano" },
  { key: "sin_resp", label: "Sin resp." },
  { key: "atendida", label: "Atendidas" },
];

function scoreClase(s: number) {
  if (s >= 80) return "score-alto";
  if (s >= 55) return "score-medio";
  return "score-bajo";
}

export default function Lista({ conversaciones, abiertaId, escondida, onAbrir }: Props) {
  const [busqueda, setBusqueda] = useState("");
  const [filtro, setFiltro] = useState<Filtro>("todos");

  const conteos = useMemo(() => ({
    todos:    conversaciones.length,
    bot:      conversaciones.filter(c => c.modo === "bot").length,
    humano:   conversaciones.filter(c => c.modo === "humano").length,
    sin_resp: conversaciones.filter(c => c.sinLeer > 0).length,
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
    else if (filtro === "sin_resp") r = r.filter(c => c.sinLeer > 0);
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
            className={"filtro-pill" + (filtro === f.key ? " activo" : "")}
            onClick={() => setFiltro(f.key)}
          >
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
          filtradas.map((c) => (
            <div
              key={c.id}
              className={"conv" + (abiertaId === c.id ? " activa" : "")}
              onClick={() => onAbrir(c.id)}
            >
              {c.leadScore !== undefined ? (
                <div className={`score-tile ${scoreClase(c.leadScore)}`}>
                  {c.leadScore}
                </div>
              ) : (
                <div className="avatar">{c.clienteWa.slice(-2)}</div>
              )}
              <div className="info">
                <div className="fila">
                  <span className={"num" + (c.sinLeer > 0 ? " negrita" : "")}>
                    {fmtNum(c.clienteWa)}
                  </span>
                  <span className={"hora" + (c.sinLeer > 0 ? " hora-accent" : "")}>
                    {hora(c.ultimaActividadEn)}
                  </span>
                </div>
                <div className="fila">
                  <span className="ultimo">{c.ultimoMensaje || "—"}</span>
                  <span className="badges">
                    <span className={"pill " + c.modo}>
                      {c.modo === "humano" ? "humano" : "bot"}
                    </span>
                    {c.sinLeer > 0 && <span className="badge">{c.sinLeer}</span>}
                  </span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
