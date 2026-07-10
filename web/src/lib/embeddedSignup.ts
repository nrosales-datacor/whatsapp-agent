// ─────────────────────────────────────────────────────────────────────────────
// Embedded Signup de Meta en el frontend (ROADMAP C4.2). Carga el SDK de Facebook
// una sola vez y lanza el popup de "FB Login for Business" con nuestra configuración
// de ES. Del flujo salen DOS piezas que llegan por caminos distintos:
//   • el `code` de autorización → por el callback de FB.login,
//   • el phone_number_id + waba_id → por el evento `message` del SDK (sessionInfo).
// Esta función las junta y resuelve con las tres. El backend (/admin/embedded-signup/
// conectar) canjea el code por el token y suscribe/registra el número.
//
// Sin META_APP_ID/config (el backend responde `configurado:false`), este módulo ni se
// usa: el onboarding cae al formulario manual de siempre.
// ─────────────────────────────────────────────────────────────────────────────

export interface EsConfig {
  appId: string;
  configId: string;
  graphVersion: string;
}

export interface EsResultado {
  code: string;
  phoneNumberId: string;
  wabaId: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FB = any;
declare global {
  interface Window {
    FB?: FB;
    fbAsyncInit?: () => void;
  }
}

let sdkCargado: Promise<void> | null = null;

/** Carga connect.facebook.net/en_US/sdk.js e inicializa FB (idempotente). */
function cargarSdk(cfg: EsConfig): Promise<void> {
  if (sdkCargado) return sdkCargado;
  sdkCargado = new Promise<void>((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB.init({ appId: cfg.appId, autoLogAppEvents: true, xfbml: false, version: cfg.graphVersion });
      resolve();
    };
    const s = document.createElement("script");
    s.src = "https://connect.facebook.net/en_US/sdk.js";
    s.async = true;
    s.defer = true;
    s.crossOrigin = "anonymous";
    s.onerror = () => {
      sdkCargado = null; // permitir reintento en el próximo click
      reject(new Error("No se pudo cargar el SDK de Facebook (¿bloqueado por la red o un ad-blocker?)."));
    };
    document.body.appendChild(s);
  });
  return sdkCargado;
}

/**
 * Abre el popup de Embedded Signup y resuelve con { code, phoneNumberId, wabaId }.
 * Rechaza si el usuario cancela, si Meta reporta un error, o si no llegan las dos
 * piezas (code + sessionInfo) — casos en los que no hay una conexión completa.
 */
export function lanzarEmbeddedSignup(cfg: EsConfig): Promise<EsResultado> {
  return cargarSdk(cfg).then(
    () =>
      new Promise<EsResultado>((resolve, reject) => {
        let code: string | null = null;
        let sesion: { phoneNumberId: string; wabaId: string } | null = null;
        let terminado = false;

        const finalizar = () => {
          if (terminado) return;
          if (code && sesion) {
            terminado = true;
            window.removeEventListener("message", onMessage);
            resolve({ code, phoneNumberId: sesion.phoneNumberId, wabaId: sesion.wabaId });
          }
        };

        const abortar = (msg: string) => {
          if (terminado) return;
          terminado = true;
          window.removeEventListener("message", onMessage);
          reject(new Error(msg));
        };

        function onMessage(event: MessageEvent) {
          if (!/^https:\/\/([a-z]+\.)?facebook\.com$/.test(event.origin)) return;
          let data: { type?: string; event?: string; data?: { phone_number_id?: string; waba_id?: string } };
          try {
            data = JSON.parse(event.data);
          } catch {
            return; // el SDK también manda mensajes no-JSON; los ignoramos
          }
          if (data.type !== "WA_EMBEDDED_SIGNUP") return;
          if (data.event === "FINISH") {
            sesion = {
              phoneNumberId: String(data.data?.phone_number_id ?? ""),
              wabaId: String(data.data?.waba_id ?? ""),
            };
            finalizar();
          } else if (data.event === "CANCEL") {
            abortar("Conexión cancelada.");
          } else {
            abortar("Meta reportó un error durante la conexión.");
          }
        }

        window.addEventListener("message", onMessage);

        window.FB.login(
          (resp: { authResponse?: { code?: string }; status?: string }) => {
            if (resp.authResponse?.code) {
              code = resp.authResponse.code;
              finalizar();
            } else {
              abortar("No se autorizó la conexión.");
            }
          },
          {
            config_id: cfg.configId,
            response_type: "code",
            override_default_response_type: true,
            extras: { setup: {}, featureType: "", sessionInfoVersion: "3" },
          },
        );
      }),
  );
}
