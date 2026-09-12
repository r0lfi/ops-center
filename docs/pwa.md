# Progressive Web App

Ops Center remains a normal responsive website in Chrome, Firefox, Safari, Edge
and other modern browsers. Installation is optional. The PWA uses exactly the
same frontend, backend, authentication, API, polling, WebSocket and SSE endpoints.

Use the browser's installation menu on supported desktop/Android browsers, or
**Install Ops Center** when available. On iPhone/iPad open the site in Safari,
choose **Share → Add to Home Screen**, then **Open as Web App** if offered. The
in-app help describes this manual iOS path; iOS does not emit `beforeinstallprompt`.
Availability in other iOS browsers depends on OS/browser version and device policy.
Standalone launches use the same-origin start URL `/` and scope `/`.

Production requires a valid HTTPS origin; loopback localhost is allowed for
local testing. A reverse proxy may terminate TLS on any external port. Preserve
the original origin, API routes, upgrade/stream headers and frontend SPA fallback.
Root deployment is supported; arbitrary subpath deployments need a coordinated
base/scope/router/proxy configuration and are not implied by this manifest.

Vite's `vite-plugin-pwa` builds a custom Workbox service worker (`src/sw.ts`). It
precaches versioned JS/CSS and public offline/icon assets. It never caches API,
authentication, session data, POST requests or live status. Navigations use the
network; offline navigation shows an explicit offline page. Backend unavailability
shows an offline overlay so old on-screen values are not presented as live.

A new worker waits until the user chooses **Reload**. The UI does not activate a
new worker in the middle of an active session. Keep the prior deployment's hashed
assets briefly during rolling deployments so already open tabs can load lazy
chunks. Serve `/sw.js`, the manifest and HTML with revalidation/no-store, as in
`frontend/nginx.conf`. Do not apply an ingress-wide immutable cache policy.

Workbox derives cache revisions from build asset contents. The frontend package
retains the existing application version. Icons use the existing shield/check
identity; regenerated PNGs require visual review before public packaging.

For local validation (Node 22 or later):

```bash
cd frontend
npm ci
npm run lint
npm run build
npx playwright install chromium webkit
npm test
npm run preview -- --host 127.0.0.1
```

The Playwright server uses a production build and synthetic loopback APIs. Tests
cover manifest/install help, standalone layout, refresh/direct routes, offline
behavior, controlled updates and live transports. Device emulation is not proof
of installation on physical hardware; test Safari's home-screen flow on an actual
iPhone/iPad before distributing an installation guide for a specific OS release.
