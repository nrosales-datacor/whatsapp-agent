import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cancelarCitaPanel,
  completarCitaPanel,
  confirmarCitaPanel,
  crearCitaManual,
  disponibilidadCita,
  listarCitasRango,
  marcarNoShowPanel,
  reprogramarCitaPanel,
  type CitaAgenda,
  type Service,
} from "../api";
import { colones, fmtNum } from "../lib/formato";
import ErrorState from "./ErrorState";
import Icono from "./Iconos";
import { useToast } from "./Toast";

type Vista = "dia" | "semana";

const DIAS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

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

interface Props {
  servicios: Service[];
}

export default function Agenda({ servicios }: Props) {
  const qc = useQueryClient();
  const { flash } = useToast();
  const [vista, setVista] = useState<Vista>("dia");
  const [fechaBase, setFechaBase] = useState(hoyISO());
  const [modal, setModal] = useState<null | { cita?: CitaAgenda }>(null);

  const desde = vista === "dia" ? fechaBase : inicioSemana(fechaBase);
  const hasta = vista === "dia" ? fechaBase : sumarDias(desde, 6);

  const q = useQuery({
    queryKey: ["citas", desde, hasta],
    queryFn: () => listarCitasRango(desde, hasta),
    refetchInterval: 15000,
  });
  const citas = q.data ?? [];

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
  const pendiente = confirmar.isPending || completar.isPending || cancelar.isPending || noShow.isPending;

  function mover(saltos: number) {
    setFechaBase((f) => sumarDias(f, vista === "dia" ? saltos : saltos * 7));
  }

  const diasSemana = vista === "semana" ? Array.from({ length: 7 }, (_, i) => sumarDias(desde, i)) : [];

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

        {!q.isError && vista === "dia" && (
          <div className="card">
            <h3>Citas del día</h3>
            {citas.length === 0 && <p className="dash-vacio">Sin citas para este día.</p>}
            <div className="agenda-lista">
              {citas.map((c) => (
                <FilaCita
                  key={c.id}
                  cita={c}
                  servicios={servicios}
                  pendiente={pendiente}
                  onConfirmar={() => confirmar.mutate(c.id)}
                  onCompletar={() => completar.mutate(c.id)}
                  onCancelar={() => cancelar.mutate(c.id)}
                  onNoShow={() => noShow.mutate(c.id)}
                  onReprogramar={() => setModal({ cita: c })}
                />
              ))}
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

      {modal && (
        <ModalCita
          servicios={servicios}
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

// ── Fila de cita (vista día) ────────────────────────────────────────────────

interface FilaProps {
  cita: CitaAgenda;
  servicios: Service[];
  pendiente: boolean;
  onConfirmar: () => void;
  onCompletar: () => void;
  onCancelar: () => void;
  onNoShow: () => void;
  onReprogramar: () => void;
}

const ETIQUETA_ESTADO: Record<string, string> = { no_show: "No-show" };

function FilaCita({ cita, servicios, pendiente, onConfirmar, onCompletar, onCancelar, onNoShow, onReprogramar }: FilaProps) {
  const activa = cita.estado === "agendada";
  // Upsell (Carril D, 1.2): total = base + add-ons aceptados. Solo se muestra si hay
  // algo que sumar (precio y/o add-ons); una cita sin ninguno no necesita esta línea.
  const addons = cita.addons ?? [];
  const total = (cita.precio ?? 0) + addons.reduce((s, a) => s + a.precio, 0);
  return (
    <div className="agenda-fila">
      <span className="agenda-hora">{cita.hora}</span>
      <div className="agenda-cliente">
        <b>{cita.clienteNombre}</b>
        <span>
          {fmtNum(cita.clienteWa)} · {cita.servicioNombre}
          {cita.placa ? ` · ${cita.placa}` : ""}
        </span>
        {(cita.precio != null || addons.length > 0) && (
          <span className="agenda-total">
            {colones(total)}
            {addons.length > 0 &&
              ` (incluye ${addons
                .map((a) => servicios.find((s) => s.id === a.servicioId)?.nombre ?? a.servicioId)
                .join(", ")})`}
          </span>
        )}
      </div>
      {cita.estado !== "agendada" && (
        <span className={"badge-estado " + cita.estado}>{ETIQUETA_ESTADO[cita.estado] ?? cita.estado}</span>
      )}
      {cita.confirmadaEn && <span className="pill-cita confirmada">✅ Confirmada</span>}
      {activa && (
        <div className="agenda-acciones">
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
  );
}

// ── Modal: cita nueva / reprogramar ─────────────────────────────────────────

interface ModalProps {
  servicios: Service[];
  cita?: CitaAgenda;
  onCerrar: () => void;
  onGuardado: (mensaje: string) => void;
}

function ModalCita({ servicios, cita, onCerrar, onGuardado }: ModalProps) {
  const { flash } = useToast();
  const modoReprogramar = !!cita;

  const [clienteNombre, setClienteNombre] = useState(cita?.clienteNombre ?? "");
  const [clienteWa, setClienteWa] = useState(cita?.clienteWa ?? "");
  const [servicioId, setServicioId] = useState(cita?.servicioId ?? servicios[0]?.id ?? "");
  const [fecha, setFecha] = useState(cita?.fecha ?? hoyISO());
  const [hora, setHora] = useState(cita?.hora ?? "");
  const [placa, setPlaca] = useState(cita?.placa ?? "");
  const [precio, setPrecio] = useState(cita?.precio != null ? String(cita.precio) : "");

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

          {!modoReprogramar && (
            <>
              <label htmlFor="aPlaca">Placa (opcional)</label>
              <input id="aPlaca" value={placa} onChange={(e) => setPlaca(e.target.value)} placeholder="Ej: CL-123456" />

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
