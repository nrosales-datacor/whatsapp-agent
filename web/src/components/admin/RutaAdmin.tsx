import { useQuery } from "@tanstack/react-query";
import { adminMe } from "../../api";
import AdminLogin from "./AdminLogin";
import Onboarding from "./Onboarding";

// Compuerta del superadmin: sesión en ["adminMe"] (aparte de la del operador, ["me"]).
// Un 401 en /admin/* la pone en null (ver main.tsx) → cae al login de admin.
export default function RutaAdmin() {
  const sesion = useQuery({ queryKey: ["adminMe"], queryFn: adminMe });
  if (sesion.isLoading) return null;
  if (!sesion.data) return <AdminLogin />;
  return <Onboarding sesion={sesion.data} />;
}
