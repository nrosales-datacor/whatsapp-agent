import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  adminConectarWhatsapp,
  adminCrearTenant,
  adminEmbeddedSignupConfig,
  type AltaTenant,
  type KnowledgeBase,
  type SeccionConocimiento,
  type Service,
} from "../../api";
import { EditorItems, EditorSecciones } from "../EditorConocimiento";
import { lanzarEmbeddedSignup } from "../../lib/embeddedSignup";

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

/** Normaliza los ítems de una lista antes de enviarlos: trim + descarta vacíos. */
const limpiar = (items: string[]): string[] => items.map((s) => s.trim()).filter(Boolean);

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
  // Perfil del negocio (B7, motor multi-mercado).
  const [tipoNegocio, setTipoNegocio] = useState("");
  const [pais, setPais] = useState("");
  const [formasPago, setFormasPago] = useState("");
  const [registro, setRegistro] = useState("");
  const [tono, setTono] = useState("");
  const [instrucciones, setInstrucciones] = useState("");

  // Horario MVP: un par abre/cierra + qué días abre.
  const [abre, setAbre] = useState("06:00");
  const [cierra, setCierra] = useState("18:00");
  const [diasAbiertos, setDiasAbiertos] = useState<boolean[]>([true, true, true, true, true, true, true]);

  // Servicios y KB
  const [servicios, setServicios] = useState<ServicioForm[]>([]);
  const [faqs, setFaqs] = useState<FaqForm[]>([]);
  const [datos, setDatos] = useState<string[]>([]);
  const [politicas, setPoliticas] = useState<string[]>([]);
  const [secciones, setSecciones] = useState<SeccionConocimiento[]>([]);

  // Usuario del panel
  const [usuario, setUsuario] = useState("");
  const [password, setPassword] = useState("");

  const [okMsg, setOkMsg] = useState("");
  const [errToken, setErrToken] = useState("");

  // Embedded Signup (C4.2): si el server lo tiene configurado, el número se conecta
  // por el popup de Meta en vez de pegar phone_number_id + token a mano.
  const esCfg = useQuery({ queryKey: ["adminEsConfig"], queryFn: adminEmbeddedSignupConfig });
  const usarEs = !!(esCfg.data?.configurado && esCfg.data.config);
  const [tokenHandle, setTokenHandle] = useState<string | null>(null);
  const [conectando, setConectando] = useState(false);
  const [errConexion, setErrConexion] = useState("");
  const [avisoConexion, setAvisoConexion] = useState("");

  async function conectarWhatsapp() {
    const config = esCfg.data?.config;
    if (!config) return;
    setErrConexion("");
    setAvisoConexion("");
    setConectando(true);
    try {
      const sesion = await lanzarEmbeddedSignup(config);
      const conex = await adminConectarWhatsapp(sesion);
      setPhoneNumberId(conex.phoneNumberId);
      setTokenHandle(conex.tokenHandle);
      const notas: string[] = [];
      if (!conex.suscrito) notas.push("no se pudieron suscribir los webhooks del WABA");
      if (!conex.registrado) notas.push("el número quedó sin registrar (falta WHATSAPP_REGISTER_PIN)");
      setAvisoConexion(notas.length ? notas.join("; ") : "");
    } catch (e) {
      setErrConexion(e instanceof Error ? e.message : "No se pudo conectar.");
    } finally {
      setConectando(false);
    }
  }

  function desconectar() {
    setTokenHandle(null);
    setPhoneNumberId("");
    setAvisoConexion("");
    setErrConexion("");
  }

  const crear = useMutation({
    mutationFn: (body: AltaTenant) => adminCrearTenant(body),
    onSuccess: (r) => {
      setOkMsg(`✅ Negocio "${r.tenantId}" creado. Ya puede entrar al panel con su usuario.`);
      qc.invalidateQueries({ queryKey: ["adminTenants"] });
      // Reset de los campos clave (dejamos timezone/moneda por comodidad).
      setNombre(""); setId(""); setIdTocado(false); setPhoneNumberId(""); setAccessToken("");
      setUbicacion(""); setServicios([]); setFaqs([]); setDatos([]); setPoliticas([]);
      setSecciones([]); setUsuario(""); setPassword("");
      setTipoNegocio(""); setPais(""); setFormasPago(""); setRegistro(""); setTono(""); setInstrucciones("");
      setTokenHandle(null); setAvisoConexion(""); setErrConexion("");
    },
  });

  const error = crear.isError ? (crear.error instanceof Error ? crear.error.message : "No se pudo crear") : "";

  function alCambiarNombre(v: string) {
    setNombre(v);
    if (!idTocado) setId(slugify(v));
  }

  /** Arma los ids finales de los servicios: normaliza a slug (el operador puede escribir
   * mayúsculas/acentos/espacios sin que el guardado falle) y desambigua colisiones. */
  function idsUnicosServicios(items: { id: string; nombre: string }[]): string[] {
    const vistos = new Set<string>();
    return items.map((it) => {
      const base = slugify(it.id) || slugify(it.nombre) || "servicio";
      let candidato = base;
      let n = 2;
      while (vistos.has(candidato)) candidato = `${base}-${n++}`;
      vistos.add(candidato);
      return candidato;
    });
  }

  function construirServicios(): Service[] {
    const validos = servicios.filter((s) => s.nombre.trim());
    const ids = idsUnicosServicios(validos);
    return validos.map((s, i) => {
      const duracion = Math.round(Number(s.duracionMin));
      const serv: Service = {
        id: ids[i],
        nombre: s.nombre.trim(),
        duracionMin: Number.isFinite(duracion) && duracion > 0 ? duracion : 60,
      };
      if (s.agendable) serv.agendable = true;
      if (s.precioVariable) serv.precioVariable = true;
      else if (s.precio.trim()) serv.precio = Math.round(Number(s.precio));
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
    // Sin token el negocio quedaría creado y mudo (F5: no hay número de prueba de
    // respaldo). El backend lo exige igual; acá se avisa antes de mandar.
    if (!tokenHandle && !accessToken.trim()) {
      setErrToken("Falta el access token de WhatsApp (o conectá el número con Meta).");
      return;
    }
    setErrToken("");
    const kb: KnowledgeBase = {
      faq: faqs.filter((f) => f.pregunta.trim() && f.respuesta.trim()).map((f) => ({ pregunta: f.pregunta.trim(), respuesta: f.respuesta.trim() })),
      datos: limpiar(datos),
      politicas: limpiar(politicas),
      secciones: secciones
        .map((s) => ({ ...s, titulo: s.titulo.trim(), items: limpiar(s.items) }))
        .filter((s) => s.titulo && s.items.length > 0),
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
        tipoNegocio: tipoNegocio.trim() || undefined,
        pais: pais.trim() || undefined,
        formasPago: formasPago.trim() || undefined,
        registro: registro.trim() || undefined,
        tono: tono.trim() || undefined,
        instrucciones: instrucciones.trim() || undefined,
      },
      usuario: usuario.trim(),
      password,
      // Vía Embedded Signup: el backend canjea el handle por el token + phone_number_id
      // verificados (no viajan por el navegador).
      tokenHandle: tokenHandle || undefined,
    };
    crear.mutate(body);
  }

  const setServ = (i: number, campo: keyof ServicioForm, valor: string | boolean) =>
    setServicios((prev) => prev.map((s, idx) => (idx === i ? { ...s, [campo]: valor } : s)));

  // Entrada manual del número (sin Embedded Signup, o como fallback avanzado). Sin
  // `required`: puede vivir dentro de un <details> colapsado, y el backend revalida.
  const camposManuales = (
    <div className="admin-grid">
      <div className="campo">
        <label htmlFor="oPnid">phone_number_id (WhatsApp)</label>
        <input id="oPnid" value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} placeholder="solo números" />
      </div>
      <div className="campo">
        <label htmlFor="oToken">accessToken (obligatorio)</label>
        <input
          id="oToken"
          value={accessToken}
          onChange={(e) => setAccessToken(e.target.value)}
          placeholder="token del WABA del negocio (EAA…)"
          autoComplete="off"
        />
      </div>
    </div>
  );

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
            placeholder="ej: mi-negocio"
            required
          />
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

      <h4>WhatsApp</h4>
      {usarEs ? (
        tokenHandle ? (
          <div className="admin-conectado">
            <div>
              ✅ Número conectado (phone_number_id <code>{phoneNumberId}</code>).{" "}
              <button type="button" className="btn-ghost" onClick={desconectar}>
                Cambiar
              </button>
            </div>
            {avisoConexion && <div className="admin-aviso">⚠️ {avisoConexion}</div>}
          </div>
        ) : (
          <div className="admin-conectar">
            <button type="button" className="btn-fb" onClick={conectarWhatsapp} disabled={conectando}>
              {conectando ? "Conectando…" : "Conectar WhatsApp con Meta"}
            </button>
            <p className="admin-hint">
              Se abrirá una ventana de Facebook para que el negocio conecte su WhatsApp Business. No hace falta copiar
              ningún token.
            </p>
            {errConexion && <div className="admin-error">{errConexion}</div>}
            <details className="admin-manual">
              <summary>Conectar manualmente (avanzado)</summary>
              {camposManuales}
            </details>
          </div>
        )
      ) : (
        camposManuales
      )}

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

      <h4>Perfil del negocio</h4>
      <div className="campo">
        <label htmlFor="oTipoNegocio">Tipo de negocio</label>
        <input
          id="oTipoNegocio"
          placeholder="ej: una barbería, un consultorio dental, una empresa de software"
          value={tipoNegocio}
          onChange={(e) => setTipoNegocio(e.target.value)}
        />
      </div>
      <div className="admin-grid">
        <div className="campo">
          <label htmlFor="oPais">País</label>
          <input id="oPais" placeholder="se infiere de la zona horaria" value={pais} onChange={(e) => setPais(e.target.value)} />
        </div>
        <div className="campo">
          <label htmlFor="oRegistro">Trato al cliente</label>
          <select id="oRegistro" value={registro} onChange={(e) => setRegistro(e.target.value)}>
            <option value="">Automático (según el país)</option>
            <option value="vos">Vos (cercano)</option>
            <option value="tu">Tú (cercano)</option>
            <option value="usted">Usted (formal)</option>
          </select>
        </div>
      </div>
      <div className="campo">
        <label htmlFor="oTono">Tono</label>
        <input id="oTono" placeholder="ej: cordial y breve; cercano y profesional" value={tono} onChange={(e) => setTono(e.target.value)} />
      </div>
      <div className="campo">
        <label htmlFor="oFormasPago">Formas de pago</label>
        <input id="oFormasPago" placeholder="ej: SINPE Móvil y efectivo" value={formasPago} onChange={(e) => setFormasPago(e.target.value)} />
      </div>
      <div className="campo">
        <label htmlFor="oInstrucciones">Instrucciones para el bot</label>
        <textarea
          id="oInstrucciones"
          rows={6}
          placeholder={"Reglas propias del negocio, con tus palabras. Ej:\n- El corte incluye lavado.\n- No atendemos sin cita."}
          value={instrucciones}
          onChange={(e) => setInstrucciones(e.target.value)}
        />
      </div>

      <h4>Base de conocimiento</h4>
      <div className="kb-grupo">
        <label>Información general</label>
        <EditorItems
          items={datos}
          onChange={setDatos}
          placeholder="Un dato por línea…"
          ejemplos={["Aceptamos SINPE Móvil y efectivo", "Hay parqueo"]}
          textoAgregar="Agregar dato"
        />
      </div>
      <div className="kb-grupo">
        <label>Políticas</label>
        <EditorItems
          items={politicas}
          onChange={setPoliticas}
          placeholder="Una política por línea…"
          ejemplos={["Cancelaciones con 24h de anticipación"]}
          textoAgregar="Agregar política"
        />
      </div>
      <div className="kb-grupo">
        <label>Secciones propias (precios, menú, servicios…)</label>
        <EditorSecciones secciones={secciones} onChange={setSecciones} />
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
      {errToken && <div className="admin-error">{errToken}</div>}
      {error && <div className="admin-error">{error}</div>}
      {okMsg && <div className="admin-ok">{okMsg}</div>}
    </form>
  );
}
