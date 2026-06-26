import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cambiarModo, obtenerConversacion, responder } from "../api";
import { fmtNum, hora } from "../lib/formato";

interface Props {
  id: string | null;
  /** En móvil, si el panel de chat está visible (encima de la lista). */
  mostrar: boolean;
  onVolver: () => void;
  onVerFicha: () => void;
}

// Columna derecha: la conversación abierta. Trae sus mensajes con polling (4s),
// igual que la lista; responder o cambiar de modo refresca ambas queries.
export default function Chat({ id, mostrar, onVolver, onVerFicha }: Props) {
  const qc = useQueryClient();
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
    onSuccess: () => {
      setTexto("");
      invalidar();
    },
    onError: (e) => alert(e instanceof Error ? e.message : "No se pudo enviar"),
  });

  const alternarModo = useMutation({
    mutationFn: (modo: "bot" | "humano") => cambiarModo(id!, modo),
    onSuccess: invalidar,
  });

  // Auto-scroll al fondo cuando entra un mensaje nuevo o se cambia de chat.
  const msgs = conv?.mensajes ?? [];
  const ultimoTs = msgs.length ? msgs[msgs.length - 1].creadoEn : null;
  useEffect(() => {
    const el = msgsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ultimoTs, id]);

  // Auto-crecer el textarea (hasta 120px) según el contenido, igual que el inbox.html.
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

  const humano = conv?.modo === "humano";

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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        {conv && (
          <div className="chatHead" onClick={onVerFicha}>
            <div id="chatTitulo">{fmtNum(conv.clienteWa)}</div>
            <div id="chatModo">
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

      {!conv && <div id="vacio">{id ? "Cargando…" : "Elegí una conversación para empezar."}</div>}

      {conv && (
        <div id="msgs" ref={msgsRef}>
          {conv.mensajes.map((m, i) => {
            const clase = m.rol === "user" ? "cliente" : m.porHumano ? "humano" : "bot";
            return (
              <div className={"b " + clase} key={i}>
                {m.rol !== "user" && <div className="quien">{m.porHumano ? "Vos" : "Bot"}</div>}
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
          <button type="button" onClick={mandar} disabled={enviar.isPending} title="Enviar" aria-label="Enviar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 2 11 13" />
              <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
            </svg>
          </button>
        </div>
      )}
    </section>
  );
}
