import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listarConversaciones, logout, type Sesion, type ResumenConversacion } from "../api";
import { useTema } from "../lib/tema";
import { aplicarMarca, resetMarca } from "../lib/marca";
import { iniciales } from "../lib/formato";
import Lista from "./Lista";
import Chat from "./Chat";
import FichaModal from "./FichaModal";
import Dashboard from "./Dashboard";
import Agenda from "./Agenda";
import MiNegocio from "./MiNegocio";
import Usuarios from "./Usuarios";
import Campanias from "./Campanias";
import BotonNotif from "./BotonNotif";
import Icono from "./Iconos";
import { ToastProvider } from "./Toast";

const ANCHO_MOVIL = 760;
type Vista = "inbox" | "panel" | "agenda" | "config" | "usuarios" | "campanias";

export default function Panel({ sesion }: { sesion: Sesion }) {
  const qc = useQueryClient();
  const { tema, alternar } = useTema();
  const [vista, setVista] = useState<Vista>("inbox");
  const [abiertaId, setAbiertaId] = useState<string | null>(null);
  const [mostrarChatMovil, setMostrarChatMovil] = useState(false);
  const [fichaAbierta, setFichaAbierta] = useState(false);
  const hdTabsRef = useRef<HTMLDivElement>(null);

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
  // Con muchas tabs (rol dueño) la tira scrollea horizontal en pantallas
  // angostas; el mouse wheel solo scrollea vertical por defecto, así que
  // traducimos la rueda a scroll horizontal para que se puedan alcanzar.
  // Listener nativo (no el onWheel de React) porque React lo adjunta como
  // passive: preventDefault() ahí no tiene efecto y solo tira un warning.
  useEffect(() => {
    const el = hdTabsRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!el || el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  function volver() {
    setMostrarChatMovil(false);
    setAbiertaId(null);
    setFichaAbierta(false);
  }

  const conversaciones = convs.data ?? [];
  const convActiva: ResumenConversacion | null =
    conversaciones.find((c) => c.id === abiertaId) ?? null;
  const totalSinLeer = conversaciones.reduce((s, c) => s + c.sinLeer, 0);

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

          <div className="hd-tabs" ref={hdTabsRef}>
            <button
              type="button"
              className={"hd-tab" + (vista === "inbox" ? " activa" : "")}
              onClick={() => setVista("inbox")}
            >
              <Icono id="chat" size={15} />
              Inbox
              {totalSinLeer > 0 && (
                <span className="badge badge-naranja">{totalSinLeer}</span>
              )}
            </button>
            <button
              type="button"
              className={"hd-tab" + (vista === "panel" ? " activa" : "")}
              onClick={() => setVista("panel")}
            >
              <Icono id="dash" size={15} />
              Panel
            </button>
            <button
              type="button"
              className={"hd-tab" + (vista === "agenda" ? " activa" : "")}
              onClick={() => setVista("agenda")}
            >
              <Icono id="cal" size={15} />
              Agenda
            </button>
            {sesion.rol === "dueno" && (
              <button
                type="button"
                className={"hd-tab" + (vista === "config" ? " activa" : "")}
                onClick={() => setVista("config")}
              >
                <Icono id="gear" size={15} />
                Mi negocio
              </button>
            )}
            {sesion.rol === "dueno" && (
              <button
                type="button"
                className={"hd-tab" + (vista === "usuarios" ? " activa" : "")}
                onClick={() => setVista("usuarios")}
              >
                <Icono id="user" size={15} />
                Usuarios
              </button>
            )}
            {sesion.rol === "dueno" && (
              <button
                type="button"
                className={"hd-tab" + (vista === "campanias" ? " activa" : "")}
                onClick={() => setVista("campanias")}
              >
                <Icono id="send" size={15} />
                Campañas
              </button>
            )}
          </div>

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
              <Lista
                conversaciones={conversaciones}
                abiertaId={abiertaId}
                escondida={mostrarChatMovil}
                onAbrir={abrir}
              />
              <Chat
                id={abiertaId}
                resumen={convActiva}
                mostrar={mostrarChatMovil}
                onVolver={volver}
                onVerFicha={() => setFichaAbierta(true)}
              />
            </div>
          )}
          {vista === "panel" && <Dashboard nombre={sesion.nombre} />}
          {vista === "agenda" && <Agenda servicios={sesion.servicios} />}
          {vista === "config" && sesion.rol === "dueno" && <MiNegocio />}
          {vista === "usuarios" && sesion.rol === "dueno" && <Usuarios usuarioActualId={sesion.usuarioId} />}
          {vista === "campanias" && sesion.rol === "dueno" && <Campanias />}
        </div>
      </div>

      {fichaAbierta && abiertaId && convActiva && (
        <FichaModal
          convId={abiertaId}
          clienteWa={convActiva.clienteWa}
          onCerrar={() => setFichaAbierta(false)}
        />
      )}
    </ToastProvider>
  );
}
