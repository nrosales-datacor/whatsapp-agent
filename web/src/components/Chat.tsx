import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cambiarEstadoConversacion,
  cambiarModo,
  obtenerConversacion,
  reabrirConversacion,
  responder,
  type ResumenConversacion,
} from "../api";
import { fmtNum, hora, restante } from "../lib/formato";
import EstadoVacio from "./EstadoVacio";
import Icono from "./Iconos";
import { useToast } from "./Toast";

interface Props {
  id: string | null;
  /** Resumen de la conversación activa (de la lista cacheada). Provee tieneCita, servicio, etc. */
  resumen: ResumenConversacion | null;
  /** Ventana de 24h (Carril D, 0.3): el negocio configuró la plantilla de reapertura. */
  reaperturaConfigurada: boolean;
  mostrar: boolean;
  onVolver: () => void;
  onVerFicha: () => void;
  /** Id de la conversación que necesita respuesta (si hay alguna) — habilita la CTA del vacío. */
  conversacionNecesitaId: string | null;
  onVerNecesitaRespuesta?: () => void;
}

export default function Chat({
  id,
  resumen,
  reaperturaConfigurada,
  mostrar,
  onVolver,
  onVerFicha,
  conversacionNecesitaId,
  onVerNecesitaRespuesta,
}: Props) {
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
    onError: (e) => {
      const msg = e instanceof Error ? e.message : "No se pudo enviar";
      flash(msg === "ventana_cerrada" ? "La ventana de 24h se cerró — reabrí la conversación para escribir" : msg);
      if (msg === "ventana_cerrada") invalidar();
    },
  });

  const reabrir = useMutation({
    mutationFn: () => reabrirConversacion(id!),
    onSuccess: () => { invalidar(); flash("Plantilla de reapertura enviada"); },
    onError: (e) => flash(e instanceof Error ? e.message : "No se pudo reabrir la conversación"),
  });

  // El borrador es por conversación: si se cambia de chat sin enviar, no debe
  // arrastrarse ni terminar mandándose a la conversación equivocada.
  useEffect(() => setTexto(""), [id]);

  const alternarModo = useMutation({
    mutationFn: (modo: "bot" | "humano") => cambiarModo(id!, modo),
    onSuccess: invalidar,
  });

  const alternarEstado = useMutation({
    mutationFn: (estado: "abierta" | "atendida") => cambiarEstadoConversacion(id!, estado),
    onSuccess: (_data, estado) => {
      invalidar();
      flash(estado === "atendida" ? "Conversación marcada como atendida ✓" : "Conversación reabierta");
    },
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

  // El backend pasa la conversación a modo humano en cuanto un operador responde
  // (misma ruta que "responder"). Si el bot todavía la estaba atendiendo, avisamos
  // antes de apagarlo — si no, este botón lo desactivaba sin que el operador
  // lo pidiera ni se enterara.
  function confirmarSiApagaBot(): boolean {
    if (!humano) {
      return window.confirm("Esto pasa la conversación a modo humano (el bot deja de responder). ¿Continuar?");
    }
    return true;
  }

  function accionCita() {
    if (!id || enviar.isPending || !confirmarSiApagaBot()) return;
    enviar.mutate("Podemos agendar tu cita 📅 ¿Qué servicio necesitás y qué día te queda bien?", {
      onSuccess: () => flash("Mensaje de cita enviado"),
    });
  }

  function accionCotizacion() {
    if (!id || enviar.isPending || !confirmarSiApagaBot()) return;
    enviar.mutate("Con gusto te preparamos una cotización 📋 ¿Qué servicio necesitás para tu vehículo?", {
      onSuccess: () => flash("Mensaje de cotización enviado"),
    });
  }

  function accionAtendido() {
    if (!id || alternarEstado.isPending) return;
    alternarEstado.mutate(conv?.estado === "atendida" ? "abierta" : "atendida");
  }

  const humano = conv?.modo === "humano";
  const atendida = conv?.estado === "atendida";
  const tieneCita = conv?.tieneCita ?? resumen?.tieneCita;
  const citaConfirmada = conv?.citaConfirmada ?? resumen?.citaConfirmada;
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
              <span id="chatTitulo">{resumen?.nombre || fmtNum(conv.clienteWa)}</span>
              <span className={"pill-estado " + conv.modo}>
                <span className={"estado-dot " + (humano ? "humano" : "bot")} />
                {humano ? "Lo atendés vos" : "Lo atiende el bot"}
              </span>
              {tieneCita && (
                <span className={"pill-cita" + (citaConfirmada ? " confirmada" : "")}>
                  {citaConfirmada ? "✅ Cita confirmada" : "📅 Cita"}
                </span>
              )}
            </div>
            <div id="chatModo">
              {servicio && <span className="chat-servicio">{servicio} ·</span>}
              <span className="tnum">{fmtNum(conv.clienteWa)}</span>
              <span>·</span>
              <span
                className={"pill-ventana" + (conv.ventanaAbierta ? " abierta" : " cerrada")}
                title="Ventana de sesión de WhatsApp: solo se puede escribir texto libre dentro de las 24h posteriores al último mensaje del cliente"
              >
                {conv.ventanaAbierta ? `🟢 cierra en ${restante(conv.ventanaCierraEn)}` : "🔴 ventana cerrada"}
              </span>
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
            className={"accion accion-outline accion-check" + (atendida ? " activa" : "")}
            onClick={accionAtendido}
            disabled={alternarEstado.isPending}
          >
            <Icono id="check2" size={14} sw={2.2} />
            {atendida ? "Reabrir" : "Atendido"}
          </button>
        </div>
      )}

      {!conv && !id && (
        <div id="vacio">
          <EstadoVacio
            icono="chat"
            titulo="Elegí una conversación"
            ayuda="Seleccioná un contacto de la lista para ver la conversación."
            accion={
              conversacionNecesitaId && onVerNecesitaRespuesta
                ? { texto: "Ver la que necesita respuesta", icono: "alert", tono: "alerta", onClick: onVerNecesitaRespuesta }
                : undefined
            }
          />
        </div>
      )}

      {!conv && id && (
        <div id="vacio">
          <p className="vacio-cargando">Cargando…</p>
        </div>
      )}

      {conv && (
        <div id="msgs" ref={msgsRef}>
          {conv.mensajes.map((m, i) => {
            const clase = m.rol === "user" ? "cliente" : m.porHumano ? "humano" : "bot";
            const esImagen = m.mediaTipo === "imagen" && !!m.mediaUrl;
            const texto = esImagen ? m.contenido.replace(/^\[foto\]\s*/, "") : m.contenido;
            return (
              <div className={"b " + clase} key={i}>
                {m.rol !== "user" && (
                  <div className="quien">{m.porHumano ? "Agente" : "Bot"}</div>
                )}
                {esImagen && <img src={m.mediaUrl} alt="Foto enviada por el cliente" className="msg-img" />}
                {texto}
                <div className="meta">{hora(m.creadoEn)}</div>
              </div>
            );
          })}
        </div>
      )}

      {conv && !conv.ventanaAbierta && (
        <div id="composer" className="composer-cerrado">
          <span className="composer-cerrado-msg">
            🔴 Ventana de 24h cerrada: no se puede escribir texto libre hasta que el cliente vuelva a escribir.
          </span>
          {reaperturaConfigurada ? (
            <button
              type="button"
              className="accion accion-primaria"
              onClick={() => reabrir.mutate()}
              disabled={reabrir.isPending}
            >
              Reabrir conversación
            </button>
          ) : (
            <span className="composer-cerrado-ayuda">
              Configurá la plantilla de reapertura en "Mi negocio" para poder reabrirla.
            </span>
          )}
        </div>
      )}

      {conv && conv.ventanaAbierta && (
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
