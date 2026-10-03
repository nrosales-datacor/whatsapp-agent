// Activa Web Push en el proceso de test con un par VAPID efímero y permite capturar
// lo que se le mandaría al operador SIN red: se importa ANTES que cualquier módulo
// del server (src/panel/push.ts lee las llaves al cargar), justo después de setupEnv.
//
// Existe porque el contenido de un aviso al operador (nombre de archivo, nombre de un
// contacto, texto del cliente) ya NO se escribe en los logs (datos personales, ver
// src/observabilidad/privacidad.ts): los tests lo verifican en el payload del push.
import { mock } from "node:test";
import webpush from "web-push";

const llaves = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = llaves.publicKey;
process.env.VAPID_PRIVATE_KEY = llaves.privateKey;
process.env.VAPID_SUBJECT = "mailto:test@example.com";

/**
 * Suscripción de prueba (el envío real está mockeado, nunca sale a la red). Desde G15
 * el push solo llega a suscripciones atadas a un usuario activo del negocio con el mismo
 * sessionEpoch: `registrarOperadorDePrueba` da de alta esa cuenta en el caché.
 */
export const SUSCRIPCION_PRUEBA = {
  endpoint: "https://fcm.googleapis.com/fcm/send/prueba-1", // host de la allowlist (G15)
  p256dh: "p256dh-prueba",
  auth: "auth-prueba",
  usuarioId: "usuario-push-prueba",
  sessionEpoch: 0,
};

/** Registra en el caché del tenantStore al operador dueño de SUSCRIPCION_PRUEBA. */
export async function registrarOperadorDePrueba(tenantId: string): Promise<void> {
  const { _registrarUsuarioParaTests } = await import("../../src/config/tenantStore");
  _registrarUsuarioParaTests("operador-push-prueba", {
    id: SUSCRIPCION_PRUEBA.usuarioId,
    tenantId,
    passwordHash: "x",
    rol: "operador",
    debeCambiarClave: false,
    claveTemporalExpira: null,
    activo: true,
    sessionEpoch: SUSCRIPCION_PRUEBA.sessionEpoch,
  });
}

/** Reemplaza webpush.sendNotification y devuelve los payloads (JSON) que se intentaron enviar. */
export function capturarPushes(): { payloads: string[]; restaurar: () => void } {
  const payloads: string[] = [];
  const espia = mock.method(webpush, "sendNotification", async (_sub: unknown, cuerpo: unknown) => {
    payloads.push(String(cuerpo));
    return { statusCode: 201, body: "", headers: {} };
  });
  return { payloads, restaurar: () => espia.mock.restore() };
}
