/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" = el panel usa la API simulada de lib/mockApi.ts (sin backend). */
  readonly VITE_MOCK_API?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
