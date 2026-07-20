import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  obtenerConfig,
  guardarConfig,
  type Bloqueo,
  type ConfigNegocio,
  type Features,
  type HorarioDia,
  type KnowledgeBase,
  type SeccionConocimiento,
  type Service,
} from "../api";
import { EditorItems, EditorSecciones } from "./EditorConocimiento";
import ErrorState from "./ErrorState";
import EstadoVacio from "./EstadoVacio";
import Icono, { type IconoId } from "./Iconos";
import { useToast } from "./Toast";

// ─────────────────────────────────────────────────────────────────────────────
// "Mi negocio" (ROADMAP C2.2): el dueño edita servicios/precios, horario, feriados
// y la base de conocimiento del bot en vivo, sin pasar por el superadmin. Reusa el
// mismo patrón de formulario del onboarding (FormularioNegocio.tsx), pero es un
// solo POST /api/panel/config que reemplaza los 4 bloques juntos.
//
// Rediseño visual (design_handoff_panel_whatsapp/, pantalla 3): sub-nav lateral
// con scrollspy que salta a cada sección + barra "Guardar cambios" fija al pie
// del contenido con scroll. La sub-nav vive en este mismo componente porque el
// resto del panel (Panel.tsx) no tiene noción de "sub-vista" dentro de una tab.
// ─────────────────────────────────────────────────────────────────────────────

const SUBNAV: { id: string; label: string; icono: IconoId }[] = [
  { id: "mnPerfil", label: "Perfil del negocio", icono: "bot" },
  { id: "mnMarca", label: "Marca", icono: "palette" },
  { id: "mnServicios", label: "Servicios", icono: "wrench" },
  { id: "mnHorario", label: "Horario", icono: "clock" },
  { id: "mnFeriados", label: "Feriados y bloqueos", icono: "calendarx" },
  { id: "mnResenas", label: "Reseñas de Google", icono: "star" },
  { id: "mnVentana24", label: "Ventana de 24 horas", icono: "messagecircle" },
  { id: "mnCampanias", label: "Campañas", icono: "send" },
  { id: "mnRescate", label: "Rescate de ventas", icono: "lifebuoy" },
  { id: "mnBaseConocimiento", label: "Base de conocimiento", icono: "bookopen" },
  { id: "mnFaq", label: "Preguntas frecuentes", icono: "helpcircle" },
];

interface ServicioForm {
  id: string;
  nombre: string;
  precio: string;
  precioVariable: boolean;
  precioNota: string;
  duracionMin: string;
  agendable: boolean;
  descripcion: string;
  /** Upsell inteligente al agendar (Carril D, 1.2): qué add-on ofrecer con este servicio. */
  addonSugeridoId: string;
  addonPrecioPromo: string;
  addonActivo: boolean;
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

/** Normaliza los ítems de una lista antes de enviarlos: trim + descarta vacíos. */
const limpiar = (items: string[]): string[] => items.map((s) => s.trim()).filter(Boolean);

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

/** Arma los ids finales de los servicios: normaliza a slug (el operador puede escribir
 * mayúsculas/acentos/espacios sin que el guardado falle) y desambigua colisiones. */
function idsUnicos(items: { id: string; nombre: string }[]): string[] {
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
    addonSugeridoId: s.addonSugeridoId ?? "",
    addonPrecioPromo: s.addonPrecioPromo !== undefined ? String(s.addonPrecioPromo) : "",
    addonActivo: !!s.addonActivo,
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

export default function MiNegocio({ features }: { features: Features }) {
  const qc = useQueryClient();
  const { flash } = useToast();
  const q = useQuery({ queryKey: ["config"], queryFn: obtenerConfig });

  const [cargado, setCargado] = useState(false);
  const [servicios, setServicios] = useState<ServicioForm[]>([]);
  const [arrastrando, setArrastrando] = useState<number | null>(null);
  const [horario, setHorario] = useState<DiaForm[]>([]);
  const [bloqueos, setBloqueos] = useState<BloqueoForm[]>([]);
  const [faqs, setFaqs] = useState<FaqForm[]>([]);
  const [datos, setDatos] = useState<string[]>([]);
  const [politicas, setPoliticas] = useState<string[]>([]);
  const [secciones, setSecciones] = useState<SeccionConocimiento[]>([]);
  const [linkResenas, setLinkResenas] = useState("");
  const [plantillaMarketing, setPlantillaMarketing] = useState("");
  const [plantillaReapertura, setPlantillaReapertura] = useState("");
  const [colorAcento, setColorAcento] = useState("");
  const [colorHeader, setColorHeader] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [rescateActivo, setRescateActivo] = useState(false);
  const [rescateHorasEspera, setRescateHorasEspera] = useState("3");
  const [rescateToque1Texto, setRescateToque1Texto] = useState("");
  const [rescateToque2Texto, setRescateToque2Texto] = useState("");
  const [rescatePlantilla, setRescatePlantilla] = useState("");
  const [googlePlaceId, setGooglePlaceId] = useState("");
  // Perfil del negocio (B7, motor multi-mercado).
  const [tipoNegocio, setTipoNegocio] = useState("");
  const [pais, setPais] = useState("");
  const [formasPago, setFormasPago] = useState("");
  const [registro, setRegistro] = useState("");
  const [tono, setTono] = useState("");
  const [instrucciones, setInstrucciones] = useState("");
  // Snapshot del último estado guardado (o recién cargado): compararlo contra el
  // estado actual es lo que enciende "Cambios sin guardar" en la barra fija.
  const [snapshotInicial, setSnapshotInicial] = useState<string | null>(null);

  const contenidoRef = useRef<HTMLDivElement>(null);
  const [seccionActiva, setSeccionActiva] = useState<string>(SUBNAV[0].id);
  // Mientras dura el scroll-suave disparado por un click en la sub-nav, el
  // IntersectionObserver no debe pisar la sección recién elegida a mitad de camino.
  const ignorarObservador = useRef(false);

  function construirSnapshotActual() {
    return JSON.stringify({
      servicios, horario, bloqueos, faqs, datos, politicas, secciones,
      linkResenas, plantillaMarketing, plantillaReapertura, colorAcento, colorHeader, logoUrl,
      rescateActivo, rescateHorasEspera, rescateToque1Texto, rescateToque2Texto, rescatePlantilla,
      googlePlaceId, tipoNegocio, pais, formasPago, registro, tono, instrucciones,
    });
  }

  function poblar(data: ConfigNegocio) {
    const servF = serviciosAForm(data.servicios);
    const horF = horarioAForm(data.horario);
    const bloqF = bloqueosAForm(data.bloqueos);
    const faqF = data.kb.faq.map((f) => ({ ...f }));
    const datosF = data.kb.datos ?? [];
    const politicasF = data.kb.politicas ?? [];
    const seccionesF = (data.kb.secciones ?? []).map((s) => ({ ...s, items: [...s.items] }));
    const linkResenasF = data.linkResenas ?? "";
    const plantillaMarketingF = data.plantillaMarketing ?? "";
    const plantillaReaperturaF = data.plantillaReapertura ?? "";
    const colorAcentoF = data.colorAcento ?? "";
    const colorHeaderF = data.colorHeader ?? "";
    const logoUrlF = data.logoUrl ?? "";
    const rescateHorasEsperaF = String(data.rescateHorasEspera);
    const rescateToque1TextoF = data.rescateToque1Texto ?? "";
    const rescateToque2TextoF = data.rescateToque2Texto ?? "";
    const rescatePlantillaF = data.rescatePlantilla ?? "";
    const googlePlaceIdF = data.googlePlaceId ?? "";
    const tipoNegocioF = data.tipoNegocio ?? "";
    const paisF = data.pais ?? "";
    const formasPagoF = data.formasPago ?? "";
    const registroF = data.registro ?? "";
    const tonoF = data.tono ?? "";
    const instruccionesF = data.instrucciones ?? "";

    setServicios(servF);
    setHorario(horF);
    setBloqueos(bloqF);
    setFaqs(faqF);
    setDatos(datosF);
    setPoliticas(politicasF);
    setSecciones(seccionesF);
    setLinkResenas(linkResenasF);
    setPlantillaMarketing(plantillaMarketingF);
    setPlantillaReapertura(plantillaReaperturaF);
    setColorAcento(colorAcentoF);
    setColorHeader(colorHeaderF);
    setLogoUrl(logoUrlF);
    setRescateActivo(data.rescateActivo);
    setRescateHorasEspera(rescateHorasEsperaF);
    setRescateToque1Texto(rescateToque1TextoF);
    setRescateToque2Texto(rescateToque2TextoF);
    setRescatePlantilla(rescatePlantillaF);
    setGooglePlaceId(googlePlaceIdF);
    setTipoNegocio(tipoNegocioF);
    setPais(paisF);
    setFormasPago(formasPagoF);
    setRegistro(registroF);
    setTono(tonoF);
    setInstrucciones(instruccionesF);

    setSnapshotInicial(
      JSON.stringify({
        servicios: servF, horario: horF, bloqueos: bloqF, faqs: faqF,
        datos: datosF, politicas: politicasF, secciones: seccionesF,
        linkResenas: linkResenasF, plantillaMarketing: plantillaMarketingF,
        plantillaReapertura: plantillaReaperturaF, colorAcento: colorAcentoF,
        colorHeader: colorHeaderF, logoUrl: logoUrlF,
        rescateActivo: data.rescateActivo, rescateHorasEspera: rescateHorasEsperaF,
        rescateToque1Texto: rescateToque1TextoF, rescateToque2Texto: rescateToque2TextoF,
        rescatePlantilla: rescatePlantillaF, googlePlaceId: googlePlaceIdF,
        tipoNegocio: tipoNegocioF, pais: paisF, formasPago: formasPagoF,
        registro: registroF, tono: tonoF, instrucciones: instruccionesF,
      })
    );
  }

  // Seedear el form UNA sola vez al llegar la config: un refetch de fondo no debe
  // pisar lo que el operador está escribiendo.
  useEffect(() => {
    if (!q.data || cargado) return;
    poblar(q.data);
    setCargado(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, cargado]);

  const dirty = cargado && snapshotInicial !== null && snapshotInicial !== construirSnapshotActual();

  // Scrollspy: qué sección de la sub-nav se marca activa al scrollear a mano
  // dentro del contenido (además del salto directo al hacer click).
  useEffect(() => {
    if (!cargado) return;
    const contenedor = contenidoRef.current;
    if (!contenedor) return;
    const secciones = SUBNAV.map((s) => document.getElementById(s.id)).filter(
      (el): el is HTMLElement => !!el
    );
    if (secciones.length === 0) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (ignorarObservador.current) return;
        const visibles = entries.filter((e) => e.isIntersecting);
        if (visibles.length === 0) return;
        const primero = visibles.reduce((a, b) => (a.boundingClientRect.top < b.boundingClientRect.top ? a : b));
        setSeccionActiva(primero.target.id);
      },
      { root: contenedor, rootMargin: "0px 0px -70% 0px", threshold: 0 }
    );
    secciones.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [cargado]);

  function irASeccion(id: string) {
    setSeccionActiva(id);
    const el = document.getElementById(id);
    if (!el) return;
    ignorarObservador.current = true;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => {
      ignorarObservador.current = false;
    }, 700);
  }

  const guardar = useMutation({
    mutationFn: (body: ConfigNegocio) => guardarConfig(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["config"] });
      qc.invalidateQueries({ queryKey: ["me"] });
      // El estado recién enviado pasa a ser el nuevo "guardado" — sin esto, la
      // barra fija seguiría marcando "cambios sin guardar" tras un guardado ok.
      setSnapshotInicial(construirSnapshotActual());
      flash("Configuración guardada");
    },
    onError: (e) => flash(e instanceof Error ? e.message : "No se pudo guardar"),
  });

  function alDescartar() {
    if (!q.data) return;
    poblar(q.data);
    flash("Cambios descartados");
  }

  const setServ = (i: number, campo: keyof ServicioForm, valor: string | boolean) =>
    setServicios((prev) => prev.map((s, idx) => (idx === i ? { ...s, [campo]: valor } : s)));

  function agregarServicio() {
    setServicios((prev) => [
      ...prev,
      {
        id: "",
        nombre: "",
        precio: "",
        precioVariable: false,
        precioNota: "",
        duracionMin: "90",
        agendable: true,
        descripcion: "",
        addonSugeridoId: "",
        addonPrecioPromo: "",
        addonActivo: false,
      },
    ]);
  }

  function moverServicio(desde: number, hasta: number) {
    if (desde === hasta) return;
    setServicios((prev) => {
      const copia = [...prev];
      const [item] = copia.splice(desde, 1);
      copia.splice(hasta, 0, item);
      return copia;
    });
  }

  const setDia = (i: number, campo: keyof DiaForm, valor: string | boolean) =>
    setHorario((prev) => prev.map((d, idx) => (idx === i ? { ...d, [campo]: valor } : d)));

  const setBloqueo = (i: number, campo: keyof BloqueoForm, valor: string) =>
    setBloqueos((prev) => prev.map((b, idx) => (idx === i ? { ...b, [campo]: valor } : b)));

  function construirServicios(): Service[] {
    const validos = servicios.filter((s) => s.nombre.trim());
    const ids = idsUnicos(validos);
    // El selector de add-on guarda el id CRUDO (tal como está escrito en el formulario)
    // de la fila elegida; acá lo traducimos al id FINAL normalizado de esa fila.
    const idFinalPorCrudo = new Map(validos.map((s, i) => [s.id, ids[i]]));
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
      const addonFinal = idFinalPorCrudo.get(s.addonSugeridoId.trim());
      if (addonFinal && addonFinal !== ids[i]) {
        serv.addonSugeridoId = addonFinal;
        if (s.addonPrecioPromo.trim()) {
          const ap = Math.round(Number(s.addonPrecioPromo));
          if (Number.isFinite(ap) && ap >= 0) serv.addonPrecioPromo = ap;
        }
        if (s.addonActivo) serv.addonActivo = true;
      }
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
      datos: limpiar(datos),
      politicas: limpiar(politicas),
      secciones: secciones
        .map((s) => ({ ...s, titulo: s.titulo.trim(), items: limpiar(s.items) }))
        .filter((s) => s.titulo && s.items.length > 0),
    };
    guardar.mutate({
      horario: construirHorario(),
      servicios: construirServicios(),
      kb,
      bloqueos: construirBloqueos(),
      linkResenas: linkResenas.trim(),
      plantillaMarketing: plantillaMarketing.trim(),
      plantillaReapertura: plantillaReapertura.trim(),
      // Sin plan Pro los inputs de marca están ocultos (arriba); no reenviar un valor
      // viejo que el backend rechazaría por el gating de whiteLabel (0.1).
      colorAcento: features.whiteLabel ? colorAcento.trim() : "",
      colorHeader: features.whiteLabel ? colorHeader.trim() : "",
      logoUrl: features.whiteLabel ? logoUrl.trim() : "",
      // Sin plan Pro los inputs de rescate están ocultos (abajo); no reenviar
      // rescateActivo=true, que el backend rechazaría por el gating (Carril D, 0.1).
      rescateActivo: features.rescateCotizaciones && rescateActivo,
      rescateHorasEspera: Math.round(Number(rescateHorasEspera)) || 3,
      rescateToque1Texto: rescateToque1Texto.trim(),
      rescateToque2Texto: rescateToque2Texto.trim(),
      rescatePlantilla: rescatePlantilla.trim(),
      // Sin plan Pro el input de Place ID está oculto (abajo); no reenviar un valor
      // viejo que el backend rechazaría por el gating de resenasPro (Carril D, 0.1).
      googlePlaceId: features.resenasPro ? googlePlaceId.trim() : "",
      // Perfil del negocio (B7): disponible para todos los planes.
      tipoNegocio: tipoNegocio.trim(),
      pais: pais.trim(),
      formasPago: formasPago.trim(),
      registro: registro.trim(),
      tono: tono.trim(),
      instrucciones: instrucciones.trim(),
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
          <ErrorState mensaje="No se pudo cargar la configuración del negocio." onReintentar={() => q.refetch()} />
        </div>
      </div>
    );
  }

  return (
    <div id="miNegocio">
      <div className="mn-layout">
        <nav className="mn-subnav" aria-label="Secciones de Mi negocio">
          <div className="mn-subnav-eyebrow">Configuración</div>
          <div className="mn-subnav-lista">
            {SUBNAV.map((s) => (
              <button
                key={s.id}
                type="button"
                className={"mn-subnav-item" + (seccionActiva === s.id ? " activo" : "")}
                onClick={() => irASeccion(s.id)}
              >
                <Icono id={s.icono} size={16} />
                <span>{s.label}</span>
              </button>
            ))}
          </div>
        </nav>

        <div className="mn-content" ref={contenidoRef}>
          <div className="dash-body mn-content-inner">
            <div className="card admin-form" id="mnPerfil">
              <h3>Perfil del negocio</h3>
              <p className="mn-section-sub">
                Quién es tu negocio y cómo habla el bot. Con esto el asistente se presenta y responde según tu rubro.
              </p>
              <div className="campo">
                <label htmlFor="cTipoNegocio">Tipo de negocio</label>
                <input
                  id="cTipoNegocio"
                  placeholder="ej: una barbería, un consultorio dental, una empresa de software"
                  value={tipoNegocio}
                  onChange={(e) => setTipoNegocio(e.target.value)}
                />
                <p className="campo-ayuda">Así se presenta el bot: "Sos el asistente de [tu negocio], {tipoNegocio.trim() || "un negocio"}…".</p>
              </div>
              <div className="admin-servicio">
                <div className="campo campo-inline">
                  <label htmlFor="cPais">País</label>
                  <input
                    id="cPais"
                    placeholder="se infiere de la zona horaria"
                    value={pais}
                    onChange={(e) => setPais(e.target.value)}
                  />
                </div>
                <div className="campo campo-inline">
                  <label htmlFor="cRegistro">Trato al cliente</label>
                  <select id="cRegistro" value={registro} onChange={(e) => setRegistro(e.target.value)}>
                    <option value="">Automático (según el país)</option>
                    <option value="vos">Vos (cercano)</option>
                    <option value="tu">Tú (cercano)</option>
                    <option value="usted">Usted (formal)</option>
                  </select>
                </div>
              </div>
              <div className="campo">
                <label htmlFor="cTono">Tono</label>
                <input
                  id="cTono"
                  placeholder="ej: cordial y breve; cercano y profesional"
                  value={tono}
                  onChange={(e) => setTono(e.target.value)}
                />
              </div>
              <div className="campo">
                <label htmlFor="cFormasPago">Formas de pago</label>
                <input
                  id="cFormasPago"
                  placeholder="ej: SINPE Móvil y efectivo; transferencia y tarjeta"
                  value={formasPago}
                  onChange={(e) => setFormasPago(e.target.value)}
                />
              </div>
              <div className="campo">
                <label htmlFor="cInstrucciones">Instrucciones para el bot</label>
                <textarea
                  id="cInstrucciones"
                  rows={8}
                  placeholder={
                    "Las reglas propias de tu negocio, con tus palabras. Ej:\n" +
                    "- El corte incluye lavado de cabello.\n" +
                    "- No atendemos sin cita.\n" +
                    "- Si preguntan por X, respondé Y."
                  }
                  value={instrucciones}
                  onChange={(e) => setInstrucciones(e.target.value)}
                />
                <p className="campo-ayuda">
                  El bot las sigue al pie de la letra. Escribí acá cualquier regla, aclaración o excepción que no
                  encaje en los servicios ni en la base de conocimiento.
                </p>
              </div>
            </div>

            <div className="card admin-form" id="mnMarca">
              <h3>
                Marca {!features.whiteLabel && <span className="badge badge-pro">🔒 Plan Pro</span>}
              </h3>
              {features.whiteLabel ? (
                <>
                  <div className="campo">
                    <label htmlFor="cLogoUrl">URL del logo (imagen cuadrada; sin logo se muestran las iniciales)</label>
                    <input
                      id="cLogoUrl"
                      placeholder="https://..."
                      value={logoUrl}
                      onChange={(e) => setLogoUrl(e.target.value)}
                    />
                  </div>
                  <div className="admin-servicio">
                    <div className="campo campo-inline">
                      <label htmlFor="cColorAcento">Color de acento</label>
                      <input
                        id="cColorAcento"
                        type="color"
                        value={colorAcento || "#0b7d72"}
                        onChange={(e) => setColorAcento(e.target.value)}
                      />
                    </div>
                    <div className="campo campo-inline">
                      <label htmlFor="cColorHeader">Color del encabezado</label>
                      <input
                        id="cColorHeader"
                        type="color"
                        value={colorHeader || "#0b5c56"}
                        onChange={(e) => setColorHeader(e.target.value)}
                      />
                    </div>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => {
                        setColorAcento("");
                        setColorHeader("");
                      }}
                    >
                      Restaurar colores por defecto
                    </button>
                  </div>
                </>
              ) : (
                <p className="campo-ayuda">
                  Logo y colores propios del panel están disponibles en el plan Pro — contactanos para actualizar tu plan.
                </p>
              )}
            </div>

            <div className="card svc-card-wrap" id="mnServicios">
              <div className="svc-header">
                <div>
                  <div className="svc-titulo">
                    Servicios {!features.upsell && <span className="badge badge-pro">🔒 Upsell Pro</span>}
                  </div>
                  <p className="svc-subtitulo">Lo que el bot puede cotizar y agendar. Arrastrá para reordenar.</p>
                </div>
                <button type="button" className="accion accion-primaria svc-nuevo" onClick={agregarServicio}>
                  <Icono id="plus" size={16} />
                  Nuevo servicio
                </button>
              </div>
              {!features.upsell && (
                <p className="campo-ayuda svc-aviso-pro">
                  El upsell inteligente (sugerir un add-on al agendar) está disponible en el plan Pro — contactanos
                  para actualizar tu plan.
                </p>
              )}
              {servicios.length === 0 && (
                <EstadoVacio
                  icono="plus"
                  titulo="Todavía no tenés servicios"
                  ayuda="Agregá el primero para que el bot pueda cotizarlo y agendarlo."
                  accion={{ texto: "Nuevo servicio", icono: "plus", onClick: agregarServicio }}
                />
              )}
              <div className="svc-lista">
                {servicios.map((s, i) => (
                  <div
                    className={`svc-item${arrastrando === i ? " svc-arrastrando" : ""}`}
                    key={i}
                    draggable
                    onDragStart={(e) => {
                      // El índice viaja en el dataTransfer nativo (no en estado de React):
                      // leerlo desde el closure de "arrastrando" en el onDrop de OTRO ítem no es
                      // confiable, depende de que React re-renderice entre dragstart y drop.
                      e.dataTransfer.setData("text/plain", String(i));
                      e.dataTransfer.effectAllowed = "move";
                      setArrastrando(i);
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const origen = Number(e.dataTransfer.getData("text/plain"));
                      if (Number.isInteger(origen)) moverServicio(origen, i);
                      setArrastrando(null);
                    }}
                    onDragEnd={() => setArrastrando(null)}
                  >
                    <div className="svc-item-head">
                      <div className="svc-item-main">
                        <span className="svc-grip" aria-hidden="true">
                          <Icono id="grip" size={18} />
                        </span>
                        <div className="svc-item-titulo">
                          <input
                            className="svc-nombre-input"
                            placeholder="Nombre del servicio"
                            value={s.nombre}
                            onChange={(e) => setServ(i, "nombre", e.target.value)}
                          />
                          <label className="svc-slug">
                            <Icono id="hash" size={11} />
                            <input
                              className="svc-slug-input"
                              placeholder="id"
                              value={s.id}
                              onChange={(e) => setServ(i, "id", e.target.value)}
                            />
                          </label>
                        </div>
                      </div>
                      <div className="svc-item-actions">
                        {s.agendable && (
                          <span className="svc-pill-agendable">
                            <Icono id="calcheck" size={14} />
                            Agendable
                          </span>
                        )}
                        <button
                          type="button"
                          className="svc-borrar"
                          title="Quitar servicio"
                          onClick={() => setServicios((prev) => prev.filter((_, idx) => idx !== i))}
                        >
                          <Icono id="trash" size={16} />
                        </button>
                      </div>
                    </div>
                    <div className="svc-item-body">
                      <div className="svc-col">
                        <div className="campo">
                          <label className="svc-label" htmlFor={`svcNombre${i}`}>
                            Nombre visible
                          </label>
                          <input
                            id={`svcNombre${i}`}
                            value={s.nombre}
                            onChange={(e) => setServ(i, "nombre", e.target.value)}
                          />
                        </div>
                        <div className="campo">
                          <label className="svc-label" htmlFor={`svcNota${i}`}>
                            Nota de precio <span className="svc-label-hint">— cómo lo explica el bot</span>
                          </label>
                          <textarea
                            id={`svcNota${i}`}
                            placeholder="según vehículo…"
                            rows={2}
                            value={s.precioNota}
                            onChange={(e) => setServ(i, "precioNota", e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="svc-col">
                        <div className="svc-row-2">
                          <div className="campo">
                            <label className="svc-label" htmlFor={`svcPrecio${i}`}>
                              Precio base
                            </label>
                            <div className="svc-input-money">
                              <span>₡</span>
                              <input
                                id={`svcPrecio${i}`}
                                inputMode="numeric"
                                className="tnum"
                                value={s.precio}
                                disabled={s.precioVariable}
                                onChange={(e) => setServ(i, "precio", e.target.value)}
                              />
                            </div>
                          </div>
                          <div className="campo">
                            <label className="svc-label" htmlFor={`svcDuracion${i}`}>
                              Duración (min)
                            </label>
                            <input
                              id={`svcDuracion${i}`}
                              inputMode="numeric"
                              className="tnum"
                              value={s.duracionMin}
                              onChange={(e) => setServ(i, "duracionMin", e.target.value)}
                            />
                          </div>
                        </div>
                        <div className="svc-switches">
                          <label className="svc-switch-row">
                            <div>
                              <div className="svc-switch-titulo">Precio variable</div>
                              <div className="svc-switch-ayuda">El precio cambia según el vehículo</div>
                            </div>
                            <span className="switch">
                              <input
                                type="checkbox"
                                checked={s.precioVariable}
                                onChange={(e) => setServ(i, "precioVariable", e.target.checked)}
                              />
                              <span className="switch-track">
                                <span className="switch-knob" />
                              </span>
                            </span>
                          </label>
                          <div className="svc-switch-sep" />
                          <label className="svc-switch-row">
                            <div>
                              <div className="svc-switch-titulo">Agendable</div>
                              <div className="svc-switch-ayuda">El bot puede reservar una cita</div>
                            </div>
                            <span className="switch">
                              <input
                                type="checkbox"
                                checked={s.agendable}
                                onChange={(e) => setServ(i, "agendable", e.target.checked)}
                              />
                              <span className="switch-track">
                                <span className="switch-knob" />
                              </span>
                            </span>
                          </label>
                          {features.upsell && (
                            <>
                              <div className="svc-switch-sep" />
                              <label className="svc-switch-row">
                                <div>
                                  <div className="svc-switch-titulo">Ofrecer add-on</div>
                                  <div className="svc-switch-ayuda">Sugerir un extra al cotizar</div>
                                </div>
                                <span className="switch">
                                  <input
                                    type="checkbox"
                                    checked={s.addonActivo}
                                    onChange={(e) => setServ(i, "addonActivo", e.target.checked)}
                                  />
                                  <span className="switch-track">
                                    <span className="switch-knob" />
                                  </span>
                                </span>
                              </label>
                            </>
                          )}
                        </div>
                        {features.upsell && s.addonActivo && (
                          <div className="svc-row-2">
                            <div className="campo">
                              <label className="svc-label" htmlFor={`svcAddon${i}`}>
                                Add-on sugerido
                              </label>
                              <select
                                id={`svcAddon${i}`}
                                value={s.addonSugeridoId}
                                onChange={(e) => setServ(i, "addonSugeridoId", e.target.value)}
                              >
                                <option value="">— sin add-on sugerido —</option>
                                {servicios
                                  .filter((_, idx) => idx !== i)
                                  .map((otro, idx) => (
                                    <option key={idx} value={otro.id}>
                                      {otro.nombre || otro.id || `servicio #${idx + 1}`}
                                    </option>
                                  ))}
                              </select>
                            </div>
                            <div className="campo">
                              <label className="svc-label" htmlFor={`svcAddonPrecio${i}`}>
                                Precio promo
                              </label>
                              <div className="svc-input-money">
                                <span>₡</span>
                                <input
                                  id={`svcAddonPrecio${i}`}
                                  inputMode="numeric"
                                  className="tnum"
                                  value={s.addonPrecioPromo}
                                  onChange={(e) => setServ(i, "addonPrecioPromo", e.target.value)}
                                />
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="card" id="mnHorario">
              <h3>Horario</h3>
              <p className="mn-section-sub">Días y horas en que el bot puede ofrecer y agendar citas.</p>
              <div className="horario-lista">
                {horario.map((d, i) => (
                  <div className={"horario-fila" + (!d.abierto ? " horario-fila-cerrado" : "")} key={i}>
                    <label className="horario-dia">
                      <span className="switch">
                        <input
                          type="checkbox"
                          checked={d.abierto}
                          onChange={(e) => setDia(i, "abierto", e.target.checked)}
                        />
                        <span className="switch-track">
                          <span className="switch-knob" />
                        </span>
                      </span>
                      {DIAS[i]}
                    </label>
                    <div className="horario-campo">
                      <label htmlFor={`hAbre${i}`}>Abre</label>
                      <div className="horario-input-hora">
                        <Icono id="clock" size={14} />
                        <input
                          id={`hAbre${i}`}
                          type="time"
                          value={d.abre}
                          disabled={!d.abierto}
                          onChange={(e) => setDia(i, "abre", e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="horario-campo">
                      <label htmlFor={`hCierra${i}`}>Cierra</label>
                      <div className="horario-input-hora">
                        <Icono id="clock" size={14} />
                        <input
                          id={`hCierra${i}`}
                          type="time"
                          value={d.cierra}
                          disabled={!d.abierto}
                          onChange={(e) => setDia(i, "cierra", e.target.value)}
                        />
                      </div>
                    </div>
                    <span className={"horario-chip" + (d.abierto ? " horario-chip-abierto" : "")}>
                      {d.abierto ? "Abierto" : "Cerrado"}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="card" id="mnFeriados">
              <h3>Feriados y bloqueos</h3>
              <p className="mn-section-sub">Fechas donde el bot no ofrece horarios (vacaciones, feriados, etc.).</p>
              <div className="feriados-lista">
                {bloqueos.map((b, i) => (
                  <div className="feriado-fila" key={i}>
                    <span className="feriado-icono">
                      <Icono id="calendarx" size={16} />
                    </span>
                    <div className="feriado-campos">
                      <div className="feriado-fechas">
                        <input type="date" value={b.desde} onChange={(e) => setBloqueo(i, "desde", e.target.value)} />
                        <span className="feriado-a">–</span>
                        <input type="date" value={b.hasta} onChange={(e) => setBloqueo(i, "hasta", e.target.value)} />
                      </div>
                      <input
                        className="feriado-motivo"
                        placeholder="motivo (opcional, ej: vacaciones)"
                        value={b.motivo}
                        onChange={(e) => setBloqueo(i, "motivo", e.target.value)}
                      />
                    </div>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => setBloqueos((prev) => prev.filter((_, idx) => idx !== i))}
                    >
                      Quitar
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="btn-punteado"
                onClick={() => setBloqueos((prev) => [...prev, { desde: "", hasta: "", motivo: "" }])}
              >
                + Agregar bloqueo
              </button>
            </div>

            <div className="card admin-form" id="mnResenas">
              <h3>Reseñas de Google</h3>
              <p className="mn-section-sub">Cómo y cuándo el bot le pide una reseña al cliente.</p>
              <div className="campo">
                <label htmlFor="cLinkResenas">Link para pedir reseña (Google Maps → "Escribir reseña")</label>
                <input
                  id="cLinkResenas"
                  placeholder="https://g.page/r/..."
                  value={linkResenas}
                  onChange={(e) => setLinkResenas(e.target.value)}
                />
              </div>
              <h4>
                Motor de reseñas completo {!features.resenasPro && <span className="badge badge-pro">🔒 Plan Pro</span>}
              </h4>
              {features.resenasPro ? (
                <div className="campo">
                  <label htmlFor="cGooglePlaceId">Place ID de Google (para graficar la reputación en el dashboard)</label>
                  <input
                    id="cGooglePlaceId"
                    className="mono"
                    placeholder="ChIJN1t_tDeuEmsRUsoyG83frY4"
                    value={googlePlaceId}
                    onChange={(e) => setGooglePlaceId(e.target.value)}
                  />
                  <p className="campo-ayuda">
                    Con plan Pro, el seguimiento post-servicio usa 3 opciones (Excelente/Bien/Mal) en vez de 2: solo
                    "Excelente" recibe el link de reseña. Con el Place ID configurado, un job diario consulta tu rating
                    de Google y el dashboard grafica su evolución. Buscá tu Place ID en{" "}
                    <code>developers.google.com/maps/documentation/places/web-service/place-id</code>.
                  </p>
                </div>
              ) : (
                <p className="campo-ayuda">
                  El seguimiento de 3 opciones (Excelente/Bien/Mal), el contador de solicitudes y el gráfico de
                  reputación en Google están disponibles en el plan Pro — contactanos para actualizar tu plan.
                </p>
              )}
            </div>

            <div className="card admin-form" id="mnVentana24">
              <h3>Ventana de 24 horas</h3>
              <div className="campo">
                <label htmlFor="cPlantillaReapertura">Plantilla de reapertura aprobada (nombre exacto en Meta)</label>
                <input
                  id="cPlantillaReapertura"
                  className="mono"
                  placeholder="reapertura_conversacion"
                  value={plantillaReapertura}
                  onChange={(e) => setPlantillaReapertura(e.target.value)}
                />
                <p className="campo-ayuda">
                  Es una plantilla de UTILIDAD (no marketing) para reabrir una conversación cuando pasaron más de 24h
                  desde el último mensaje del cliente. Sin ella, el botón "Reabrir conversación" del chat no aparece.
                  Ver <code>GUIA-META.md</code> §D.
                </p>
              </div>
            </div>

            <div className="card admin-form" id="mnCampanias">
              <h3>Campañas</h3>
              <div className="campo">
                <label htmlFor="cPlantillaMkt">Plantilla de marketing aprobada (nombre exacto en Meta)</label>
                <input
                  id="cPlantillaMkt"
                  className="mono"
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

            <div className="card admin-form" id="mnRescate">
              <div className="mn-section-head-switch">
                <h3>
                  Rescate de ventas {!features.rescateCotizaciones && <span className="badge badge-pro">🔒 Plan Pro</span>}
                </h3>
                {features.rescateCotizaciones && (
                  <span className="switch">
                    <input
                      type="checkbox"
                      checked={rescateActivo}
                      onChange={(e) => setRescateActivo(e.target.checked)}
                    />
                    <span className="switch-track">
                      <span className="switch-knob" />
                    </span>
                  </span>
                )}
              </div>
              {features.rescateCotizaciones ? (
                <>
                  <p className="campo-ayuda">
                    Cuando el bot cotiza un pulido y el cliente no agenda, le manda un seguimiento automático (máx. 2
                    toques) si no vuelve a escribir. La tarjeta "₡ recuperados" del dashboard muestra el resultado.
                  </p>
                  <div className="campo">
                    <label htmlFor="cRescateHoras">Horas de espera antes del primer toque</label>
                    <input
                      id="cRescateHoras"
                      inputMode="numeric"
                      value={rescateHorasEspera}
                      onChange={(e) => setRescateHorasEspera(e.target.value)}
                    />
                  </div>
                  <div className="campo">
                    <label htmlFor="cRescateToque1">
                      Texto del primer toque (variables: {"{servicio}"}, {"{monto}"}, {"{n}"} = horarios libres)
                    </label>
                    <textarea
                      id="cRescateToque1"
                      placeholder="¡Hola! 👋 ¿Te guardo el espacio para el {servicio} ({monto})? Me quedan {n} horarios libres."
                      value={rescateToque1Texto}
                      onChange={(e) => setRescateToque1Texto(e.target.value)}
                      rows={2}
                    />
                  </div>
                  <div className="campo">
                    <label htmlFor="cRescateToque2">Texto/variable del segundo toque (llena la plantilla de Meta)</label>
                    <input
                      id="cRescateToque2"
                      placeholder="pulido de parabrisas"
                      value={rescateToque2Texto}
                      onChange={(e) => setRescateToque2Texto(e.target.value)}
                    />
                  </div>
                  <div className="campo">
                    <label htmlFor="cRescatePlantilla">Plantilla de Meta del segundo toque (nombre exacto)</label>
                    <input
                      id="cRescatePlantilla"
                      className="mono"
                      placeholder="rescate_cotizacion"
                      value={rescatePlantilla}
                      onChange={(e) => setRescatePlantilla(e.target.value)}
                    />
                    <p className="campo-ayuda">
                      El segundo toque sale un día después, fuera de la ventana de 24h: necesita una plantilla aprobada
                      en Meta. Sin ella, el rescate se detiene después del primer toque.
                    </p>
                  </div>
                </>
              ) : (
                <p className="campo-ayuda">
                  El seguimiento automático de cotizaciones abandonadas está disponible en el plan Pro — contactanos
                  para actualizar tu plan.
                </p>
              )}
            </div>

            <div className="card admin-form" id="mnBaseConocimiento">
              <h3>Base de conocimiento</h3>
              <p className="mn-section-sub">
                Lo que el bot sabe para responder preguntas de tus clientes. Cada línea es un dato suelto.
              </p>

              <div className="kb-grupo">
                <div className="kb-grupo-cabecera">
                  <div className="kb-grupo-titulo">
                    <Icono id="quote" size={16} />
                    Información general
                  </div>
                  <div className="kb-count">{datos.filter((d) => d.trim()).length}</div>
                </div>
                <p className="kb-grupo-ayuda">
                  Datos sueltos del negocio: ubicación, formas de pago, tiempos de espera, beneficios…
                </p>
                <EditorItems
                  items={datos}
                  onChange={setDatos}
                  placeholder="Un dato por línea…"
                  ejemplos={["Aceptamos SINPE Móvil y efectivo", "Hay parqueo mientras esperás"]}
                  textoAgregar="Agregar dato"
                />
              </div>

              <div className="kb-grupo">
                <div className="kb-grupo-cabecera">
                  <div className="kb-grupo-titulo">
                    <Icono id="shield" size={16} />
                    Políticas
                  </div>
                  <div className="kb-count">{politicas.filter((p) => p.trim()).length}</div>
                </div>
                <p className="kb-grupo-ayuda">Reglas y condiciones que el bot debe respetar y comunicar.</p>
                <EditorItems
                  items={politicas}
                  onChange={setPoliticas}
                  placeholder="Una política por línea…"
                  ejemplos={["Cancelaciones con 24h de anticipación", "No se hacen devoluciones"]}
                  textoAgregar="Agregar política"
                />
              </div>

              <div className="kb-grupo">
                <div className="kb-grupo-cabecera">
                  <div className="kb-grupo-titulo">
                    <Icono id="bookopen" size={16} />
                    Secciones propias
                  </div>
                  <div className="kb-count">{secciones.filter((s) => s.titulo.trim()).length}</div>
                </div>
                <p className="kb-grupo-ayuda">
                  Todo lo específico de tu negocio, en las secciones que vos definas (precios, menú,
                  tratamientos…). El bot recibe cada sección con su título.
                </p>
                <EditorSecciones secciones={secciones} onChange={setSecciones} />
              </div>
            </div>

            <div className="card admin-form" id="mnFaq">
              <h3>Preguntas frecuentes</h3>
              <p className="mn-section-sub">Pares pregunta/respuesta que el bot puede citar tal cual.</p>
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
              <button
                type="button"
                className="btn-punteado"
                onClick={() => setFaqs((prev) => [...prev, { pregunta: "", respuesta: "" }])}
              >
                + Agregar pregunta
              </button>
            </div>
          </div>

          <div className="mn-guardar-barra">
            <div className="mn-guardar-estado">
              {dirty ? (
                <>
                  <span className="mn-guardar-dot" /> Cambios sin guardar
                </>
              ) : (
                "Todo guardado"
              )}
            </div>
            <div className="mn-guardar-acciones">
              <button type="button" className="btn-ghost" disabled={!dirty || guardar.isPending} onClick={alDescartar}>
                Descartar
              </button>
              <button type="button" className="accion accion-primaria" disabled={guardar.isPending} onClick={alGuardar}>
                <Icono id="check2" size={14} />
                {guardar.isPending ? "Guardando…" : "Guardar cambios"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
