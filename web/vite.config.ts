import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// ─────────────────────────────────────────────────────────────────────────────
// El panel se sirve bajo /panel, así que la base de los assets es "/panel/" (el
// index.html generado referencia /panel/assets/...). El server Node sirve el build de
// `dist/` en esa ruta (ver src/platform/http/staticPanel.ts).
//
// En desarrollo se corre `npm run dev` acá (Vite, puerto 5173) y las llamadas a /api se
// proxyan al backend (PORT 3000 por defecto): mismo origen lógico, mismas cookies.
//
// Modo mock (`npm run dev:mock`, o VITE_MOCK_API=1): el panel responde con la API
// simulada de src/lib/mockApi.ts y no hace falta backend; sin proxy a /api, así una
// llamada real por error falla a la vista en vez de pegarle a otro server.
//
// IMPORTANTE — `changeOrigin: false`: el backend tiene un chequeo anti-CSRF que exige que
// el header `Origin` coincida con el `Host` (isSameOrigin en src/platform/http/http.ts).
// Con `changeOrigin: true` el proxy reescribiría el Host a "localhost:3000" mientras el
// navegador manda Origin "localhost:5173" → no coinciden → 403 al hacer login.
// ─────────────────────────────────────────────────────────────────────────────

// Ayudas del server de desarrollo:
//   • Fuentes self-hosted del backend (las baja scripts/fetchFonts.mjs): Vite las sirve
//     directo desde esa carpeta (vía /@fs/, permitida en server.fs.allow), con o sin
//     backend corriendo; el middleware solo reescribe la URL.
//   • "/panel" sin barra → "/panel/": el router genera "/panel" para el inicio y el server
//     de Vite solo atiende la base con barra (el backend acepta las dos).
const FONTS_DIR = "../src/platform/http/fonts";
const FONTS_FS_PATH = new URL(`${FONTS_DIR}/`, import.meta.url).pathname;

function devServerHelpers(): Plugin {
  return {
    name: "selyon-dev-server-helpers",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        const base = /^\/panel(\?.*)?$/.exec(url);
        if (base) {
          res.statusCode = 302;
          res.setHeader("Location", `/panel/${base[1] ?? ""}`);
          res.end();
          return;
        }
        const font = /^\/panel\/fonts\/([A-Za-z0-9-]+\.(?:woff2|ttf))(?:\?.*)?$/.exec(url);
        if (font) req.url = `/panel/@fs${FONTS_FS_PATH}${font[1]}`;
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // loadEnv también trae las VITE_* del entorno del proceso (VITE_MOCK_API=1 npm run dev).
  const mock = loadEnv(mode, ".", "VITE_").VITE_MOCK_API === "1";

  return {
    plugins: [
      react(),
      devServerHelpers(),
      // ── PWA (instalable + push) ──
      // injectManifest: NUESTRO service worker (src/sw.ts) con los handlers de push;
      // `injectionPoint: undefined` => sin precache (passthrough). El plugin inyecta el
      // <link rel=manifest>. `injectRegister: false`: el registro lo hace la app (main.tsx
      // con lib/push.ts). devOptions off: el SW se prueba en el build.
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
      fs: { allow: [".", FONTS_DIR] },
      proxy: mock ? undefined : { "/api": { target: "http://localhost:3000", changeOrigin: false } },
    },
  };
});
