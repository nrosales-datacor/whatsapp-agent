import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { guardarNotas, obtenerFicha } from "../api";
import { fechaCorta, fmtNum } from "../lib/formato";

interface Props {
  convId: string;
  clienteWa: string;
  onCerrar: () => void;
}

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

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCerrar();
      }}
    >
      <div className="ficha-modal">
        <div className="ficha-head">
          <h3>{ficha?.nombre || "Cliente"}</h3>
          <button type="button" onClick={onCerrar} title="Cerrar">
            ✕
          </button>
        </div>
        <div className="ficha-body">
          <div className="dato">
            <span>Teléfono</span>
            <b>{fmtNum(clienteWa)}</b>
          </div>
          <div className="dato">
            <span>Vehículo / Placa</span>
            <b>{ficha && ficha.placas.length ? ficha.placas.join(", ") : "—"}</b>
          </div>
          <div className="dato">
            <span>Total de citas</span>
            <b>{ficha?.totalCitas ?? 0}</b>
          </div>
          <div className="dato">
            <span>Última visita</span>
            <b>{fechaCorta(ficha?.ultimaVisita)}</b>
          </div>
          <div className="dato">
            <span>Cliente desde</span>
            <b>{fechaCorta(ficha?.primerContacto)}</b>
          </div>

          <h4>Historial de servicios</h4>
          <div>
            {ficha && ficha.historial.length ? (
              ficha.historial.map((h, i) => (
                <div className="hist" key={i}>
                  <b>{h.servicioNombre}</b> · {fechaCorta(h.fecha)} {h.hora}{" "}
                  <span style={{ color: "var(--text-muted)" }}>({h.estado})</span>
                </div>
              ))
            ) : (
              <div style={{ color: "var(--gris)", fontSize: 13 }}>Sin citas todavía.</div>
            )}
          </div>

          <h4>Notas privadas</h4>
          <textarea
            id="fNotas"
            placeholder="Ej: paga con SINPE, prefiere las mañanas, cliente de Uber..."
            value={notas}
            onChange={(e) => setNotas(e.target.value)}
          />
          <button type="button" id="guardarNotas" onClick={() => guardar.mutate()} disabled={guardar.isPending}>
            {guardado ? "Guardado" : "Guardar notas"}
          </button>
        </div>
      </div>
    </div>
  );
}
