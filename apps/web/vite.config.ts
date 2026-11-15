import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `pnpm -C apps/web dev` talks to a running `factory serve`; open its printed link with Vite's port
// instead. The server only takes changes that carry its own Origin, so the proxy presents the dev
// page's own requests as coming from it, and only those: another site's stay foreign.
const SERVER = process.env.FACTORY_SERVE_URL ?? "http://127.0.0.1:4180";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": {
        target: SERVER,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            if (req.headers.origin === `http://${req.headers.host}`) proxyReq.setHeader("origin", SERVER);
          });
        },
      },
    },
  },
});
