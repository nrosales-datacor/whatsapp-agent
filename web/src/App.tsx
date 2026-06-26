import { useQuery } from "@tanstack/react-query";
import { me } from "./api";
import Login from "./components/Login";
import Panel from "./components/Panel";

// Raíz del panel: decide entre login y app según haya sesión.
// La sesión vive en la query ["me"]; un 401 en cualquier lado la pone en null
// (ver main.tsx) → se cae al login sin lógica extra acá.
export default function App() {
  const sesion = useQuery({ queryKey: ["me"], queryFn: me });

  // Primer chequeo de sesión en curso: no parpadear login antes de saber.
  if (sesion.isLoading) return null;

  // Sin sesión (nunca entró, o expiró) → login.
  if (!sesion.data) return <Login />;

  return <Panel sesion={sesion.data} />;
}
