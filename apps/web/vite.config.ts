import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

// `pnpm -C apps/web dev` talks to a running `factory serve`. The server only takes changes that
// carry its own Origin, so the proxy presents them as coming from it.
const SERVER = process.env.FACTORY_SERVE_URL ?? "http://127.0.0.1:4180";

const toServer: ProxyOptions = {
  target: SERVER,
  changeOrigin: true,
  configure: (proxy) => {
    proxy.on("proxyReq", (req) => req.setHeader("origin", SERVER));
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": toServer,
      // The printed link, opened on the dev server's port: the server sets the session cookie,
      // which the browser then sends to any port of the same host.
      "^/\\?token=": toServer,
    },
  },
});
