// API pública del módulo sales: lo único que otros módulos pueden importar de acá
// (test/architecture/moduleBoundaries.test.ts). Por ahora, tipos; crece en I4.
export type { NewPayment, NewPaymentMethod, Payment, PaymentKind, PaymentMethod } from "./schema";
