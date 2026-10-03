import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  asignarCitaPanel,
  cancelarCitaPanel,
  completarCitaPanel,
  confirmarCitaPanel,
  crearCitaManual,
  disponibilidadCita,
  listarCitasRango,
  marcarNoShowPanel,
  reprogramarCitaPanel,
  type CitaAgenda,
  type Empleado,
  type Service,
} from "../api";
import { fmtNum, monto } from "../lib/formato";
import ErrorState from "./ErrorState";
import EstadoVacio from "./EstadoVacio";
import Icono from "./Iconos";
import { useToast } from "./Toast";

type Vista = "dia" | "semana";
type EstadoVisual = "confirmada" | "pendiente" | "riesgo" | "completada" | "cancelada" | "no_show";

const DIAS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const PX_HORA = 64;
const HORA_MIN_DEFAULT = 7;
const HORA_MAX_DEFAULT = 18;

const ETIQUETA_ESTADO: Record<string, string> = {
  completada: "Completada",
  cancelada: "Cancelada",
  no_show: "No-show",
};

function hoyISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Suma (o resta) días a una fecha "YYYY-MM-DD", sin depender de horas/zona. */
function sumarDias(fecha: string, n: number): string {
  const d = new Date(`${fecha}T12:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Domingo de la semana que contiene `fecha` (domingo..sábado, igual que Tenant.horario). */
function inicioSemana(fecha: string): string {
  const dow = new Date(`${fecha}T12:00:00`).getDay();
  return sumarDias(fecha, -dow);
}

function etiquetaDia(fecha: string): string {
  const d = new Date(`${fecha}T12:00:00`);
  return `${DIAS[d.getDay()]} ${d.getDate()}`;
}

/** "HH:mm" → horas decimales (ej. "14:30" → 14.5), para posicionar bloques en el timeline. */
function horaDecimal(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h + m / 60;
}

/** "HH:mm" + minutos → "HH:mm" (sin cruzar más de un día, no hace falta para un horario de negocio). */
function sumarMinutos(hhmm: string, minutos: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + minutos;
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** "HH:mm" (24h) → "H a.m./p.m." o "H:mm a.m./p.m." para el copy del resumen. */
function hora12(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const ampm = h < 12 ? "a.m." : "p.m.";
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

/** Ídem, para un número de hora entero (etiquetas del gutter del timeline). */
function etiquetaHoraEntera(h: number): string {
  return hora12(`${String(h % 24).padStart(2, "0")}:00`);
}

function duracionCita(cita: CitaAgenda, servicios: Service[]): number {
  return servicios.find((s) => s.id === cita.servicioId)?.duracionMin ?? 60;
}

/**
 * Deriva el estado visual de una cita activa (Confirmada/Pendiente/Sin confirmar·riesgo)
 * a partir de los campos que ya existen — el schema no tiene un estado explícito para
 * esto (ver design_handoff_panel_whatsapp/). "Riesgo" = ya se le mandó el recordatorio
 * del mismo día y todavía no confirmó.
 */
function estadoVisual(cita: CitaAgenda): { tipo: EstadoVisual; etiqueta: string } {
  if (cita.estado !== "agendada") {
    return { tipo: cita.estado, etiqueta: ETIQUETA_ESTADO[cita.estado] ?? cita.estado };
  }
  if (cita.confirmadaEn) return { tipo: "confirmada", etiqueta: "Confirmada" };
  if (cita.recordatorioMismoDiaEn) return { tipo: "riesgo", etiqueta: "Sin confirmar" };
  return { tipo: "pendiente", etiqueta: "Pendiente" };
}

/**
 * Carriles de la vista día (ALTO-07): una columna por persona que atiende, más una
 * "Sin asignar" si hay citas sueltas ese día. Sin equipo cargado devuelve UN carril
 * anónimo, y así el timeline queda pixel por pixel como era antes.
 *
 * Hace falta de verdad: los bloques se posicionan en absoluto solo por `top`/`height`,
 * así que dos citas a la misma hora se dibujaban una ENCIMA de la otra.
 */
function carrilesDelDia(empleados: Empleado[], citasDia: CitaAgenda[]): { id: string; nombre: string }[] {
  if (empleados.length === 0) return [{ id: "", nombre: "" }];
  const activos = empleados.filter((e) => e.activo);
  // Alguien inactivo con citas ese día igual necesita su carril, o sus citas
  // desaparecerían de la vista.
  const conCitas = empleados.filter((e) => !e.activo && citasDia.some((c) => c.empleadoId === e.id));
  const carriles = [...activos, ...conCitas].map((e) => ({ id: e.id, nombre: e.nombre }));
  if (citasDia.some((c) => !c.empleadoId)) carriles.push({ id: "", nombre: "Sin asignar" });
  return carriles.length > 0 ? carriles : [{ id: "", nombre: "" }];
}

interface Props {
  servicios: Service[];
  empleados: Empleado[];
  /** Moneda del negocio (E11) para los montos; undefined = colones (backend viejo). */
  moneda?: string;
}

export default function Agenda({ servicios, empleados, moneda }: Props) {
  const qc = useQueryClient();
  const { flash } = useToast();
  const [vista, setVista] = useState<Vista>("dia");
  const [fechaBase, setFechaBase] = useState(hoyISO());
  const [modal, setModal] = useState<null | { cita?: CitaAgenda }>(null);
  const [detalle, setDetalle] = useState<CitaAgenda | null>(null);
  const [resaltada, setResaltada] = useState<string | null>(null);

  const desde = vista === "dia" ? fechaBase : inicioSemana(fechaBase);
  const hasta = vista === "dia" ? fechaBase : sumarDias(desde, 6);

  const q = useQuery({
    queryKey: ["citas", desde, hasta],
    queryFn: () => listarCitasRango(desde, hasta),
    refetchInterval: 15000,
  });
  const citas = q.data ?? [];
  const citasDia = useMemo(() => [...citas].sort((a, b) => a.hora.localeCompare(b.hora)), [citas]);

  function invalidar() {
    qc.invalidateQueries({ queryKey: ["citas"] });
  }

  const errorGenerico = (e: unknown) => flash(e instanceof Error ? e.message : "No se pudo actualizar la cita");

  const confirmar = useMutation({
    mutationFn: confirmarCitaPanel,
    onSuccess: () => {
      invalidar();
      flash("Cita confirmada");
    },
    onError: errorGenerico,
  });
  const completar = useMutation({
    mutationFn: completarCitaPanel,
    onSuccess: () => {
      invalidar();
      flash("Cita marcada como completada");
    },
    onError: errorGenerico,
  });
  const cancelar = useMutation({
    mutationFn: cancelarCitaPanel,
    onSuccess: () => {
      invalidar();
      flash("Cita cancelada");
    },
    onError: errorGenerico,
  });
  const noShow = useMutation({
    mutationFn: marcarNoShowPanel,
    onSuccess: () => {
      invalidar();
      flash("Cita marcada como no-show");
    },
    onError: errorGenerico,
  });
  // Reasignar a otra persona (ALTO-07). El backend devuelve 409 si esa persona ya tiene
  // una cita encimada; `errorGenerico` muestra ese mensaje tal cual.
  const asignar = useMutation({
    mutationFn: ({ id, empleadoId }: { id: string; empleadoId: string }) => asignarCitaPanel(id, empleadoId),
    onSuccess: () => {
      invalidar();
      flash("Cita reasignada");
    },
    onError: errorGenerico,
  });
  const pendiente =
    confirmar.isPending || completar.isPending || cancelar.isPending || noShow.isPending || asignar.isPending;

  function mover(saltos: number) {
    setFechaBase((f) => sumarDias(f, vista === "dia" ? saltos : saltos * 7));
  }

  function irACita(id: string) {
    setResaltada(id);
    document.getElementById(`cita-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    document.getElementById(`cita-m-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => setResaltada((r) => (r === id ? null : r)), 1600);
  }

  const diasSemana = vista === "semana" ? Array.from({ length: 7 }, (_, i) => sumarDias(desde, i)) : [];

  // ── Cálculos del timeline (vista día) ──────────────────────────────────────
  let horaInicio = HORA_MIN_DEFAULT;
  let horaFin = HORA_MAX_DEFAULT;
  for (const c of citasDia) {
    const hd = horaDecimal(c.hora);
    const durH = duracionCita(c, servicios) / 60;
    horaInicio = Math.min(horaInicio, Math.floor(hd));
    horaFin = Math.max(horaFin, Math.ceil(hd + durH));
  }
  const filasHora = Array.from({ length: horaFin - horaInicio }, (_, i) => horaInicio + i);

  const carriles = carrilesDelDia(empleados, citasDia);
  const anchoCarril = 100 / carriles.length;

  const citasActivas = citasDia.filter((c) => c.estado !== "cancelada");
  const ingresoEstimado = citasDia
    .filter((c) => c.estado === "agendada" || c.estado === "completada")
    .reduce((s, c) => s + (c.precio ?? 0) + (c.addons ?? []).reduce((s2, a) => s2 + a.precio, 0), 0);
  const enRiesgo = citasDia.filter((c) => estadoVisual(c).tipo === "riesgo");
  const masUrgente = enRiesgo[0];

  return (
    <div id="agenda">
      <div className="dash-body">
        <div className="dash-titulo">
          <h2>Agenda</h2>
        </div>

        <div className="agenda-toolbar">
          <div className="agenda-vista-toggle">
            <button
              type="button"
              className={"filtro-pill" + (vista === "dia" ? " activo" : "")}
              onClick={() => setVista("dia")}
            >
              Día
            </button>
            <button
              type="button"
              className={"filtro-pill" + (vista === "semana" ? " activo" : "")}
              onClick={() => setVista("semana")}
            >
              Semana
            </button>
          </div>

          <div className="agenda-nav">
            <button type="button" className="btn-ghost" onClick={() => mover(-1)} aria-label="Anterior">
              ‹
            </button>
            <button type="button" className="btn-ghost" onClick={() => setFechaBase(hoyISO())}>
              Hoy
            </button>
            <button type="button" className="btn-ghost" onClick={() => mover(1)} aria-label="Siguiente">
              ›
            </button>
            <span className="agenda-nav-fecha">
              {vista === "dia" ? etiquetaDia(fechaBase) : `${etiquetaDia(desde)} – ${etiquetaDia(hasta)}`}
            </span>
          </div>

          <button type="button" className="accion accion-primaria" onClick={() => setModal({})}>
            <Icono id="cal" size={14} />
            Nueva cita
          </button>
        </div>

        {q.isError && (
          <div className="card">
            <ErrorState mensaje="No se pudieron cargar las citas." onReintentar={() => q.refetch()} />
          </div>
        )}

        {!q.isError && vista === "dia" && citasDia.length === 0 && (
          <div className="card">
            <EstadoVacio
              icono="cal"
              titulo="Sin citas para este día"
              ayuda="Las citas que agende el bot o que crees a mano van a aparecer acá."
              accion={{ texto: "Agendá la primera", icono: "plus", onClick: () => setModal({}) }}
            />
          </div>
        )}

        {!q.isError && vista === "dia" && citasDia.length > 0 && (
          <div className="agenda-grid">
            <div className="card agenda-timeline-card">
              <h3>
                Citas del día · {citasDia.length} {citasDia.length === 1 ? "cita" : "citas"} ·{" "}
                {hora12(citasDia[0].hora)} –{" "}
                {hora12(sumarMinutos(citasDia[citasDia.length - 1].hora, duracionCita(citasDia[citasDia.length - 1], servicios)))}
              </h3>
              {/* Encabezado de carriles: solo si el negocio tiene equipo (ALTO-07). */}
              {carriles.length > 1 && (
                <div className="agenda-carriles-head">
                  {carriles.map((c) => (
                    <span key={c.id || "sin"} className="agenda-carril-nombre" style={{ width: `${anchoCarril}%` }}>
                      {c.nombre}
                    </span>
                  ))}
                </div>
              )}
              <div className="agenda-timeline" style={{ height: (horaFin - horaInicio) * PX_HORA }}>
                <div className="agenda-timeline-filas">
                  {filasHora.map((h) => (
                    <div key={h} className="agenda-timeline-fila" style={{ height: PX_HORA }}>
                      <span className="agenda-timeline-hora-label">{etiquetaHoraEntera(h)}</span>
                    </div>
                  ))}
                </div>
                <div className="agenda-timeline-bloques">
                  {citasDia.map((c) => {
                    const dur = duracionCita(c, servicios);
                    const top = (horaDecimal(c.hora) - horaInicio) * PX_HORA;
                    const height = Math.max((dur / 60) * PX_HORA, 30);
                    const ev = estadoVisual(c);
                    // Carril de esta cita. Con UN solo carril no se tocan left/width: el
                    // bloque queda con el `left:6px; right:6px` del CSS, o sea idéntico a
                    // como se veía antes de los carriles. Con varios se pasa a left+width
                    // (y `right:auto` vía clase, o quedaría sobre-restringido).
                    const idx = Math.max(
                      0,
                      carriles.findIndex((k) => k.id === (c.empleadoId ?? "")),
                    );
                    const pos =
                      carriles.length > 1
                        ? { left: `calc(${idx * anchoCarril}% + 6px)`, width: `calc(${anchoCarril}% - 12px)` }
                        : {};
                    return (
                      <button
                        type="button"
                        key={c.id}
                        id={`cita-${c.id}`}
                        className={
                          `agenda-bloque agenda-bloque-${ev.tipo}` +
                          (carriles.length > 1 ? " agenda-bloque-carril" : "") +
                          (resaltada === c.id ? " agenda-bloque-resaltado" : "")
                        }
                        style={{ top, height, ...pos }}
                        onClick={() => setDetalle(c)}
                      >
                        <span className="agenda-bloque-top">
                          <b className="tnum">{c.hora}</b>
                          <span className="agenda-bloque-nombre">{c.clienteNombre}</span>
                        </span>
                        <span className="agenda-bloque-detalle">
                          {c.servicioNombre}
                          {c.placa ? ` · ${c.placa}` : ""}
                        </span>
                        <span className={`pill-cita-estado pill-cita-estado-${ev.tipo}`}>{ev.etiqueta}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="agenda-resumen">
              <div className="card agenda-resumen-card">
                <div className="agenda-resumen-fila">
                  <span>Citas</span>
                  <b className="tnum">{citasActivas.length}</b>
                </div>
                <div className="agenda-resumen-fila">
                  <span>Ingreso estimado</span>
                  <b className="tnum agenda-resumen-monto">{monto(ingresoEstimado, moneda)}</b>
                </div>
                <div className="agenda-resumen-fila">
                  <span>Sin confirmar</span>
                  {enRiesgo.length > 0 ? (
                    <span className="chip-alerta">{enRiesgo.length} en riesgo</span>
                  ) : (
                    <b className="tnum">0</b>
                  )}
                </div>
              </div>

              {masUrgente && (
                <div className="agenda-aviso-riesgo">
                  <Icono id="alert" size={16} />
                  <div>
                    <p>
                      <b>{masUrgente.clienteNombre}</b> no confirmó las {hora12(masUrgente.hora)}.
                    </p>
                    <button type="button" className="agenda-aviso-link" onClick={() => irACita(masUrgente.id)}>
                      Ver en la agenda →
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="agenda-lista-movil">
              {citasDia.map((c) => {
                const ev = estadoVisual(c);
                return (
                  <button
                    type="button"
                    key={c.id}
                    id={`cita-m-${c.id}`}
                    className={"agenda-fila-movil" + (resaltada === c.id ? " agenda-bloque-resaltado" : "")}
                    onClick={() => setDetalle(c)}
                  >
                    <span className="agenda-fila-movil-hora tnum">{c.hora}</span>
                    <span className={`agenda-fila-movil-card agenda-bloque-${ev.tipo}`}>
                      <span className="agenda-fila-movil-nombre">{c.clienteNombre}</span>
                      <span className="agenda-fila-movil-detalle">
                        {c.servicioNombre}
                        {c.placa ? ` · ${c.placa}` : ""}
                      </span>
                      <span className={`pill-cita-estado pill-cita-estado-${ev.tipo}`}>{ev.etiqueta}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {!q.isError && vista === "semana" && (
          <div className="agenda-semana">
            {diasSemana.map((f) => {
              const delDia = citas.filter((c) => c.fecha === f).sort((a, b) => a.hora.localeCompare(b.hora));
              return (
                <div key={f} className={"agenda-dia-col" + (f === hoyISO() ? " hoy" : "")}>
                  <h4>{etiquetaDia(f)}</h4>
                  {delDia.length === 0 && <p className="agenda-dia-vacio">—</p>}
                  {delDia.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={"agenda-chip" + (c.estado !== "agendada" ? ` ${c.estado}` : "")}
                      onClick={() => {
                        setVista("dia");
                        setFechaBase(f);
                      }}
                      title={`${c.hora} · ${c.clienteNombre} · ${c.servicioNombre}`}
                    >
                      {c.hora} {c.clienteNombre}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {detalle && (
        <ModalDetalleCita
          cita={detalle}
          moneda={moneda}
          servicios={servicios}
          empleados={empleados}
          pendiente={pendiente}
          onAsignar={(empleadoId) => {
            asignar.mutate({ id: detalle.id, empleadoId });
            setDetalle(null);
          }}
          onCerrar={() => setDetalle(null)}
          onConfirmar={() => {
            confirmar.mutate(detalle.id);
            setDetalle(null);
          }}
          onCompletar={() => {
            completar.mutate(detalle.id);
            setDetalle(null);
          }}
          onCancelar={() => {
            cancelar.mutate(detalle.id);
            setDetalle(null);
          }}
          onNoShow={() => {
            noShow.mutate(detalle.id);
            setDetalle(null);
          }}
          onReprogramar={() => {
            setModal({ cita: detalle });
            setDetalle(null);
          }}
        />
      )}

      {modal && (
        <ModalCita
          servicios={servicios}
          empleados={empleados}
          cita={modal.cita}
          onCerrar={() => setModal(null)}
          onGuardado={(msg) => {
            invalidar();
            flash(msg);
            setModal(null);
          }}
        />
      )}
    </div>
  );
}

// ── Modal de detalle de una cita (ver + accionar) ───────────────────────────

interface DetalleProps {
  cita: CitaAgenda;
  moneda?: string;
  servicios: Service[];
  empleados: Empleado[];
  pendiente: boolean;
  onCerrar: () => void;
  onConfirmar: () => void;
  onCompletar: () => void;
  onCancelar: () => void;
  onNoShow: () => void;
  onReprogramar: () => void;
  onAsignar: (empleadoId: string) => void;
}

function ModalDetalleCita({
  cita,
  moneda,
  servicios,
  empleados,
  pendiente,
  onCerrar,
  onConfirmar,
  onCompletar,
  onCancelar,
  onNoShow,
  onReprogramar,
  onAsignar,
}: DetalleProps) {
  const activa = cita.estado === "agendada";
  const ev = estadoVisual(cita);
  const addons = cita.addons ?? [];
  const total = (cita.precio ?? 0) + addons.reduce((s, a) => s + a.precio, 0);

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCerrar();
      }}
    >
      <div className="ficha-modal">
        <div className="ficha-head">
          <h3>{cita.clienteNombre}</h3>
          <button type="button" onClick={onCerrar} title="Cerrar">
            ✕
          </button>
        </div>
        <div className="ficha-body">
          <span className={`pill-cita-estado pill-cita-estado-${ev.tipo}`}>{ev.etiqueta}</span>

          <div className="dato">
            <span>Hora</span>
            <b className="tnum">{cita.hora}</b>
          </div>
          <div className="dato">
            <span>Teléfono</span>
            <b className="tnum">{fmtNum(cita.clienteWa)}</b>
          </div>
          <div className="dato">
            <span>Servicio</span>
            <b>{cita.servicioNombre}</b>
          </div>
          {/* Quién atiende (ALTO-07). Editable mientras la cita esté activa: reasignar es
              la salida cuando alguien falta o hay que balancear la carga del día. */}
          {empleados.length > 0 && (
            <div className="dato">
              <span>Quién atiende</span>
              {activa ? (
                <select
                  aria-label="Quién atiende"
                  className="dato-select"
                  value={cita.empleadoId ?? ""}
                  disabled={pendiente}
                  onChange={(e) => onAsignar(e.target.value)}
                >
                  <option value="">Sin asignar</option>
                  {empleados
                    // Un inactivo solo aparece si ES el asignado actual: se puede sacar de
                    // ahí, pero no se le puede asignar trabajo nuevo.
                    .filter((e) => e.activo || e.id === cita.empleadoId)
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.nombre}
                        {e.activo ? "" : " (inactivo)"}
                      </option>
                    ))}
                </select>
              ) : (
                <b>{empleados.find((e) => e.id === cita.empleadoId)?.nombre ?? "Sin asignar"}</b>
              )}
            </div>
          )}
          {cita.placa && (
            <div className="dato">
              <span>Referencia</span>
              <b className="tnum">{cita.placa}</b>
            </div>
          )}
          {(cita.precio != null || addons.length > 0) && (
            <div className="dato">
              <span>Total</span>
              <b className="tnum">
                {monto(total, moneda)}
                {addons.length > 0 &&
                  ` (incluye ${addons
                    .map((a) => servicios.find((s) => s.id === a.servicioId)?.nombre ?? a.servicioId)
                    .join(", ")})`}
              </b>
            </div>
          )}

          {activa && (
            <div className="agenda-detalle-acciones">
              {!cita.confirmadaEn && (
                <button type="button" className="accion accion-outline accion-check" disabled={pendiente} onClick={onConfirmar}>
                  Confirmar
                </button>
              )}
              <button type="button" className="accion accion-outline" disabled={pendiente} onClick={onReprogramar}>
                Reprogramar
              </button>
              <button type="button" className="accion accion-outline accion-check" disabled={pendiente} onClick={onCompletar}>
                Completar
              </button>
              <button type="button" className="accion accion-outline accion-alerta" disabled={pendiente} onClick={onNoShow}>
                No se presentó
              </button>
              <button type="button" className="accion accion-outline" disabled={pendiente} onClick={onCancelar}>
                Cancelar
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Modal: cita nueva / reprogramar ─────────────────────────────────────────

interface ModalProps {
  servicios: Service[];
  empleados: Empleado[];
  cita?: CitaAgenda;
  onCerrar: () => void;
  onGuardado: (mensaje: string) => void;
}

function ModalCita({ servicios, empleados, cita, onCerrar, onGuardado }: ModalProps) {
  const { flash } = useToast();
  const modoReprogramar = !!cita;

  const [clienteNombre, setClienteNombre] = useState(cita?.clienteNombre ?? "");
  const [clienteWa, setClienteWa] = useState(cita?.clienteWa ?? "");
  const [servicioId, setServicioId] = useState(cita?.servicioId ?? servicios[0]?.id ?? "");
  const [fecha, setFecha] = useState(cita?.fecha ?? hoyISO());
  const [hora, setHora] = useState(cita?.hora ?? "");
  const [placa, setPlaca] = useState(cita?.placa ?? "");
  const [precio, setPrecio] = useState(cita?.precio != null ? String(cita.precio) : "");
  // "" = sin asignar. Al reprogramar no se toca: mover una cita no es cambiar de
  // profesional (para eso está "Reasignar" en el detalle).
  const [empleadoId, setEmpleadoId] = useState("");

  // Al elegir un servicio nuevo (solo en alta), precargar su precio si es fijo.
  useEffect(() => {
    if (modoReprogramar) return;
    const s = servicios.find((x) => x.id === servicioId);
    if (s && !s.precioVariable && s.precio != null) setPrecio(String(s.precio));
  }, [servicioId, modoReprogramar, servicios]);

  const disp = useQuery({
    queryKey: ["disponibilidad", fecha, servicioId],
    queryFn: () => disponibilidadCita(fecha, servicioId),
    enabled: !!fecha && !!servicioId,
  });

  // Al reprogramar, la cita ocupa su propio slot: si no se excluye, el backend
  // la devuelve como "ocupada" y el operador ve su propia cita como un choque.
  // Si sigue en la misma fecha, tampoco vendrá en "libres" (el backend no sabe
  // que se está liberando) — se agrega a mano para que quede seleccionable.
  const empleadosActivos = empleados.filter((e) => e.activo);
  const horasOcupadas = (disp.data?.ocupadas ?? []).filter((o) => o.citaId !== cita?.id);
  const horaPropiaDisponible = modoReprogramar && cita && cita.fecha === fecha ? [cita.hora] : [];
  const horas = Array.from(
    new Set([...(disp.data?.libres ?? []), ...horasOcupadas.map((o) => o.hora), ...horaPropiaDisponible]),
  ).sort();
  const ocupadaElegida = horasOcupadas.find((o) => o.hora === hora);

  const guardar = useMutation({
    mutationFn: async () => {
      if (modoReprogramar) {
        await reprogramarCitaPanel(cita!.id, fecha, hora);
      } else {
        await crearCitaManual({
          clienteNombre: clienteNombre.trim(),
          clienteWa: clienteWa.trim(),
          servicioId,
          fecha,
          hora,
          empleadoId: empleadoId || undefined,
          placa: placa.trim() || undefined,
          precio: precio ? Number(precio) : undefined,
        });
      }
    },
    onSuccess: () => onGuardado(modoReprogramar ? "Cita reprogramada" : "Cita creada"),
    onError: (e) => flash(e instanceof Error ? e.message : "No se pudo guardar la cita"),
  });

  const listo = modoReprogramar
    ? !!fecha && !!hora
    : !!clienteNombre.trim() && !!clienteWa.trim() && !!servicioId && !!fecha && !!hora;

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCerrar();
      }}
    >
      <div className="ficha-modal agenda-modal" id="agendaForm">
        <div className="ficha-head">
          <h3>{modoReprogramar ? "Reprogramar cita" : "Nueva cita"}</h3>
          <button type="button" onClick={onCerrar} title="Cerrar">
            ✕
          </button>
        </div>
        <div className="ficha-body">
          {!modoReprogramar && (
            <>
              <label htmlFor="aCliente">Nombre del cliente</label>
              <input
                id="aCliente"
                value={clienteNombre}
                onChange={(e) => setClienteNombre(e.target.value)}
                placeholder="Ej: Juan Pérez"
              />

              <label htmlFor="aTelefono">Teléfono de WhatsApp (con código de país, sin +)</label>
              <input
                id="aTelefono"
                value={clienteWa}
                onChange={(e) => setClienteWa(e.target.value.replace(/\D/g, ""))}
                placeholder="Ej: 50688887777"
                inputMode="numeric"
              />

              <label htmlFor="aServicio">Servicio</label>
              <select
                id="aServicio"
                value={servicioId}
                onChange={(e) => { setServicioId(e.target.value); setHora(""); }}
              >
                {servicios.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.nombre}
                  </option>
                ))}
              </select>
            </>
          )}

          <label htmlFor="aFecha">Fecha</label>
          <input
            id="aFecha"
            type="date"
            min={hoyISO()}
            value={fecha}
            onChange={(e) => { setFecha(e.target.value); setHora(""); }}
          />

          <label htmlFor="aHora">Hora</label>
          <select id="aHora" value={hora} onChange={(e) => setHora(e.target.value)} disabled={disp.isLoading}>
            <option value="">{disp.isLoading ? "Cargando horarios…" : "Elegí un horario…"}</option>
            {horas.map((h) => {
              const ocupada = horasOcupadas.find((o) => o.hora === h);
              return (
                <option key={h} value={h}>
                  {h}
                  {ocupada ? ` — ocupado (${ocupada.clienteNombre})` : ""}
                </option>
              );
            })}
          </select>
          {disp.isError && (
            <p className="agenda-advertencia">
              ⚠️ No se pudieron cargar los horarios: {disp.error instanceof Error ? disp.error.message : "error desconocido"}.
            </p>
          )}
          {!disp.isLoading && !disp.isError && horas.length === 0 && (
            <p className="agenda-advertencia">⚠️ No hay horarios disponibles para esa fecha y servicio.</p>
          )}
          {ocupadaElegida && (
            <p className="agenda-advertencia">
              ⚠️ Ese horario ya tiene una cita con {ocupadaElegida.clienteNombre}. Se puede guardar igual.
            </p>
          )}

          {/* Quién atiende (ALTO-07). Solo con equipo cargado; en el alta, no al
              reprogramar (mover una cita no es cambiarle el profesional). */}
          {!modoReprogramar && empleadosActivos.length > 0 && (
            <>
              <label htmlFor="aEmpleado">Quién atiende</label>
              <select id="aEmpleado" value={empleadoId} onChange={(e) => setEmpleadoId(e.target.value)}>
                <option value="">Sin asignar</option>
                {empleadosActivos.map((e) => {
                  // A diferencia del choque de horario del negocio (que se permite para
                  // walk-ins), a una persona ocupada no se le puede encimar una cita: el
                  // backend devuelve 409, así que la opción va deshabilitada.
                  const ocupado = hora ? !!horasOcupadas.find((o) => o.hora === hora && o.empleadoId === e.id) : false;
                  return (
                    <option key={e.id} value={e.id} disabled={ocupado}>
                      {e.nombre}
                      {ocupado ? " — ocupado a esa hora" : ""}
                    </option>
                  );
                })}
              </select>
            </>
          )}

          {!modoReprogramar && (
            <>
              <label htmlFor="aPlaca">Referencia (opcional)</label>
              <input id="aPlaca" value={placa} onChange={(e) => setPlaca(e.target.value)} placeholder="Ej: placa, expediente…" />

              <label htmlFor="aPrecio">Precio (opcional)</label>
              <input
                id="aPrecio"
                type="number"
                min={0}
                value={precio}
                onChange={(e) => setPrecio(e.target.value)}
                placeholder="Se cotiza"
              />
            </>
          )}

          <button
            type="button"
            className="accion accion-primaria agenda-boton-guardar"
            disabled={!listo || guardar.isPending}
            onClick={() => guardar.mutate()}
          >
            {ocupadaElegida ? "Guardar igual" : "Guardar"}
          </button>
        </div>
      </div>
    </div>
  );
}
