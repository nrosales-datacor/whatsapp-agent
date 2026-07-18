import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { guardarNotas, obtenerFicha } from "../api";
import { fechaCorta, fmtNum, iniciales } from "../lib/formato";
import Icono from "./Iconos";

interface Props {
  convId: string;
  clienteWa: string;
  onCerrar: () => void;
}

// A partir de cuántas citas totales se muestra el pill "Cliente frecuente" —
// heurística en el cliente, igual criterio que estadoVisual() en Agenda.tsx:
// no hay (ni se agrega) un campo de backend para esto.
const UMBRAL_FRECUENTE = 3;

const ETIQUETA_ESTADO_CITA: Record<string, string> = {
  agendada: "Agendada",
  completada: "Completada",
  cancelada: "Cancelada",
  no_show: "No-show",
};

const TONO_DOT_CITA: Record<string, string> = {
  agendada: "accent",
  completada: "success",
  cancelada: "danger",
  no_show: "warning",
};

// Mini-CRM del cliente (modal). Datos agregados + historial + notas privadas.
export default function FichaModal({ convId, clienteWa, onCerrar }: Props) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["ficha", convId], queryFn: () => obtenerFicha(convId) });
  const ficha = q.data ?? null;

  // Notas editables: se precargan cuando llega la ficha.
  const [notas, setNotas] = useState("");
  useEffect(() => {
    setNotas(ficha?.notas ?? "");
  }, [ficha]);

  const [guardado, setGuardado] = useState(false);
  const guardar = useMutation({
    mutationFn: () => guardarNotas(convId, notas),
    onSuccess: () => {
      setGuardado(true);
      setTimeout(() => setGuardado(false), 1500);
      qc.invalidateQueries({ queryKey: ["ficha", convId] });
    },
  });

  const nombre = ficha?.nombre?.trim() || null;
  const avatarTxt = nombre ? iniciales(nombre) : clienteWa.slice(-2);
  const frecuente = (ficha?.totalCitas ?? 0) >= UMBRAL_FRECUENTE;

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCerrar();
      }}
    >
      <div className="ficha-modal ficha-modal-cliente">
        <div className="ficha-head ficha-cliente-head">
          <div className="ficha-cliente-avatar">{avatarTxt}</div>
          <div className="ficha-cliente-id">
            <div className="ficha-cliente-nombre-row">
              <h3>{nombre || "Cliente"}</h3>
              {frecuente && (
                <span className="pill-frecuente">
                  <Icono id="star" size={11} sw={0} />
                  Cliente frecuente
                </span>
              )}
            </div>
            <div className="ficha-cliente-tel tnum">{fmtNum(clienteWa)}</div>
          </div>
          <button type="button" onClick={onCerrar} title="Cerrar">
            ✕
          </button>
        </div>
        <div className="ficha-body">
          <div className="ficha-tiles">
            <div className="ficha-tile">
              <span className="ficha-tile-label">Vehículo · Placa</span>
              <b className="ficha-tile-valor tnum">{ficha && ficha.placas.length ? ficha.placas.join(", ") : "—"}</b>
            </div>
            <div className="ficha-tile">
              <span className="ficha-tile-label">Total de citas</span>
              <b className="ficha-tile-valor tnum">{ficha?.totalCitas ?? 0}</b>
            </div>
            <div className="ficha-tile">
              <span className="ficha-tile-label">Última visita</span>
              <b className="ficha-tile-valor tnum">{fechaCorta(ficha?.ultimaVisita)}</b>
            </div>
            <div className="ficha-tile">
              <span className="ficha-tile-label">Cliente desde</span>
              <b className="ficha-tile-valor tnum">{fechaCorta(ficha?.primerContacto)}</b>
            </div>
          </div>

          <h4>Historial de servicios</h4>
          {ficha && ficha.historial.length ? (
            <div className="ficha-historial">
              {ficha.historial.map((h, i) => (
                <div className="ficha-historial-item" key={i}>
                  <span className={`ficha-historial-dot ficha-historial-dot-${TONO_DOT_CITA[h.estado] ?? "accent"}`} />
                  <div className="ficha-historial-info">
                    <span className="ficha-historial-servicio">{h.servicioNombre}</span>
                    <span className="ficha-historial-fecha tnum">
                      {fechaCorta(h.fecha)} {h.hora}
                    </span>
                  </div>
                  <span className={"badge-estado" + (h.estado !== "agendada" ? ` ${h.estado}` : "")}>
                    {ETIQUETA_ESTADO_CITA[h.estado] ?? h.estado}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="admin-vacio">Sin citas todavía.</div>
          )}

          <div className="ficha-notas-card">
            <div className="ficha-notas-titulo">
              <Icono id="lock" size={13} />
              Notas privadas
            </div>
            <textarea
              className="ficha-notas-input"
              placeholder="Ej: paga con SINPE, prefiere las mañanas, cliente de Uber..."
              value={notas}
              onChange={(e) => setNotas(e.target.value)}
            />
            <button type="button" className="ficha-notas-guardar" onClick={() => guardar.mutate()} disabled={guardar.isPending}>
              {guardado ? "Guardado" : "Guardar notas"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
