import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cancelarCampania,
  crearCampania,
  enviarCampania,
  listarCampanias,
  obtenerCampania,
  obtenerConfig,
  previsualizarSegmento,
  type Campania,
  type PreviewSegmento,
  type SegmentoFiltro,
} from "../api";
import { useToast } from "./Toast";

// ─────────────────────────────────────────────────────────────────────────────
// "Campañas" (ROADMAP C3.2): solo el dueño la ve (mismo guard doble que
// "Usuarios"/"Mi negocio" — Panel.tsx esconde la pestaña Y el backend rechaza
// /api/panel/campanias si el rol no es "dueno"). Arma un segmento del CRM,
// previsualiza cuántos clientes califican, y confirma el envío (ahora o
// programado) por la plantilla MARKETING configurada en "Mi negocio".
// ─────────────────────────────────────────────────────────────────────────────

const NOMBRES_ESTADO: Record<Campania["estado"], string> = {
  borrador: "Borrador",
  programada: "Programada",
  enviando: "Enviando",
  completada: "Completada",
  cancelada: "Cancelada",
};

function BadgeEstado({ estado }: { estado: Campania["estado"] }) {
  return <span className={`badge-estado ${estado}`}>{NOMBRES_ESTADO[estado]}</span>;
}

function fechaCorta(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-CR", { dateStyle: "short", timeStyle: "short" });
}

export default function Campanias() {
  const qc = useQueryClient();
  const { flash } = useToast();
  const q = useQuery({ queryKey: ["campanias"], queryFn: listarCampanias });
  const config = useQuery({ queryKey: ["config"], queryFn: obtenerConfig });

  const [seleccionadaId, setSeleccionadaId] = useState<string | null>(null);

  const [nombre, setNombre] = useState("");
  const [mensaje, setMensaje] = useState("");
  const [segmentoTipo, setSegmentoTipo] = useState<SegmentoFiltro["tipo"]>("todos");
  const [dias, setDias] = useState("60");
  const [servicioId, setServicioId] = useState("");
  const [meses, setMeses] = useState("6");
  const [preview, setPreview] = useState<PreviewSegmento | null>(null);

  const invalidarLista = () => qc.invalidateQueries({ queryKey: ["campanias"] });

  function filtroActual(): SegmentoFiltro {
    if (segmentoTipo === "inactivos") return { tipo: "inactivos", dias: Number(dias) || 60 };
    if (segmentoTipo === "servicio_antiguo") return { tipo: "servicio_antiguo", servicioId, meses: Number(meses) || 6 };
    return { tipo: "todos" };
  }

  const previsualizar = useMutation({
    mutationFn: () => previsualizarSegmento(filtroActual()),
    onSuccess: (r) => setPreview(r),
    onError: (e) => flash(e instanceof Error ? e.message : "No se pudo previsualizar el segmento"),
  });

  const crear = useMutation({
    mutationFn: () => {
      const filtro = filtroActual();
      return crearCampania({
        nombre: nombre.trim(),
        mensaje: mensaje.trim(),
        segmentoTipo: filtro.tipo,
        dias: filtro.dias,
        servicioId: filtro.servicioId,
        meses: filtro.meses,
      });
    },
    onSuccess: () => {
      invalidarLista();
      setNombre("");
      setMensaje("");
      setSegmentoTipo("todos");
      setPreview(null);
      flash("Campaña creada como borrador");
    },
    onError: (e) => flash(e instanceof Error ? e.message : "No se pudo crear la campaña"),
  });

  function alCrear() {
    if (!nombre.trim() || nombre.trim().length > 80) {
      flash("Nombre inválido (1 a 80 caracteres)");
      return;
    }
    if (!mensaje.trim() || mensaje.trim().length > 300) {
      flash("Mensaje inválido (1 a 300 caracteres)");
      return;
    }
    if (segmentoTipo === "servicio_antiguo" && !servicioId) {
      flash("Elegí un servicio para este segmento");
      return;
    }
    crear.mutate();
  }

  const campanias = q.data ?? [];
  const servicios = config.data?.servicios ?? [];

  if (q.isLoading) {
    return (
      <div id="campanias">
        <div className="dash-body">
          <p className="dash-vacio">Cargando…</p>
        </div>
      </div>
    );
  }
  if (q.isError) {
    return (
      <div id="campanias">
        <div className="dash-body">
          <p className="dash-vacio">No se pudieron cargar las campañas.</p>
        </div>
      </div>
    );
  }

  return (
    <div id="campanias">
      <div className="dash-body">
        <div className="dash-titulo">
          <h2>Campañas</h2>
        </div>

        <div className="card">
          <h3>Historial ({campanias.length})</h3>
          {campanias.length === 0 ? (
            <div className="admin-vacio">Todavía no armaste ninguna campaña.</div>
          ) : (
            <div className="admin-tabla-scroll">
              <table className="admin-tabla">
                <thead>
                  <tr>
                    <th>Nombre</th>
                    <th>Estado</th>
                    <th>Destinatarios</th>
                    <th>Creada</th>
                    <th>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {campanias.map((c) => (
                    <tr key={c.id}>
                      <td>{c.nombre}</td>
                      <td>
                        <BadgeEstado estado={c.estado} />
                      </td>
                      <td>{c.totalDestinatarios || "—"}</td>
                      <td>{fechaCorta(c.creadaEn)}</td>
                      <td>
                        <button type="button" className="btn-ghost" onClick={() => setSeleccionadaId(c.id)}>
                          Ver detalle
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card admin-form">
          <h3>Nueva campaña</h3>
          <div className="campo">
            <label htmlFor="campNombre">Nombre (interno, no lo ve el cliente)</label>
            <input id="campNombre" value={nombre} onChange={(e) => setNombre(e.target.value)} maxLength={80} />
          </div>
          <div className="campo">
            <label htmlFor="campMensaje">Mensaje ({mensaje.length}/300)</label>
            <textarea
              id="campMensaje"
              value={mensaje}
              onChange={(e) => setMensaje(e.target.value)}
              rows={3}
              maxLength={300}
              placeholder='Ej: "Tenemos 20% de descuento en pulido de parabrisas esta semana."'
            />
            <p className="campo-ayuda">
              Se manda como {'"'}{'{{1}}'} nombre del cliente, {'{{2}}'} este mensaje{'"'} dentro de la plantilla de
              marketing aprobada (configurada en "Mi negocio").
            </p>
          </div>

          <div className="admin-servicio">
            <select
              title="Tipo de segmento"
              value={segmentoTipo}
              onChange={(e) => { setSegmentoTipo(e.target.value as SegmentoFiltro["tipo"]); setPreview(null); }}
            >
              <option value="todos">Todos los clientes</option>
              <option value="inactivos">Inactivos hace N+ días</option>
              <option value="servicio_antiguo">Se hicieron un servicio hace N+ meses</option>
            </select>
            {segmentoTipo === "inactivos" && (
              <input
                inputMode="numeric"
                placeholder="días"
                value={dias}
                onChange={(e) => { setDias(e.target.value); setPreview(null); }}
              />
            )}
            {segmentoTipo === "servicio_antiguo" && (
              <>
                <select
                  title="Servicio"
                  value={servicioId}
                  onChange={(e) => { setServicioId(e.target.value); setPreview(null); }}
                >
                  <option value="">Elegí un servicio…</option>
                  {servicios.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.nombre}
                    </option>
                  ))}
                </select>
                <input
                  inputMode="numeric"
                  placeholder="meses"
                  value={meses}
                  onChange={(e) => { setMeses(e.target.value); setPreview(null); }}
                />
              </>
            )}
            <button type="button" className="btn-ghost" disabled={previsualizar.isPending} onClick={() => previsualizar.mutate()}>
              {previsualizar.isPending ? "Calculando…" : "Previsualizar"}
            </button>
          </div>
          {preview && (
            <p className="campo-ayuda">
              {preview.total === 0
                ? "Ningún cliente califica para este segmento todavía."
                : `Este segmento tiene ${preview.total} cliente${preview.total === 1 ? "" : "s"}.`}
            </p>
          )}

          <button type="button" className="accion accion-primaria" disabled={crear.isPending} onClick={alCrear}>
            {crear.isPending ? "Creando…" : "Crear como borrador"}
          </button>
        </div>
      </div>

      {seleccionadaId && (
        <DetalleCampania
          id={seleccionadaId}
          onCerrar={() => setSeleccionadaId(null)}
          onCambio={invalidarLista}
        />
      )}
    </div>
  );
}

function DetalleCampania({ id, onCerrar, onCambio }: { id: string; onCerrar: () => void; onCambio: () => void }) {
  const { flash } = useToast();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["campania", id],
    queryFn: () => obtenerCampania(id),
    refetchInterval: (query) => {
      const estado = query.state.data?.estado;
      return estado === "programada" || estado === "enviando" ? 3000 : false;
    },
  });

  const [programar, setProgramar] = useState(false);
  const [fechaHora, setFechaHora] = useState("");

  const refrescar = () => {
    qc.invalidateQueries({ queryKey: ["campania", id] });
    onCambio();
  };

  const enviar = useMutation({
    mutationFn: () => enviarCampania(id, programar && fechaHora ? new Date(fechaHora).toISOString() : null),
    onSuccess: () => {
      refrescar();
      flash(programar ? "Campaña programada" : "Envío en curso");
    },
    onError: (e) => flash(e instanceof Error ? e.message : "No se pudo confirmar el envío"),
  });

  const cancelar = useMutation({
    mutationFn: () => cancelarCampania(id),
    onSuccess: () => {
      refrescar();
      flash("Campaña cancelada");
    },
    onError: (e) => flash(e instanceof Error ? e.message : "No se pudo cancelar la campaña"),
  });

  const c = q.data;

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCerrar();
      }}
    >
      <div className="ficha-modal agenda-modal">
        <div className="ficha-head">
          <h3>{c?.nombre ?? "Campaña"}</h3>
          <button type="button" onClick={onCerrar} title="Cerrar">
            ✕
          </button>
        </div>

        {q.isLoading && <p className="dash-vacio">Cargando…</p>}
        {q.isError && <p className="dash-vacio">No se pudo cargar la campaña.</p>}

        {c && (
          <div className="ficha-body">
            <p>
              <BadgeEstado estado={c.estado} /> · {c.mensaje}
            </p>

            <div className="admin-grid">
              <div>Destinatarios: {c.metricas.destinatarios}</div>
              <div>Enviados: {c.metricas.enviados}</div>
              <div>Fallidos: {c.metricas.fallidos}</div>
              <div>Omitidos por baja: {c.metricas.omitidosOptOut}</div>
              <div>Respuestas: {c.metricas.respuestas}</div>
              <div>Citas generadas: {c.metricas.citasGeneradas}</div>
            </div>

            {c.estado === "borrador" && (
              <div className="card admin-form">
                <h3>Confirmar envío</h3>
                <label className="admin-check">
                  <input type="checkbox" checked={programar} onChange={(e) => setProgramar(e.target.checked)} /> Programar para más tarde
                </label>
                {programar && (
                  <div className="campo">
                    <label htmlFor="campFechaEnvio">Fecha y hora</label>
                    <input
                      id="campFechaEnvio"
                      type="datetime-local"
                      value={fechaHora}
                      onChange={(e) => setFechaHora(e.target.value)}
                    />
                  </div>
                )}
                <button
                  type="button"
                  className="accion accion-primaria"
                  disabled={enviar.isPending || (programar && !fechaHora)}
                  onClick={() => enviar.mutate()}
                >
                  {enviar.isPending ? "Confirmando…" : programar ? "Programar envío" : "Enviar ahora"}
                </button>
              </div>
            )}

            {(c.estado === "borrador" || c.estado === "programada" || c.estado === "enviando") && (
              <button type="button" className="btn-ghost" disabled={cancelar.isPending} onClick={() => cancelar.mutate()}>
                Cancelar campaña
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
