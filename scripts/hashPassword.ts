import { hashearPassword } from "../src/panel/auth";

// Genera el hash de una contraseña para el panel de un negocio.
//   Uso:  npx tsx scripts/hashPassword.ts "MiContraseñaSegura"
// Pegá el resultado en panelPasswordHash del tenant (src/config/tenants.ts).

const pw = process.argv[2];
if (!pw) {
  console.error('Uso: npx tsx scripts/hashPassword.ts "TU_CONTRASEÑA"');
  process.exit(1);
}
console.log(hashearPassword(pw));
