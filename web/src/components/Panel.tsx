import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listarConversaciones, logout, type Sesion } from "../api";
import Lista from "./Lista";
import Chat from "./Chat";
import FichaModal from "./FichaModal";
import Dashboard from "./Dashboard";

// Ancho a partir del cual el panel pasa a layout de una columna (igual que el
// media query de global.css): en móvil, abrir un chat tapa la lista.
const ANCHO_MOVIL = 760;

// App autenticada: lista + chat lado a lado, con la ficha (modal) y el dashboard
// (overlay) por encima. El estado de "qué está abierto" vive acá; los datos los
// traen las queries de cada pantalla.
export default function Panel({ sesion }: { sesion: Sesion }) {
  const qc = useQueryClient();
  const [abiertaId, setAbiertaId] = useState<string | null>(null);
  const [mostrarChatMovil, setMostrarChatMovil] = useState(false);
  const [fichaAbierta, setFichaAbierta] = useState(false);
  const [dashAbierto, setDashAbierto] = useState(false);

  // Lista de conversaciones: se refresca sola cada 4s (reemplaza el setInterval).
  const convs = useQuery({
    queryKey: ["conversaciones"],
    queryFn: listarConversaciones,
    refetchInterval: 4000,
  });

  const salir = useMutation({
    mutationFn: logout,
    // Pase lo que pase con la red, cerramos sesión local: ["me"] a null → login.
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
  const convActiva = conversaciones.find((c) => c.id === abiertaId) ?? null;

  return (
    <>
      <div id="app">
        <Lista
          nombre={sesion.nombre}
          conversaciones={conversaciones}
          abiertaId={abiertaId}
          escondida={mostrarChatMovil}
          onAbrir={abrir}
          onPanel={() => setDashAbierto(true)}
          onSalir={() => salir.mutate()}
        />
        <Chat
          id={abiertaId}
          mostrar={mostrarChatMovil}
          onVolver={volver}
          onVerFicha={() => setFichaAbierta(true)}
        />
        {fichaAbierta && abiertaId && convActiva && (
          <FichaModal
            convId={abiertaId}
            clienteWa={convActiva.clienteWa}
            onCerrar={() => setFichaAbierta(false)}
          />
        )}
      </div>
      {dashAbierto && <Dashboard nombre={sesion.nombre} onCerrar={() => setDashAbierto(false)} />}
    </>
  );
}
