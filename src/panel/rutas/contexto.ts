import type { IncomingMessage, ServerResponse } from "node:http";
import type { Repositorio, Rol, Tenant } from "../../types";

/** Lo que recibe cada grupo de rutas del operador: la request y la sesión ya validada. */
export interface ContextoOperador {
  req: IncomingMessage;
  res: ServerResponse;
  repo: Repositorio;
  /** Ruta relativa a /api/panel/, sin barra final. */
  ruta: string;
  metodo: string;
  tenant: Tenant;
  usuarioId: string;
  rol: Rol;
}
