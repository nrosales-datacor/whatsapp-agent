// ─────────────────────────────────────────────────────────────────────────────
// Modo mock del panel (`VITE_MOCK_API=1`, ver lib/mockApi.ts). Vive aparte de lib/api.ts
// para que el cliente de la API no lea `import.meta.env` al cargarse: así api.ts se puede
// importar fuera de Vite (los tests de test/unit corren con tsx en Node, donde
// `import.meta.env` no existe). Vite reemplaza la variable en compilación, así que en el
// build normal esto es `false` y las ramas del mock (y el mock mismo) no viajan en el bundle.
// ─────────────────────────────────────────────────────────────────────────────

export const IS_MOCK_API = import.meta.env.VITE_MOCK_API === "1";
