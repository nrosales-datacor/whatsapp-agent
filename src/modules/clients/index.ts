// API pública del módulo clients: lo único que otros módulos pueden importar de acá
// (test/architecture/moduleBoundaries.test.ts). Por ahora, tipos; crece en I1.
export type { Client, ClientChannel, NewClient } from "./schema";
