import type { ResumenConversacion } from "../api";
import { fmtNum, hora } from "../lib/formato";

interface Props {
  nombre: string;
  conversaciones: ResumenConversacion[];
  abiertaId: string | null;
  /** En móvil, cuando hay un chat abierto, la lista se esconde (la tapa el chat). */
  escondida: boolean;
  onAbrir: (id: string) => void;
  onPanel: () => void;
  onSalir: () => void;
}

// Columna izquierda: encabezado del negocio + lista de conversaciones.
export default function Lista({ nombre, conversaciones, abiertaId, escondida, onAbrir, onPanel, onSalir }: Props) {
  return (
    <section id="lista" className={escondida ? "escondida" : undefined}>
      <header>
        <span className="negocio">{nombre}</span>
        <div className="acciones">
          <button type="button" className="btn-ghost" onClick={onPanel}>
            Panel
          </button>
          <button type="button" className="btn-ghost" onClick={onSalir}>
            Salir
          </button>
        </div>
      </header>
      <div id="convs">
        {conversaciones.length === 0 ? (
          <div style={{ padding: 24, color: "var(--gris)", textAlign: "center" }}>
            Todavía no hay conversaciones.
          </div>
        ) : (
          conversaciones.map((c) => (
            <div
              key={c.id}
              className={"conv" + (abiertaId === c.id ? " activa" : "")}
              onClick={() => onAbrir(c.id)}
            >
              <div className="avatar">{c.clienteWa.slice(-2)}</div>
              <div className="info">
                <div className="fila">
                  <span className="num">{fmtNum(c.clienteWa)}</span>
                  <span className="hora">{hora(c.ultimaActividadEn)}</span>
                </div>
                <div className="fila">
                  <span className="ultimo">{c.ultimoMensaje || "—"}</span>
                  <span className="badges">
                    <span className={"pill " + c.modo}>{c.modo === "humano" ? "humano" : "bot"}</span>
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
