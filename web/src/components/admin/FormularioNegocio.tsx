import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { adminCrearTenant, type AltaTenant, type KnowledgeBase, type Service } from "../../api";

// ─────────────────────────────────────────────────────────────────────────────
// Formulario MVP de alta de negocio (ROADMAP B3). Arma el payload de AltaTenant y lo
// manda a POST /admin/tenants; el backend RE-valida todo, así que acá vamos best-effort
// y mostramos el error que devuelva (incluye 409 por duplicados con mensaje claro).
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

const DIAS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

const lineas = (s: string): string[] => s.split("\n").map((l) => l.trim()).filter(Boolean);

export default function FormularioNegocio({ hayDb }: { hayDb: boolean }) {
  const qc = useQueryClient();

  // Datos base
  const [nombre, setNombre] = useState("");
  const [id, setId] = useState("");
  const [idTocado, setIdTocado] = useState(false);
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [timezone, setTimezone] = useState("America/Costa_Rica");
  const [moneda, setMoneda] = useState("₡");
  const [ubicacion, setUbicacion] = useState("");
  const [intervaloAgendaMin, setIntervaloAgendaMin] = useState("30");

  // Horario MVP: un par abre/cierra + qué días abre.
  const [abre, setAbre] = useState("06:00");
  const [cierra, setCierra] = useState("18:00");
  const [diasAbiertos, setDiasAbiertos] = useState<boolean[]>([true, true, true, true, true, true, true]);

  // Servicios y KB
  const [servicios, setServicios] = useState<ServicioForm[]>([]);
  const [faqs, setFaqs] = useState<FaqForm[]>([]);
  const [datos, setDatos] = useState("");
  const [politicas, setPoliticas] = useState("");
  const [tarifas, setTarifas] = useState("");
  const [parabrisas, setParabrisas] = useState("");

  // Usuario del panel
  const [usuario, setUsuario] = useState("");
  const [password, setPassword] = useState("");

  const [okMsg, setOkMsg] = useState("");

  const crear = useMutation({
    mutationFn: (body: AltaTenant) => adminCrearTenant(body),
    onSuccess: (r) => {
      setOkMsg(`✅ Negocio "${r.tenantId}" creado. Ya puede entrar al panel con su usuario.`);
      qc.invalidateQueries({ queryKey: ["adminTenants"] });
      // Reset de los campos clave (dejamos timezone/moneda por comodidad).
      setNombre(""); setId(""); setIdTocado(false); setPhoneNumberId(""); setAccessToken("");
      setUbicacion(""); setServicios([]); setFaqs([]); setDatos(""); setPoliticas("");
      setTarifas(""); setParabrisas(""); setUsuario(""); setPassword("");
    },
  });

  const error = crear.isError ? (crear.error instanceof Error ? crear.error.message : "No se pudo crear") : "";

  function alCambiarNombre(v: string) {
    setNombre(v);
    if (!idTocado) setId(slugify(v));
  }

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

  function construirHorario(): AltaTenant["tenant"]["horario"] {
    const h: Record<number, { abre: string | null; cierra: string | null }> = {};
    for (let d = 0; d < 7; d++) h[d] = diasAbiertos[d] ? { abre, cierra } : { abre: null, cierra: null };
    return h;
  }

  function enviar() {
    setOkMsg("");
    const kb: KnowledgeBase = {
      faq: faqs.filter((f) => f.pregunta.trim() && f.respuesta.trim()).map((f) => ({ pregunta: f.pregunta.trim(), respuesta: f.respuesta.trim() })),
      datos: lineas(datos),
      politicas: lineas(politicas),
      tarifas: lineas(tarifas),
      parabrisas: lineas(parabrisas),
    };
    const body: AltaTenant = {
      tenant: {
        id: id.trim(),
        nombre: nombre.trim(),
        phoneNumberId: phoneNumberId.trim(),
        accessToken: accessToken.trim() || undefined,
        timezone: timezone.trim() || "America/Costa_Rica",
        moneda: moneda.trim() || "₡",
        ubicacion: ubicacion.trim(),
        intervaloAgendaMin: Number(intervaloAgendaMin) || 30,
        horario: construirHorario(),
        servicios: construirServicios(),
        kb,
      },
      usuario: usuario.trim(),
      password,
    };
    crear.mutate(body);
  }

  const setServ = (i: number, campo: keyof ServicioForm, valor: string | boolean) =>
    setServicios((prev) => prev.map((s, idx) => (idx === i ? { ...s, [campo]: valor } : s)));

  return (
    <form
      className="card admin-form"
      onSubmit={(e) => {
        e.preventDefault();
        enviar();
      }}
    >
      <h3>Nuevo negocio</h3>

      <div className="admin-grid">
        <div className="campo">
          <label htmlFor="oNombre">Nombre</label>
          <input id="oNombre" value={nombre} onChange={(e) => alCambiarNombre(e.target.value)} required />
        </div>
        <div className="campo">
          <label htmlFor="oId">id (slug)</label>
          <input
            id="oId"
            value={id}
            onChange={(e) => {
              setIdTocado(true);
              setId(e.target.value);
            }}
            placeholder="ej: lavacar-rosales"
            required
          />
        </div>
        <div className="campo">
          <label htmlFor="oPnid">phone_number_id (WhatsApp)</label>
          <input id="oPnid" value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} placeholder="solo números" required />
        </div>
        <div className="campo">
          <label htmlFor="oToken">accessToken (opcional)</label>
          <input id="oToken" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} placeholder="vacío usa el número de prueba" />
        </div>
        <div className="campo">
          <label htmlFor="oTz">Zona horaria</label>
          <input id="oTz" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </div>
        <div className="campo">
          <label htmlFor="oMoneda">Moneda</label>
          <input id="oMoneda" value={moneda} onChange={(e) => setMoneda(e.target.value)} />
        </div>
        <div className="campo">
          <label htmlFor="oIntervalo">Intervalo de citas (min)</label>
          <input id="oIntervalo" type="number" value={intervaloAgendaMin} onChange={(e) => setIntervaloAgendaMin(e.target.value)} />
        </div>
      </div>

      <div className="campo">
        <label htmlFor="oUbic">Ubicación</label>
        <textarea id="oUbic" value={ubicacion} onChange={(e) => setUbicacion(e.target.value)} rows={2} required />
      </div>

      <h4>Horario</h4>
      <div className="admin-horario">
        <div className="campo campo-inline">
          <label htmlFor="oAbre">Abre</label>
          <input id="oAbre" type="time" value={abre} onChange={(e) => setAbre(e.target.value)} />
        </div>
        <div className="campo campo-inline">
          <label htmlFor="oCierra">Cierra</label>
          <input id="oCierra" type="time" value={cierra} onChange={(e) => setCierra(e.target.value)} />
        </div>
        <div className="admin-dias">
          {DIAS.map((d, i) => (
            <label key={i} className="admin-dia">
              <input
                type="checkbox"
                checked={diasAbiertos[i]}
                onChange={(e) => setDiasAbiertos((prev) => prev.map((v, idx) => (idx === i ? e.target.checked : v)))}
              />
              {d}
            </label>
          ))}
        </div>
      </div>

      <h4>Servicios agendables</h4>
      {servicios.map((s, i) => (
        <div className="admin-servicio" key={i}>
          <input placeholder="id" value={s.id} onChange={(e) => setServ(i, "id", e.target.value)} />
          <input placeholder="nombre" value={s.nombre} onChange={(e) => setServ(i, "nombre", e.target.value)} />
          <input placeholder="precio" inputMode="numeric" value={s.precio} onChange={(e) => setServ(i, "precio", e.target.value)} disabled={s.precioVariable} />
          <input placeholder="duración (min)" inputMode="numeric" value={s.duracionMin} onChange={(e) => setServ(i, "duracionMin", e.target.value)} />
          <label className="admin-check">
            <input type="checkbox" checked={s.precioVariable} onChange={(e) => setServ(i, "precioVariable", e.target.checked)} /> precio variable
          </label>
          <label className="admin-check">
            <input type="checkbox" checked={s.agendable} onChange={(e) => setServ(i, "agendable", e.target.checked)} /> agendable
          </label>
          <input className="admin-ancho" placeholder="nota de precio / descripción" value={s.precioNota} onChange={(e) => setServ(i, "precioNota", e.target.value)} />
          <button type="button" className="btn-ghost" onClick={() => setServicios((prev) => prev.filter((_, idx) => idx !== i))}>
            Quitar
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn-ghost"
        onClick={() =>
          setServicios((prev) => [...prev, { id: "", nombre: "", precio: "", precioVariable: false, precioNota: "", duracionMin: "90", agendable: true, descripcion: "" }])
        }
      >
        + Agregar servicio
      </button>

      <h4>Base de conocimiento</h4>
      <div className="campo">
        <label htmlFor="oDatos">Datos (uno por línea)</label>
        <textarea id="oDatos" value={datos} onChange={(e) => setDatos(e.target.value)} rows={3} />
      </div>
      <div className="campo">
        <label htmlFor="oPol">Políticas (una por línea)</label>
        <textarea id="oPol" value={politicas} onChange={(e) => setPoliticas(e.target.value)} rows={3} />
      </div>
      <div className="campo">
        <label htmlFor="oTar">Tarifas (una por línea)</label>
        <textarea id="oTar" value={tarifas} onChange={(e) => setTarifas(e.target.value)} rows={3} />
      </div>
      <div className="campo">
        <label htmlFor="oPar">Parabrisas (una por línea)</label>
        <textarea id="oPar" value={parabrisas} onChange={(e) => setParabrisas(e.target.value)} rows={3} />
      </div>

      <h4>Preguntas frecuentes</h4>
      {faqs.map((f, i) => (
        <div className="admin-faq" key={i}>
          <input placeholder="pregunta" value={f.pregunta} onChange={(e) => setFaqs((prev) => prev.map((x, idx) => (idx === i ? { ...x, pregunta: e.target.value } : x)))} />
          <input placeholder="respuesta" value={f.respuesta} onChange={(e) => setFaqs((prev) => prev.map((x, idx) => (idx === i ? { ...x, respuesta: e.target.value } : x)))} />
          <button type="button" className="btn-ghost" onClick={() => setFaqs((prev) => prev.filter((_, idx) => idx !== i))}>
            Quitar
          </button>
        </div>
      ))}
      <button type="button" className="btn-ghost" onClick={() => setFaqs((prev) => [...prev, { pregunta: "", respuesta: "" }])}>
        + Agregar pregunta
      </button>

      <h4>Usuario del panel</h4>
      <div className="admin-grid">
        <div className="campo">
          <label htmlFor="oUsuario">Usuario</label>
          <input id="oUsuario" value={usuario} onChange={(e) => setUsuario(e.target.value)} autoComplete="off" required />
        </div>
        <div className="campo">
          <label htmlFor="oPass">Contraseña (mín 8)</label>
          <input id="oPass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
        </div>
      </div>

      <button type="submit" className="admin-submit" disabled={crear.isPending || !hayDb}>
        {crear.isPending ? "Creando…" : "Crear negocio"}
      </button>
      {error && <div className="admin-error">{error}</div>}
      {okMsg && <div className="admin-ok">{okMsg}</div>}
    </form>
  );
}
