import crypto from "node:crypto";
import { decodeBase32, encodeBase32, otpauthUri, totp } from "../src/platform/auth/totp";
import { PRODUCT_NAME } from "../src/platform/brand";

// Genera el secreto TOTP (segundo factor) del superadmin del panel.
//   Uso:  npx tsx scripts/generateTotp.ts [cuenta]      (cuenta por defecto: "admin")
//
// Imprime:
//   • PANEL_SUPERADMIN_TOTP_SECRET=...  → pegalo en el .env del servidor y reiniciá (pm2 restart).
//   • la URI otpauth://                 → cargala en la app autenticadora (Google Authenticator,
//                                          Authy, 1Password, Bitwarden…): convertila en QR con un
//                                          generador OFFLINE, o cargá el secreto a mano ("Ingresar
//                                          clave de configuración", tipo "basada en tiempo").
//   • el código vigente                 → para comprobar que la app muestra lo mismo.
//
// El secreto es tan sensible como la clave del superadmin: no lo mandes por chat ni lo
// subas al repo. Si se filtra, generá uno nuevo y reemplazalo en el .env.

const account = process.argv[2] || "admin";
const secret = encodeBase32(crypto.randomBytes(20)); // 160 bits, lo que recomienda RFC 4226

console.log("\nAgregá esto al .env del servidor:\n");
console.log(`PANEL_SUPERADMIN_TOTP_SECRET=${secret}\n`);
console.log("URI para la app autenticadora (QR o carga manual):\n");
console.log(`${otpauthUri(secret, account, `${PRODUCT_NAME} Admin`)}\n`);
// Se recalcula desde el base32 (misma ruta que usa el login) para verificar contra la app.
console.log(`Código vigente (tiene que coincidir con la app): ${totp(decodeBase32(secret)!, Date.now())}\n`);
