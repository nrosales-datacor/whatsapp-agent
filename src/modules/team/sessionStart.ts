import type { ServerResponse } from "node:http";
import type { SessionClaims } from "../../platform/auth/sessionToken";
import type { Executor } from "../../platform/db/scope";
import { HttpError } from "../../platform/http/errors";
import type { PlanHooks } from "../../platform/plan/planHooks";
import { buildMe, type Me } from "./me";
import { loadSession, setSessionCookie } from "./session";

/**
 * Deja una sesión nueva (cookie `panel_session`) y devuelve su `me`. Lo usan el login, el
 * cambio de negocio, aceptar una invitación y verificar el correo del alta self-service.
 * 401 si los claims ya no valen (la cuenta o la membresía se desactivaron en el medio).
 */
export async function startPanelSession(db: Executor, res: ServerResponse, claims: SessionClaims, plans: Pick<PlanHooks, "snapshot">): Promise<Me> {
  const session = await loadSession(db, claims);
  if (!session) throw new HttpError(401, "Tu sesión no es válida o venció. Iniciá sesión de nuevo.", "unauthorized");
  setSessionCookie(res, claims);
  return buildMe(db, session, plans);
}
