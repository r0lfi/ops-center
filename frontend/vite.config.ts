import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [react(), VitePWA({
    strategies: "injectManifest",
    srcDir: "src",
    filename: "sw.ts",
    injectRegister: false,
    registerType: "prompt",
    includeManifestIcons: false,
    injectManifest: {
      globPatterns: ["assets/**/*.{js,css,woff,woff2,png,jpg,jpeg,svg,gif,webp}", "icons/*.{png,svg}", "offline.{html,css,js}"],
      // The existing Three.js UI includes a large bundle; only build assets qualify.
      maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
    },
    manifest: {
      id: "/", name: "Ops Center", short_name: "Ops Center",
      description: "Infrastructure operations and AI agent control center",
      start_url: "/", scope: "/", display: "standalone", orientation: "any",
      theme_color: "#0b0e14", background_color: "#0b0e14",
      icons: [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
      shortcuts: [
        { name: "Dashboard", url: "/" }, { name: "Agents", url: "/ai-agents/agents" },
        { name: "Linux Ops", url: "/servers" }, { name: "Containers", url: "/containers" },
        { name: "Monitoring", url: "/monitoring" },
      ],
    },
  })],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { host: true, port: 5173 },
});
