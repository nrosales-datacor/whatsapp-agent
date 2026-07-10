import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  obtenerConfig,
  guardarConfig,
  type Bloqueo,
  type ConfigNegocio,
  type HorarioDia,
  type KnowledgeBase,
  type Service,
} from "../api";
import { useToast } from "./Toast";

// ─────────────────────────────────────────────────────────────────────────────
// "Mi negocio" (ROADMAP C2.2): el dueño edita servicios/precios, horario, feriados
// y la base de conocimiento del bot en vivo, sin pasar por el superadmin. Reusa el
// mismo patrón de formulario del onboarding (FormularioNegocio.tsx), pero es un
// solo POST /api/panel/config que reemplaza los 4 bloques juntos.
// ─────────────────────────────────────────────────────────────────────────────

interface ServicioForm {
  id: string;
  nombre: string;
  precio: string;
  precioVariable: boolean;
  precioNota: string;
  duracionMin: string;
  agendable: boolean;
  descripcion: string;
}
interface FaqForm {
  pregunta: string;
  respuesta: string;
}
interface DiaForm {
  abierto: boolean;
  abre: string;
  cierra: string;
}
interface BloqueoForm {
  desde: string;
  hasta: string;
  motivo: string;
}

const DIAS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

const lineas = (s: string): string[] => s.split("\n").map((l) => l.trim()).filter(Boolean);

function serviciosAForm(servicios: Service[]): ServicioForm[] {
  return servicios.map((s) => ({
    id: s.id,
    nombre: s.nombre,
    precio: s.precio !== undefined ? String(s.precio) : "",
    precioVariable: !!s.precioVariable,
    precioNota: s.precioNota ?? "",
    duracionMin: String(s.duracionMin),
    agendable: !!s.agendable,
    descripcion: s.descripcion ?? "",
  }));
}

function horarioAForm(horario: Record<number, HorarioDia>): DiaForm[] {
  return Array.from({ length: 7 }, (_, d) => {
    const h = horario[d];
    const abierto = !!h && h.abre !== null && h.cierra !== null;
    return { abierto, abre: h?.abre ?? "06:00", cierra: h?.cierra ?? "18:00" };
  });
}

function bloqueosAForm(bloqueos: Bloqueo[]): BloqueoForm[] {
  return bloqueos.map((b) => ({ desde: b.desde, hasta: b.hasta, motivo: b.motivo ?? "" }));
}

export default function MiNegocio() {
  const qc = useQueryClient();
  const { flash } = useToast();
  const q = useQuery({ queryKey: ["config"], queryFn: obtenerConfig });

  const [cargado, setCargado] = useState(false);
  const [servicios, setServicios] = useState<ServicioForm[]>([]);
  const [horario, setHorario] = useState<DiaForm[]>([]);
  const [bloqueos, setBloqueos] = useState<BloqueoForm[]>([]);
  const [faqs, setFaqs] = useState<FaqForm[]>([]);
  const [datos, setDatos] = useState("");
  const [politicas, setPoliticas] = useState("");
  const [tarifas, setTarifas] = useState("");
  const [parabrisas, setParabrisas] = useState("");
  const [linkResenas, setLinkResenas] = useState("");
  const [plantillaMarketing, setPlantillaMarketing] = useState("");

  // Seedear el form UNA sola vez al llegar la config: un refetch de fondo no debe
  // pisar lo que el operador está escribiendo.
  useEffect(() => {
    if (!q.data || cargado) return;
    setServicios(serviciosAForm(q.data.servicios));
    setHorario(horarioAForm(q.data.horario));
    setBloqueos(bloqueosAForm(q.data.bloqueos));
    setFaqs(q.data.kb.faq.map((f) => ({ ...f })));
    setDatos((q.data.kb.datos ?? []).join("\n"));
    setPoliticas((q.data.kb.politicas ?? []).join("\n"));
    setTarifas((q.data.kb.tarifas ?? []).join("\n"));
    setParabrisas((q.data.kb.parabrisas ?? []).join("\n"));
    setLinkResenas(q.data.linkResenas ?? "");
    setPlantillaMarketing(q.data.plantillaMarketing ?? "");
    setCargado(true);
  }, [q.data, cargado]);

  const guardar = useMutation({
    mutationFn: (body: ConfigNegocio) => guardarConfig(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["config"] });
      qc.invalidateQueries({ queryKey: ["me"] });
      flash("Configuración guardada");
    },
    onError: (e) => flash(e instanceof Error ? e.message : "No se pudo guardar"),
  });

  const setServ = (i: number, campo: keyof ServicioForm, valor: string | boolean) =>
    setServicios((prev) => prev.map((s, idx) => (idx === i ? { ...s, [campo]: valor } : s)));

  const setDia = (i: number, campo: keyof DiaForm, valor: string | boolean) =>
    setHorario((prev) => prev.map((d, idx) => (idx === i ? { ...d, [campo]: valor } : d)));

  const setBloqueo = (i: number, campo: keyof BloqueoForm, valor: string) =>
    setBloqueos((prev) => prev.map((b, idx) => (idx === i ? { ...b, [campo]: valor } : b)));

  function construirServicios(): Service[] {
    return servicios
      .filter((s) => s.id.trim() && s.nombre.trim())
      .map((s) => {
        const serv: Service = { id: s.id.trim(), nombre: s.nombre.trim(), duracionMin: Number(s.duracionMin) || 60 };
        if (s.agendable) serv.agendable = true;
        if (s.precioVariable) serv.precioVariable = true;
        else if (s.precio.trim()) serv.precio = Number(s.precio);
        if (s.precioNota.trim()) serv.precioNota = s.precioNota.trim();
        if (s.descripcion.trim()) serv.descripcion = s.descripcion.trim();
        return serv;
      });
  }

  function construirHorario(): Record<number, HorarioDia> {
    const h: Record<number, HorarioDia> = {};
    horario.forEach((d, i) => {
      h[i] = d.abierto ? { abre: d.abre, cierra: d.cierra } : { abre: null, cierra: null };
    });
    return h;
  }

  function construirBloqueos(): Bloqueo[] {
    return bloqueos
      .filter((b) => b.desde.trim() && b.hasta.trim())
      .map((b) => {
        const bloqueo: Bloqueo = { desde: b.desde.trim(), hasta: b.hasta.trim() };
        if (b.motivo.trim()) bloqueo.motivo = b.motivo.trim();
        return bloqueo;
      });
  }

  function alGuardar() {
    const kb: KnowledgeBase = {
      faq: faqs
        .filter((f) => f.pregunta.trim() && f.respuesta.trim())
        .map((f) => ({ pregunta: f.pregunta.trim(), respuesta: f.respuesta.trim() })),
      datos: lineas(datos),
      politicas: lineas(politicas),
      tarifas: lineas(tarifas),
      parabrisas: lineas(parabrisas),
    };
    guardar.mutate({
      horario: construirHorario(),
      servicios: construirServicios(),
      kb,
      bloqueos: construirBloqueos(),
      linkResenas: linkResenas.trim(),
      plantillaMarketing: plantillaMarketing.trim(),
    });
  }

  if (q.isLoading) {
    return (
      <div id="miNegocio">
        <div className="dash-body">
          <p className="dash-vacio">Cargando…</p>
        </div>
      </div>
    );
  }
  if (q.isError) {
    return (
      <div id="miNegocio">
        <div className="dash-body">
          <p className="dash-vacio">No se pudo cargar la configuración del negocio.</p>
        </div>
      </div>
    );
  }

  return (
    <div id="miNegocio">
      <div className="dash-body">
        <div className="dash-titulo">
          <h2>Mi negocio</h2>
        </div>

        <div className="card">
          <h3>Servicios</h3>
          {servicios.map((s, i) => (
            <div className="admin-servicio" key={i}>
              <input placeholder="id" value={s.id} onChange={(e) => setServ(i, "id", e.target.value)} />
              <input placeholder="nombre" value={s.nombre} onChange={(e) => setServ(i, "nombre", e.target.value)} />
              <input
                placeholder="precio"
                inputMode="numeric"
                value={s.precio}
                onChange={(e) => setServ(i, "precio", e.target.value)}
                disabled={s.precioVariable}
              />
              <input
                placeholder="duración (min)"
                inputMode="numeric"
                value={s.duracionMin}
                onChange={(e) => setServ(i, "duracionMin", e.target.value)}
              />
              <label className="admin-check">
                <input
                  type="checkbox"
                  checked={s.precioVariable}
                  onChange={(e) => setServ(i, "precioVariable", e.target.checked)}
                />{" "}
                precio variable
              </label>
              <label className="admin-check">
                <input type="checkbox" checked={s.agendable} onChange={(e) => setServ(i, "agendable", e.target.checked)} /> agendable
              </label>
              <input
                className="admin-ancho"
                placeholder="nota de precio / descripción"
                value={s.precioNota}
                onChange={(e) => setServ(i, "precioNota", e.target.value)}
              />
              <button type="button" className="btn-ghost" onClick={() => setServicios((prev) => prev.filter((_, idx) => idx !== i))}>
                Quitar
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn-ghost"
            onClick={() =>
              setServicios((prev) => [
                ...prev,
                { id: "", nombre: "", precio: "", precioVariable: false, precioNota: "", duracionMin: "90", agendable: true, descripcion: "" },
              ])
            }
          >
            + Agregar servicio
          </button>
        </div>

        <div className="card">
          <h3>Horario</h3>
          {horario.map((d, i) => (
            <div className="admin-horario" key={i}>
              <label className="admin-dia">
                <input type="checkbox" checked={d.abierto} onChange={(e) => setDia(i, "abierto", e.target.checked)} />
                {DIAS[i]}
              </label>
              <div className="campo campo-inline">
                <label htmlFor={`hAbre${i}`}>Abre</label>
                <input
                  id={`hAbre${i}`}
                  type="time"
                  value={d.abre}
                  disabled={!d.abierto}
                  onChange={(e) => setDia(i, "abre", e.target.value)}
                />
              </div>
              <div className="campo campo-inline">
                <label htmlFor={`hCierra${i}`}>Cierra</label>
                <input
                  id={`hCierra${i}`}
                  type="time"
                  value={d.cierra}
                  disabled={!d.abierto}
                  onChange={(e) => setDia(i, "cierra", e.target.value)}
                />
              </div>
            </div>
          ))}
        </div>

        <div className="card">
          <h3>Feriados y bloqueos</h3>
          {bloqueos.map((b, i) => (
            <div className="admin-servicio" key={i}>
              <input type="date" value={b.desde} onChange={(e) => setBloqueo(i, "desde", e.target.value)} />
              <input type="date" value={b.hasta} onChange={(e) => setBloqueo(i, "hasta", e.target.value)} />
              <input
                className="admin-ancho"
                placeholder="motivo (opcional, ej: vacaciones)"
                value={b.motivo}
                onChange={(e) => setBloqueo(i, "motivo", e.target.value)}
              />
              <button type="button" className="btn-ghost" onClick={() => setBloqueos((prev) => prev.filter((_, idx) => idx !== i))}>
                Quitar
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setBloqueos((prev) => [...prev, { desde: "", hasta: "", motivo: "" }])}
          >
            + Agregar bloqueo
          </button>
        </div>

        <div className="card admin-form">
          <h3>Reseñas de Google</h3>
          <div className="campo">
            <label htmlFor="cLinkResenas">Link para pedir reseña (Google Maps → "Escribir reseña")</label>
            <input
              id="cLinkResenas"
              placeholder="https://g.page/r/..."
              value={linkResenas}
              onChange={(e) => setLinkResenas(e.target.value)}
            />
          </div>
        </div>

        <div className="card admin-form">
          <h3>Campañas</h3>
          <div className="campo">
            <label htmlFor="cPlantillaMkt">Plantilla de marketing aprobada (nombre exacto en Meta)</label>
            <input
              id="cPlantillaMkt"
              placeholder="promo_general"
              value={plantillaMarketing}
              onChange={(e) => setPlantillaMarketing(e.target.value)}
            />
            <p className="campo-ayuda">
              Necesaria para enviar campañas desde la pestaña "Campañas". Ver <code>GUIA-META.md</code> §C para
              crearla en WhatsApp Manager.
            </p>
          </div>
        </div>

        <div className="card admin-form">
          <h3>Base de conocimiento</h3>
          <div className="campo">
            <label htmlFor="cDatos">Datos (uno por línea)</label>
            <textarea id="cDatos" value={datos} onChange={(e) => setDatos(e.target.value)} rows={3} />
          </div>
          <div className="campo">
            <label htmlFor="cPol">Políticas (una por línea)</label>
            <textarea id="cPol" value={politicas} onChange={(e) => setPoliticas(e.target.value)} rows={3} />
          </div>
          <div className="campo">
            <label htmlFor="cTar">Tarifas (una por línea)</label>
            <textarea id="cTar" value={tarifas} onChange={(e) => setTarifas(e.target.value)} rows={3} />
          </div>
          <div className="campo">
            <label htmlFor="cPar">Parabrisas (una por línea)</label>
            <textarea id="cPar" value={parabrisas} onChange={(e) => setParabrisas(e.target.value)} rows={3} />
          </div>

          <h4>Preguntas frecuentes</h4>
          {faqs.map((f, i) => (
            <div className="admin-faq" key={i}>
              <input
                placeholder="pregunta"
                value={f.pregunta}
                onChange={(e) => setFaqs((prev) => prev.map((x, idx) => (idx === i ? { ...x, pregunta: e.target.value } : x)))}
              />
              <input
                placeholder="respuesta"
                value={f.respuesta}
                onChange={(e) => setFaqs((prev) => prev.map((x, idx) => (idx === i ? { ...x, respuesta: e.target.value } : x)))}
              />
              <button type="button" className="btn-ghost" onClick={() => setFaqs((prev) => prev.filter((_, idx) => idx !== i))}>
                Quitar
              </button>
            </div>
          ))}
          <button type="button" className="btn-ghost" onClick={() => setFaqs((prev) => [...prev, { pregunta: "", respuesta: "" }])}>
            + Agregar pregunta
          </button>
        </div>

        <button type="button" className="accion accion-primaria" disabled={guardar.isPending} onClick={alGuardar}>
          {guardar.isPending ? "Guardando…" : "Guardar cambios"}
        </button>
      </div>
    </div>
  );
}
