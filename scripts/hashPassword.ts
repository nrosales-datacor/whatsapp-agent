import { hashPassword } from "../src/platform/auth/password";

// Genera el hash scrypt ("salt:hash") de una contraseña, p. ej. para PANEL_SUPERADMIN_HASH.
//   Uso:  npx tsx scripts/hashPassword.ts "MiContraseñaSegura"

const password = process.argv[2];
if (!password) {
  console.error('Uso: npx tsx scripts/hashPassword.ts "TU_CONTRASEÑA"');
  process.exit(1);
}
console.log(await hashPassword(password));
