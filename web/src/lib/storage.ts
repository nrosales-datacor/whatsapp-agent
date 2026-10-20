// ─────────────────────────────────────────────────────────────────────────────
// Acceso a localStorage/sessionStorage que nunca rompe la app: en una ventana privada,
// con los datos del sitio bloqueados o con la cuota llena, el accessor puede tirar una
// excepción o devolver null. Todo lo que se guarda acá es una comodidad (tema, sucursal
// elegida); la app tiene que funcionar igual sin esto.
// ─────────────────────────────────────────────────────────────────────────────

type StorageKind = "local" | "session";

function getStorage(kind: StorageKind): Storage | null {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readStorage(key: string, kind: StorageKind = "local"): string | null {
  try {
    return getStorage(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string, kind: StorageKind = "local"): void {
  try {
    getStorage(kind)?.setItem(key, value);
  } catch {
    // Sin almacenamiento disponible: se pierde la preferencia, nada más.
  }
}

export function removeStorage(key: string, kind: StorageKind = "local"): void {
  try {
    getStorage(kind)?.removeItem(key);
  } catch {
    // Ídem.
  }
}
