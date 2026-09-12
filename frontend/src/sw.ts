/// <reference lib="webworker" />
import { setCacheNameDetails } from "workbox-core";
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from "workbox-precaching";
import { registerRoute } from "workbox-routing";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

setCacheNameDetails({ prefix: "ops-center", suffix: "static" });
// Only build-time assets and a data-free offline document. No runtime caches,
// cached index.html, API responses, auth state or queued/replayed commands.
precacheAndRoute(self.__WB_MANIFEST, {
  ignoreURLParametersMatching: [],
  directoryIndex: "",
  cleanURLs: false,
});
cleanupOutdatedCaches();

const appRoots = new Set([
  "", "login", "wallboard", "servers", "services", "monitoring", "traffic-map",
  "alerts", "cameras", "patching", "vulnerabilities", "security-intelligence",
  "automation", "ai-agents", "containers", "registries", "app-catalog", "logs",
  "jobs", "cluster", "vpn", "settings",
]);
registerRoute(
  ({ request, url }) => request.mode === "navigate"
    && url.origin === self.location.origin
    && appRoots.has(url.pathname.split("/")[1]),
  async ({ request }) => {
    try {
      const response = await fetch(request, { cache: "no-store" });
      if (response.status < 500) return response;
    } catch { /* Offline navigation gets a data-free document. */ }
    return (await matchPrecache("/offline.html")) ?? Response.error();
  },
);

// A new build waits until the user chooses Reload; never switch mid-session.
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") void self.skipWaiting();
});
// Intentionally no clientsClaim, API route, default handler or background sync.
// WebSocket, SSE, polling, external sites and proxy tools (e.g. Grafana) pass through.
