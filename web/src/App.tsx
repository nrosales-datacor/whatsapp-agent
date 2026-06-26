import { Route, Routes } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { me } from "./api";
import Login from "./components/Login";
import Panel from "./components/Panel";
import RutaAdmin from "./components/admin/RutaAdmin";

// Compuerta del operador (lo de siempre): la sesión vive en ["me"]; un 401 la pone en
// null (ver main.tsx) → se cae al login. Idéntico a antes de B3, ahora bajo la ruta "/".
function RutaOperador() {
  const sesion = useQuery({ queryKey: ["me"], queryFn: me });
  if (sesion.isLoading) return null;
  if (!sesion.data) return <Login />;
  return <Panel sesion={sesion.data} />;
}

// Rutas del panel (basename "/panel" lo pone main.tsx):
//   "/"       → operador (bandeja)
//   "/admin"  → superadmin (onboarding, ROADMAP B3)
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<RutaOperador />} />
      <Route path="/admin/*" element={<RutaAdmin />} />
      <Route path="*" element={<RutaOperador />} />
    </Routes>
  );
}
