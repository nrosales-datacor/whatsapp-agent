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
//
// IMPORTANTE — `changeOrigin: false`: el backend tiene un chequeo anti-CSRF que
// exige que el header `Origin` coincida con el `Host` (ver mismoOrigen en
// src/panel/router.ts). Con `changeOrigin: true` el proxy reescribiría el Host a
// "localhost:3000" mientras el navegador manda Origin "localhost:5173" → no
// coinciden → el backend responde 403 al hacer login. Dejándolo en false, el Host
// reenviado sigue siendo "localhost:5173" y coincide con el Origin.
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
      "/api": { target: "http://localhost:3000", changeOrigin: false },
      // Las fuentes self-hosted las sirve el backend en /panel/fonts/*; en dev las
      // proxyamos para que el panel luzca con sus tipografías (no solo system-ui).
      "/panel/fonts": { target: "http://localhost:3000", changeOrigin: false },
    },
  },
});
