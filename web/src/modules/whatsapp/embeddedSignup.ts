// ─────────────────────────────────────────────────────────────────────────────
// Embedded Signup de Meta (conectar un número de WhatsApp desde el panel). Portado de
// legacy/web/src/lib/embeddedSignup.ts: carga el SDK de Facebook una sola vez y abre el
// popup de "Facebook Login for Business" con la configuración que da el backend
// (`GET /whatsapp/channels/signup-config`). Del flujo sale el `code` de autorización, que
// el backend canjea por el token y registra el número (`POST /whatsapp/channels/connect`).
//
// El SDK también avisa por `postMessage` (WA_EMBEDDED_SIGNUP) si la persona canceló o hubo
// un error: con eso se corta antes, con un mensaje claro.
//
// Privacidad: el SDK se carga SOLO al tocar "Conectar" (no en el resto del panel) y con
// `autoLogAppEvents: false`. Lo que hace Meta en su popup (sus cookies, en su dominio) lo
// rige la política de Meta; la nuestra lo menciona (landing/privacidad.html).
// ─────────────────────────────────────────────────────────────────────────────

import type { SignupConfig } from "./whatsappApi";

const SDK_URL = "https://connect.facebook.net/en_US/sdk.js";
const FLOW_TIMEOUT_MS = 120_000;

interface FacebookSdk {
  init: (options: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }) => void;
  login: (callback: (response: { authResponse?: { code?: string } | null }) => void, options: Record<string, unknown>) => void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

/** Error del flujo con un mensaje apto para mostrar. */
export class EmbeddedSignupError extends Error {}

let sdkLoading: Promise<FacebookSdk> | null = null;

function loadSdk(config: SignupConfig): Promise<FacebookSdk> {
  if (sdkLoading) return sdkLoading;
  sdkLoading = new Promise<FacebookSdk>((resolve, reject) => {
    window.fbAsyncInit = () => {
      if (!window.FB) {
        reject(new EmbeddedSignupError("No se pudo iniciar el SDK de Facebook."));
        return;
      }
      // autoLogAppEvents: false → el SDK no le manda a Meta eventos de uso del panel (el
      // Embedded Signup no los necesita; lo declara la política de privacidad, §SDK de Meta).
      window.FB.init({ appId: config.appId, autoLogAppEvents: false, xfbml: false, version: config.graphVersion });
      resolve(window.FB);
    };
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => {
      sdkLoading = null; // se puede reintentar en el próximo clic
      script.remove();
      reject(new EmbeddedSignupError("No se pudo cargar el SDK de Facebook. Revisá tu conexión o si un bloqueador de anuncios lo está frenando."));
    };
    document.body.appendChild(script);
  });
  return sdkLoading;
}

/**
 * Abre el popup de Meta y resuelve con el `code` de autorización. Rechaza (con
 * EmbeddedSignupError) si la persona cancela, si Meta reporta un error o si el flujo no
 * termina en un tiempo razonable.
 */
export async function launchEmbeddedSignup(config: SignupConfig): Promise<string> {
  const fb = await loadSdk(config);
  return new Promise<string>((resolve, reject) => {
    let finished = false;
    const timer = window.setTimeout(() => fail("La conexión con Meta tardó demasiado. Cerrá la ventana de Meta si sigue abierta y probá de nuevo."), FLOW_TIMEOUT_MS);

    function cleanup() {
      finished = true;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    }

    function fail(message: string) {
      if (finished) return;
      cleanup();
      reject(new EmbeddedSignupError(message));
    }

    function onMessage(event: MessageEvent) {
      if (!/^https:\/\/([a-z0-9-]+\.)?facebook\.com$/.test(event.origin)) return;
      let data: { type?: string; event?: string } | null = null;
      try {
        data = typeof event.data === "string" ? (JSON.parse(event.data) as { type?: string; event?: string }) : null;
      } catch {
        return; // el SDK también manda mensajes que no son JSON
      }
      if (data?.type !== "WA_EMBEDDED_SIGNUP") return;
      if (data.event === "CANCEL") fail("Cancelaste la conexión del número.");
      else if (data.event === "ERROR") fail("Meta reportó un error durante la conexión. Probá de nuevo.");
    }

    window.addEventListener("message", onMessage);
    fb.login(
      (response) => {
        const code = response.authResponse?.code;
        if (finished) return;
        if (!code) {
          fail("No se autorizó la conexión con Meta.");
          return;
        }
        cleanup();
        resolve(code);
      },
      {
        config_id: config.configId,
        response_type: "code",
        override_default_response_type: true,
        // featureType "" = alta normal, sin coexistencia: el número queda en la Cloud API y
        // deja de funcionar en la app de WhatsApp Business del celular.
        extras: { setup: {}, featureType: "", sessionInfoVersion: "3" },
      },
    );
  });
}
