import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

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
  plugins: [
    react(),
    // ── PWA (instalable + push) ──
    // Estrategia injectManifest: usamos NUESTRO service worker (src/sw.ts) para tener
    // los handlers de push/notificationclick; `injectionPoint: undefined` => no precache
    // (passthrough, igual que el panel anterior). El plugin inyecta el <link rel=manifest>
    // en el index. `injectRegister: false`: registramos el SW a mano en usePush (control
    // del flujo de permisos). devOptions off: el SW se prueba en el build (ver A6/preview).
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectRegister: false,
      injectManifest: { injectionPoint: undefined },
      manifest: {
        name: "Selyon CRM",
        short_name: "Selyon CRM",
        description: "Agenda, clientes y WhatsApp de tu negocio en un solo lugar.",
        start_url: "/panel/",
        scope: "/panel/",
        display: "standalone",
        orientation: "portrait-primary",
        lang: "es",
        dir: "ltr",
        background_color: "#F6F8F9",
        theme_color: "#0B6B5E",
        categories: ["business", "productivity"],
        icons: [
          { src: "/panel/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/panel/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/panel/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
          { src: "/panel/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
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
