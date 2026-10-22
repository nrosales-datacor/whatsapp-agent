// API pública del módulo sales: lo único que otros módulos (y la composición en src/) pueden
// importar de acá (test/architecture/moduleBoundaries.test.ts). Métodos de pago, pagos y
// señas, devoluciones, saldos, pendientes, caja del día y los totales cobrados que usan las
// comisiones (lo cobrado de una cita) y los reportes de I5.
export {
  DEFAULT_PAYMENT_METHODS,
  getPaymentMethod,
  listPaymentMethods,
  seedDefaultPaymentMethods,
} from "./paymentMethods";
export type { DeletePaymentMethodResult, PaymentMethodView } from "./paymentMethods";
export {
  getAppointmentBalance,
  getAppointmentCollected,
  getCollectedByAppointment,
  getDailySummary,
  getPayment,
  listPayments,
  listPendingBalances,
  MAX_AMOUNT_CENTS,
  netOf,
  recordAppointmentPayment,
  recordClientPayment,
  refundPayment,
} from "./payments";
export type {
  AppointmentBalance,
  AppointmentPaymentInput,
  ClientPaymentInput,
  CollectedSums,
  DailySummary,
  ListPaymentsFilter,
  MethodSummary,
  PaymentList,
  PaymentsChangedHook,
  PaymentTotals,
  PaymentView,
  PendingItem,
  PendingList,
  RecordedPayment,
  RecordedRefund,
  RefundInput,
} from "./payments";
export { salesRoutes, type SalesRouteDeps } from "./routes";
export { getCollectedTotals, prorateByPrice } from "./totals";
export type { CollectedGroup, CollectedGroupBy, CollectedTotals, CollectedTotalsInput } from "./totals";
export { PAYMENT_KINDS } from "./schema";
export type { NewPayment, NewPaymentMethod, Payment, PaymentKind, PaymentMethod } from "./schema";
