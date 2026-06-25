import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// ─────────────────────────────────────────────────────────────────────────────
// El panel se sirve bajo /panel, así que la base de los assets debe ser "/panel/"
// (el index.html generado referencia /panel/assets/...). El server Node sirve el
// build de `dist/` en esa ruta (ver src/panel/router.ts).
//
// En desarrollo se corre `npm run dev` acá (Vite, puerto 5173) y las llamadas a
// /api se proxyan al server del bot (PORT 3000 por defecto). Así el frontend tiene
// HMR y comparte cookies/sesión con el backend al estar en el mismo origen lógico.
// ─────────────────────────────────────────────────────────────────────────────
export default defineConfig({
  plugins: [react()],
  base: "/panel/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
});
