import { usePush } from "../hooks/usePush";

// Campana de notificaciones del header. Se oculta si el navegador no soporta push
// o el server no tiene llave VAPID. "on" = suscripción activa.
export default function BotonNotif({ vapidPublica }: { vapidPublica: string | null }) {
  const push = usePush(vapidPublica);
  if (!push.disponible) return null;
  return (
    <button
      type="button"
      className={"btn-ghost btn-icono" + (push.activo ? " on" : "")}
      onClick={() => void push.activar()}
      title={push.titulo}
      aria-label="Activar notificaciones"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
    </button>
  );
}
