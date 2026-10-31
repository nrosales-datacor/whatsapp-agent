import { and, desc, eq } from "drizzle-orm";
import type { Role } from "../../platform/auth/sessionToken";
import { recordAudit, userActor } from "../../platform/audit/auditLog";
import { withTenant, type Executor } from "../../platform/db/scope";
import { HttpError } from "../../platform/http/errors";
import type { Session } from "../../platform/http/routeTypes";
import { currentLegalVersion, currentLegalVersions, legalAcceptanceOutdated, type LegalVersions } from "../../platform/legal";
import { legalAcceptances, type LegalAcceptanceContext } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Aceptación de términos y aviso de privacidad (Carril P, "privacidad y términos").
//
//   • Alta self-service (src/signup.ts) y aceptar una invitación: la aceptación se guarda
//     en la MISMA transacción que la cuenta (o quedan las dos cosas, o ninguna).
//   • `me.legal` le dice al panel si la persona tiene que aceptar la versión vigente
//     (nunca aceptó en este negocio, o lo que aceptó es más viejo que `LEGAL_VERSION`).
//   • `POST /auth/legal/accept` (el aviso del panel) registra la versión vigente. Manda la
//     versión que la persona tuvo a la vista: si mientras tanto cambió, 409 y el panel
//     recarga (nadie "acepta" un texto que no vio).
//
// Cada aceptación deja su fila en `legal_acceptances` y su entrada `legal_accepted` en
// `audit_log` (sin datos personales: rol, contexto y versiones).
// ─────────────────────────────────────────────────────────────────────────────

export interface LegalAcceptanceRecord extends LegalVersions {
  acceptedAt: Date;
}

/** Lo que el panel necesita para decidir si muestra el aviso (`me.legal`). */
export interface LegalStatus {
  /** Versión vigente de los documentos (`LEGAL_VERSION`). */
  version: string;
  /** Lo último que aceptó esta persona en este negocio (null = nunca). */
  accepted: { termsVersion: string; privacyVersion: string; acceptedAt: string } | null;
  /** true = el panel le pide aceptar la versión vigente. */
  mustAccept: boolean;
}

/**
 * Guarda que la persona aceptó la versión VIGENTE, con su rastro de auditoría. Corre en el
 * executor del llamador (la transacción del alta o de la invitación).
 */
export async function recordLegalAcceptance(
  executor: Executor,
  input: { businessId: string; userId: string; role: Role; context: LegalAcceptanceContext; at?: Date },
): Promise<LegalAcceptanceRecord> {
  const versions = currentLegalVersions();
  const acceptedAt = input.at ?? new Date();
  await withTenant(executor, input.businessId, (tx) =>
    tx.insert(legalAcceptances).values({
      businessId: input.businessId,
      userId: input.userId,
      role: input.role,
      context: input.context,
      ...versions,
      acceptedAt,
    }),
  );
  await recordAudit(executor, input.businessId, "legal_accepted", userActor(input.userId), {
    context: input.context,
    role: input.role,
    ...versions,
  });
  return { ...versions, acceptedAt };
}

/** Última aceptación de la persona en el negocio (null = nunca aceptó). */
export async function latestLegalAcceptance(db: Executor, businessId: string, userId: string): Promise<LegalAcceptanceRecord | null> {
  const [row] = await withTenant(db, businessId, (tx) =>
    tx
      .select({
        termsVersion: legalAcceptances.termsVersion,
        privacyVersion: legalAcceptances.privacyVersion,
        acceptedAt: legalAcceptances.acceptedAt,
      })
      .from(legalAcceptances)
      .where(and(eq(legalAcceptances.businessId, businessId), eq(legalAcceptances.userId, userId)))
      .orderBy(desc(legalAcceptances.acceptedAt))
      .limit(1),
  );
  return row ?? null;
}

function toStatus(accepted: LegalAcceptanceRecord | null): LegalStatus {
  return {
    version: currentLegalVersion(),
    accepted: accepted
      ? { termsVersion: accepted.termsVersion, privacyVersion: accepted.privacyVersion, acceptedAt: accepted.acceptedAt.toISOString() }
      : null,
    mustAccept: legalAcceptanceOutdated(accepted),
  };
}

export async function getLegalStatus(db: Executor, businessId: string, userId: string): Promise<LegalStatus> {
  return toStatus(await latestLegalAcceptance(db, businessId, userId));
}

/**
 * El aviso del panel: acepta la versión vigente. `version` es la que la persona tuvo a la
 * vista; si ya no es la vigente → 409 `legal_version_changed`. Si ya estaba al día no
 * agrega otra fila (reintentos o dos pestañas).
 */
export async function acceptCurrentLegal(db: Executor, session: Session, version: string): Promise<LegalStatus> {
  if (version !== currentLegalVersion()) {
    throw new HttpError(409, "Los documentos se actualizaron mientras los leías. Recargá la página y volvé a aceptarlos.", "legal_version_changed");
  }
  const latest = await latestLegalAcceptance(db, session.businessId, session.userId);
  if (!legalAcceptanceOutdated(latest)) return toStatus(latest);
  const record = await withTenant(db, session.businessId, (tx) =>
    recordLegalAcceptance(tx, { businessId: session.businessId, userId: session.userId, role: session.role, context: "reacceptance" }),
  );
  return toStatus(record);
}
