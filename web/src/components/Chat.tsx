import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cambiarModo, obtenerConversacion, responder, type ResumenConversacion } from "../api";
import { fmtNum, hora } from "../lib/formato";
import Icono from "./Iconos";
import { useToast } from "./Toast";

interface Props {
  id: string | null;
  /** Resumen de la conversación activa (de la lista cacheada). Provee leadScore, tieneCita, etc. */
  resumen: ResumenConversacion | null;
  mostrar: boolean;
  onVolver: () => void;
  onVerFicha: () => void;
}

function scoreClase(s: number) {
  if (s >= 80) return "score-alto";
  if (s >= 55) return "score-medio";
  return "score-bajo";
}

export default function Chat({ id, resumen, mostrar, onVolver, onVerFicha }: Props) {
  const qc = useQueryClient();
  const { flash } = useToast();
  const [texto, setTexto] = useState("");
  const msgsRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const q = useQuery({
    queryKey: ["conversacion", id],
    queryFn: () => obtenerConversacion(id!),
    enabled: !!id,
    refetchInterval: 4000,
  });
  const conv = id ? q.data : undefined;

  function invalidar() {
    qc.invalidateQueries({ queryKey: ["conversacion", id] });
    qc.invalidateQueries({ queryKey: ["conversaciones"] });
  }

  const enviar = useMutation({
    mutationFn: (t: string) => responder(id!, t),
    onSuccess: () => { setTexto(""); invalidar(); },
    onError: (e) => alert(e instanceof Error ? e.message : "No se pudo enviar"),
  });

  const alternarModo = useMutation({
    mutationFn: (modo: "bot" | "humano") => cambiarModo(id!, modo),
    onSuccess: invalidar,
  });

  const msgs = conv?.mensajes ?? [];
  const ultimoTs = msgs.length ? msgs[msgs.length - 1].creadoEn : null;
  useEffect(() => {
    const el = msgsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ultimoTs, id]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
  }, [texto]);

  function mandar() {
    const t = texto.trim();
    if (!t || !id || enviar.isPending) return;
    enviar.mutate(t);
  }

  function accionCita() {
    if (!id || enviar.isPending) return;
    enviar.mutate("Podemos agendar tu cita 📅 ¿Qué servicio necesitás y qué día te queda bien?", {
      onSuccess: () => flash("Mensaje de cita enviado"),
    });
  }

  function accionCotizacion() {
    if (!id || enviar.isPending) return;
    enviar.mutate("Con gusto te preparamos una cotización 📋 ¿Qué servicio necesitás para tu vehículo?", {
      onSuccess: () => flash("Mensaje de cotización enviado"),
    });
  }

  function accionAtendido() {
    qc.invalidateQueries({ queryKey: ["conversaciones"] });
    flash("Conversación marcada como atendida ✓");
  }

  const humano = conv?.modo === "humano";
  const score = resumen?.leadScore;
  const tieneCita = conv?.tieneCita ?? resumen?.tieneCita;
  const servicio = conv?.servicio ?? resumen?.servicio;

  return (
    <section id="chat" className={mostrar ? undefined : "escondido"}>
      <header>
        <button
          type="button"
          className="volver"
          onClick={onVolver}
          title="Volver a la lista"
          aria-label="Volver a la lista"
        >
          <Icono id="back" size={22} sw={2} />
        </button>

        {conv && (
          <div className="chatHead" onClick={onVerFicha}>
            <div className="chat-head-top">
              {score !== undefined && (
                <div className={`score-tile score-tile-sm ${scoreClase(score)}`}>{score}</div>
              )}
              <span id="chatTitulo">{fmtNum(conv.clienteWa)}</span>
              <span className={"pill " + conv.modo}>{humano ? "humano" : "bot"}</span>
              {tieneCita && <span className="pill-cita">📅 Cita</span>}
            </div>
            <div id="chatModo">
              {servicio && <span className="chat-servicio">{servicio} · </span>}
              <span className={"estado-dot " + (humano ? "humano" : "bot")} />
              {humano ? "Lo estás atendiendo vos" : "Lo atiende el bot"}
            </div>
            <div className="ver">Ver ficha del cliente ›</div>
          </div>
        )}

        {conv && (
          <button
            type="button"
            className={"toggle" + (humano ? " devolver" : "")}
            onClick={() => alternarModo.mutate(humano ? "bot" : "humano")}
            disabled={alternarModo.isPending}
          >
            {humano ? "Devolver al bot" : "Atender yo"}
          </button>
        )}
      </header>

      {conv && (
        <div className="acciones-rapidas">
          <button
            type="button"
            className="accion accion-primaria"
            onClick={accionCita}
            disabled={enviar.isPending}
          >
            <Icono id="cal" size={14} />
            Agendar cita
          </button>
          <button
            type="button"
            className="accion accion-outline"
            onClick={accionCotizacion}
            disabled={enviar.isPending}
          >
            <Icono id="quote" size={14} />
            Cotización
          </button>
          <button
            type="button"
            className="accion accion-outline accion-check"
            onClick={accionAtendido}
          >
            <Icono id="check2" size={14} sw={2.2} />
            Atendido
          </button>
        </div>
      )}

      {!conv && (
        <div id="vacio">
          <div className="vacio-card">
            <div className="vacio-icono"><Icono id="chat" size={38} /></div>
            <div className="vacio-titulo">{id ? "Cargando…" : "Elegí una conversación"}</div>
            {!id && (
              <div className="vacio-sub">
                Seleccioná un contacto de la lista para ver la conversación.
              </div>
            )}
          </div>
        </div>
      )}

      {conv && (
        <div id="msgs" ref={msgsRef}>
          {conv.mensajes.map((m, i) => {
            const clase = m.rol === "user" ? "cliente" : m.porHumano ? "humano" : "bot";
            return (
              <div className={"b " + clase} key={i}>
                {m.rol !== "user" && (
                  <div className="quien">{m.porHumano ? "Agente" : "Bot"}</div>
                )}
                {m.contenido}
                <div className="meta">{hora(m.creadoEn)}</div>
              </div>
            );
          })}
        </div>
      )}

      {conv && (
        <div id="composer">
          <textarea
            ref={taRef}
            rows={1}
            placeholder="Escribí un mensaje..."
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                mandar();
              }
            }}
          />
          <button
            type="button"
            onClick={mandar}
            disabled={enviar.isPending}
            title="Enviar"
            aria-label="Enviar mensaje"
          >
            <Icono id="send" size={18} sw={1.8} />
          </button>
        </div>
      )}
    </section>
  );
}
