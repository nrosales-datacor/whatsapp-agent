import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listarConversaciones, logout, type Features, type Sesion, type ResumenConversacion } from "../api";
import { useTema } from "../lib/tema";
import { aplicarMarca, resetMarca } from "../lib/marca";
import { iniciales } from "../lib/formato";
import Lista, { necesitaRespuesta } from "./Lista";
import Chat from "./Chat";
import FichaModal from "./FichaModal";
import Dashboard from "./Dashboard";
import Agenda from "./Agenda";
import MiNegocio from "./MiNegocio";
import Usuarios from "./Usuarios";
import Campanias from "./Campanias";
import BotonNotif from "./BotonNotif";
import ErrorState from "./ErrorState";
import Icono, { type IconoId } from "./Iconos";
import { ToastProvider } from "./Toast";

const ANCHO_MOVIL = 760;
type Vista = "inbox" | "panel" | "agenda" | "config" | "usuarios" | "campanias";

// Navegación principal. En desktop se pinta como tabs segmentadas en el header;
// en móvil, como barra inferior (bottom nav) — ver .hd-tabs en global.css.
// `feature`: si el plan del negocio no la habilita (Carril D, 0.1), la tab se ve con
// 🔒 y no cambia de vista al tocarla — abre el modal "Disponible en el plan Pro".
const TABS: { id: Vista; icono: IconoId; label: string; soloDueno?: boolean; feature?: keyof Features }[] = [
  { id: "inbox", icono: "chat", label: "Inbox" },
  { id: "panel", icono: "dash", label: "Panel" },
  { id: "agenda", icono: "cal", label: "Agenda" },
  { id: "config", icono: "gear", label: "Mi negocio", soloDueno: true },
  { id: "usuarios", icono: "user", label: "Usuarios", soloDueno: true, feature: "multiUsuario" },
  { id: "campanias", icono: "send", label: "Campañas", soloDueno: true, feature: "campanias" },
];

export default function Panel({ sesion }: { sesion: Sesion }) {
  const qc = useQueryClient();
  const { tema, alternar } = useTema();
  const [vista, setVista] = useState<Vista>("inbox");
  const [abiertaId, setAbiertaId] = useState<string | null>(null);
  const [mostrarChatMovil, setMostrarChatMovil] = useState(false);
  const [fichaAbierta, setFichaAbierta] = useState(false);
  const [modalPlanAbierto, setModalPlanAbierto] = useState(false);

  const convs = useQuery({
    queryKey: ["conversaciones"],
    queryFn: listarConversaciones,
    refetchInterval: 4000,
  });

  // White-label (C4.1): pinta el panel con la marca de este tenant; al desmontar
  // (logout) vuelve a la paleta default para no filtrar colores a la próxima sesión.
  useEffect(() => {
    aplicarMarca(sesion.marca);
    return () => resetMarca();
  }, [sesion.marca?.colorAcento, sesion.marca?.colorHeader]);

  const salir = useMutation({
    mutationFn: logout,
    onSettled: () => {
      qc.setQueryData(["me"], null);
      qc.removeQueries({ queryKey: ["conversaciones"] });
    },
  });

  function abrir(id: string) {
    setAbiertaId(id);
    if (window.innerWidth <= ANCHO_MOVIL) setMostrarChatMovil(true);
  }

  function volver() {
    setMostrarChatMovil(false);
    setAbiertaId(null);
    setFichaAbierta(false);
  }

  const conversaciones = convs.data ?? [];
  const convActiva: ResumenConversacion | null =
    conversaciones.find((c) => c.id === abiertaId) ?? null;
  const totalSinLeer = conversaciones.reduce((s, c) => s + c.sinLeer, 0);
  const conversacionNecesita = conversaciones.find(necesitaRespuesta) ?? null;

  return (
    <ToastProvider>
      <div id="app">
        <header id="appHeader">
          <div className="hd-marca">
            {sesion.marca.logoUrl ? (
              <img src={sesion.marca.logoUrl} alt={sesion.nombre} className="marca-chip marca-logo" />
            ) : (
              <div className="marca-chip">{iniciales(sesion.nombre)}</div>
            )}
            <div className="hd-marca-txt">
              <div className="hd-nombre">{sesion.nombre}</div>
              <div className="hd-sub">WhatsApp Business</div>
            </div>
          </div>

          <nav className="hd-tabs">
            {TABS.filter((t) => !t.soloDueno || sesion.rol === "dueno").map((t) => {
              const bloqueada = !!t.feature && !sesion.features[t.feature];
              return (
                <button
                  key={t.id}
                  type="button"
                  className={"hd-tab" + (vista === t.id ? " activa" : "") + (bloqueada ? " hd-tab-bloqueada" : "")}
                  onClick={() => (bloqueada ? setModalPlanAbierto(true) : setVista(t.id))}
                >
                  <Icono id={bloqueada ? "lock" : t.icono} size={15} />
                  <span className="hd-tab-label">{t.label}</span>
                  {t.id === "inbox" && totalSinLeer > 0 && (
                    <span className="badge badge-naranja">{totalSinLeer}</span>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="hd-acciones">
            <BotonNotif vapidPublica={sesion.vapidPublica} />
            <button
              type="button"
              className="btn-hd-icono"
              onClick={alternar}
              title={tema === "oscuro" ? "Modo claro" : "Modo oscuro"}
              aria-label="Alternar modo claro/oscuro"
            >
              <Icono id={tema === "oscuro" ? "sun" : "moon"} size={18} />
            </button>
            <button
              type="button"
              className="btn-hd-salir"
              onClick={() => salir.mutate()}
              title="Salir"
            >
              <Icono id="out" size={17} />
              <span>Salir</span>
            </button>
          </div>
        </header>

        <div id="mainView">
          {vista === "inbox" && (
            <div id="inbox-view">
              {convs.isError ? (
                <div className="inbox-error-wrap">
                  <ErrorState mensaje="No se pudieron cargar las conversaciones." onReintentar={() => convs.refetch()} />
                </div>
              ) : (
                <>
                  <Lista
                    conversaciones={conversaciones}
                    abiertaId={abiertaId}
                    escondida={mostrarChatMovil}
                    onAbrir={abrir}
                  />
                  <Chat
                    id={abiertaId}
                    resumen={convActiva}
                    reaperturaConfigurada={sesion.reaperturaConfigurada}
                    mostrar={mostrarChatMovil}
                    onVolver={volver}
                    onVerFicha={() => setFichaAbierta(true)}
                    conversacionNecesitaId={conversacionNecesita?.id ?? null}
                    onVerNecesitaRespuesta={conversacionNecesita ? () => abrir(conversacionNecesita.id) : undefined}
                  />
                </>
              )}
            </div>
          )}
          {vista === "panel" && <Dashboard nombre={sesion.nombre} />}
          {vista === "agenda" && <Agenda servicios={sesion.servicios} />}
          {vista === "config" && sesion.rol === "dueno" && <MiNegocio features={sesion.features} />}
          {vista === "usuarios" && sesion.rol === "dueno" && sesion.features.multiUsuario && (
            <Usuarios usuarioActualId={sesion.usuarioId} />
          )}
          {vista === "campanias" && sesion.rol === "dueno" && sesion.features.campanias && <Campanias />}
        </div>
      </div>

      {fichaAbierta && abiertaId && convActiva && (
        <FichaModal
          convId={abiertaId}
          clienteWa={convActiva.clienteWa}
          onCerrar={() => setFichaAbierta(false)}
        />
      )}

      {modalPlanAbierto && (
        <div
          className="overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setModalPlanAbierto(false);
          }}
        >
          <div className="ficha-modal" style={{ maxWidth: 360 }}>
            <div className="ficha-head">
              <h3>Función Pro</h3>
              <button type="button" onClick={() => setModalPlanAbierto(false)} title="Cerrar">
                ✕
              </button>
            </div>
            <div className="ficha-body">
              <p>Disponible en el plan Pro — contactanos para actualizar tu plan.</p>
            </div>
          </div>
        </div>
      )}
    </ToastProvider>
  );
}
