import { and, asc, eq, max } from "drizzle-orm";
import { z } from "zod";
import { recordConfigChange } from "../../platform/audit/configHistory";
import { hasPgCode, PG_UNIQUE_VIOLATION } from "../../platform/db/errors";
import { isTenantId, withTenant, type Executor, type Tx } from "../../platform/db/scope";
import { assertSameIds } from "../../platform/http/access";
import { HttpError, ValidationError } from "../../platform/http/errors";
import type { Session } from "../../platform/http/routeTypes";
import { paymentMethods, payments, type PaymentMethod } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Métodos de pago (Configuración › Métodos de pago, plan Pro).
//
//   • El negocio nace con los cuatro de siempre (`DEFAULT_PAYMENT_METHODS`): los carga el
//     alta (`seedDefaultPaymentMethods`, inyectado como paso de `createBusiness` desde la
//     composición: business no conoce a sales) y el seed de desarrollo.
//   • Se ordenan (`position`) y se desactivan: un método inactivo no se ofrece al cobrar,
//     pero sigue en los movimientos y el resumen del día.
//   • Borrar uno que ya tiene pagos lo desactiva (los pagos lo referencian).
//   • Nombre único por negocio (sin distinguir mayúsculas: lo frena la app; la base frena
//     el nombre idéntico).
// ─────────────────────────────────────────────────────────────────────────────

/** Los métodos con los que nace todo negocio, en este orden. */
export const DEFAULT_PAYMENT_METHODS: readonly string[] = ["Efectivo", "SINPE Móvil", "Tarjeta", "Transferencia"];

export interface PaymentMethodView {
  id: string;
  name: string;
  active: boolean;
  position: number;
}

export const PaymentMethodName = z.string().trim().min(1, "Escribí el nombre.").max(60);

export const NewPaymentMethodInput = z.object({ name: PaymentMethodName }).strict();

export const PaymentMethodPatch = z
  .object({ name: PaymentMethodName, active: z.boolean() })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: "Indicá qué cambiar." });

export const PaymentMethodOrderInput = z.object({ ids: z.array(z.uuid()).max(100) }).strict();

const notFound = () => new HttpError(404, "Ese método de pago no existe.", "not_found");
const duplicateName = () => new ValidationError({ "body.name": "Ya hay un método de pago con ese nombre." });

export function toPaymentMethodView(m: PaymentMethod): PaymentMethodView {
  return { id: m.id, name: m.name, active: m.active, position: m.position };
}

async function readMethods(tx: Tx, businessId: string): Promise<PaymentMethodView[]> {
  const rows = await tx
    .select()
    .from(paymentMethods)
    .where(eq(paymentMethods.businessId, businessId))
    .orderBy(asc(paymentMethods.position), asc(paymentMethods.createdAt));
  return rows.map(toPaymentMethodView);
}

/**
 * Carga los métodos default en un negocio recién creado. Idempotente: no duplica los que
 * ya estén (por nombre). Es el `seedPaymentMethods` de `ProvisioningSteps`.
 */
export async function seedDefaultPaymentMethods(executor: Executor, input: { businessId: string }): Promise<PaymentMethodView[]> {
  const { businessId } = input;
  return withTenant(executor, businessId, async (tx) => {
    await tx
      .insert(paymentMethods)
      .values(DEFAULT_PAYMENT_METHODS.map((name, position) => ({ businessId, name, position })))
      .onConflictDoNothing();
    return readMethods(tx, businessId);
  });
}

/** Métodos del negocio en su orden (`activeOnly`: solo los que se ofrecen al cobrar). */
export async function listPaymentMethods(executor: Executor, businessId: string, options: { activeOnly?: boolean } = {}): Promise<PaymentMethodView[]> {
  const all = await withTenant(executor, businessId, (tx) => readMethods(tx, businessId));
  return options.activeOnly ? all.filter((m) => m.active) : all;
}

/** Un método del negocio, o null. */
export async function getPaymentMethod(executor: Executor, businessId: string, methodId: string): Promise<PaymentMethodView | null> {
  if (!isTenantId(methodId)) return null;
  const [row] = await withTenant(executor, businessId, (tx) =>
    tx
      .select()
      .from(paymentMethods)
      .where(and(eq(paymentMethods.businessId, businessId), eq(paymentMethods.id, methodId)))
      .limit(1),
  );
  return row ? toPaymentMethodView(row) : null;
}

/** ¿Otro método del negocio ya se llama así (sin distinguir mayúsculas)? */
async function assertUniqueName(tx: Tx, businessId: string, name: string, exceptId?: string): Promise<void> {
  const wanted = name.toLocaleLowerCase("es");
  const clash = (await readMethods(tx, businessId)).some((m) => m.id !== exceptId && m.name.toLocaleLowerCase("es") === wanted);
  if (clash) throw duplicateName();
}

async function record(tx: Tx, session: Session, entityId: string, snapshot: unknown): Promise<void> {
  await recordConfigChange(tx, { businessId: session.businessId, entity: "payment_method", entityId, snapshot, changedBy: session.userId });
}

function rethrowDuplicate(error: unknown): never {
  if (hasPgCode(error, PG_UNIQUE_VIOLATION)) throw duplicateName();
  throw error;
}

export async function createPaymentMethod(db: Executor, session: Session, name: string): Promise<PaymentMethodView> {
  const { businessId } = session;
  return withTenant(db, businessId, async (tx) => {
    await assertUniqueName(tx, businessId, name);
    const [{ last }] = await tx.select({ last: max(paymentMethods.position) }).from(paymentMethods).where(eq(paymentMethods.businessId, businessId));
    const [row] = await tx
      .insert(paymentMethods)
      .values({ businessId, name, position: (last ?? -1) + 1 })
      .returning()
      .catch(rethrowDuplicate);
    const view = toPaymentMethodView(row);
    await record(tx, session, view.id, view);
    return view;
  });
}

export async function updatePaymentMethod(
  db: Executor,
  session: Session,
  methodId: string,
  patch: { name?: string; active?: boolean },
): Promise<PaymentMethodView> {
  const { businessId } = session;
  return withTenant(db, businessId, async (tx) => {
    if (patch.name !== undefined) await assertUniqueName(tx, businessId, patch.name, methodId);
    const [row] = await tx
      .update(paymentMethods)
      .set(patch)
      .where(and(eq(paymentMethods.businessId, businessId), eq(paymentMethods.id, methodId)))
      .returning()
      .catch(rethrowDuplicate);
    if (!row) throw notFound();
    const view = toPaymentMethodView(row);
    await record(tx, session, view.id, view);
    return view;
  });
}

export async function reorderPaymentMethods(db: Executor, session: Session, ids: readonly string[]): Promise<PaymentMethodView[]> {
  const { businessId } = session;
  return withTenant(db, businessId, async (tx) => {
    const current = await tx
      .select({ id: paymentMethods.id })
      .from(paymentMethods)
      .where(eq(paymentMethods.businessId, businessId))
      .orderBy(asc(paymentMethods.id))
      .for("update");
    assertSameIds(
      current.map((r) => r.id),
      ids,
    );
    for (const [position, id] of ids.entries()) {
      await tx
        .update(paymentMethods)
        .set({ position })
        .where(and(eq(paymentMethods.businessId, businessId), eq(paymentMethods.id, id.toLowerCase())));
    }
    await recordConfigChange(tx, {
      businessId,
      entity: "payment_methods_order",
      entityId: businessId,
      snapshot: { ids: ids.map((id) => id.toLowerCase()) },
      changedBy: session.userId,
    });
    return readMethods(tx, businessId);
  });
}

export type DeletePaymentMethodResult = { deleted: true } | { deleted: false; method: PaymentMethodView };

/** Borra el método; si ya tiene pagos, lo desactiva (los pagos lo referencian). */
export async function deletePaymentMethod(db: Executor, session: Session, methodId: string): Promise<DeletePaymentMethodResult> {
  const { businessId } = session;
  return withTenant(db, businessId, async (tx) => {
    const [current] = await tx
      .select()
      .from(paymentMethods)
      .where(and(eq(paymentMethods.businessId, businessId), eq(paymentMethods.id, methodId)))
      .for("update");
    if (!current) throw notFound();
    const [used] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.businessId, businessId), eq(payments.paymentMethodId, current.id)))
      .limit(1);
    if (used) {
      const [row] = await tx.update(paymentMethods).set({ active: false }).where(eq(paymentMethods.id, current.id)).returning();
      const method = toPaymentMethodView(row);
      await record(tx, session, method.id, { ...method, deactivatedInsteadOfDeleted: true });
      return { deleted: false, method };
    }
    await tx.delete(paymentMethods).where(eq(paymentMethods.id, current.id));
    await record(tx, session, current.id, { ...toPaymentMethodView(current), deleted: true });
    return { deleted: true };
  });
}
