import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";

async function controlled(page: Page) {
  await page.goto("/servers");
  await expect(page.getByRole("heading", { name: "Servers", exact: true })).toBeVisible();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}
async function cacheUrls(page: Page) {
  return page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) urls.push(new URL(request.url).pathname);
    }
    return urls;
  });
}
test.beforeEach(async ({ context, request }) => {
  await request.get("/__test__/reset");
  await context.addInitScript(() => localStorage.setItem("ops_center_token", "pwa-test-only"));
});
test.afterEach(async ({ request }) => { await request.get("/__test__/reset"); });

test("manifest, icons, installability, regular web and internal routes", async ({ page, request, context }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await controlled(page);
  expect(await page.evaluate(() => matchMedia("(display-mode: standalone)").matches)).toBe(false);
  const manifestResponse = await request.get("/manifest.webmanifest");
  expect(manifestResponse.headers()["content-type"]).toContain("application/manifest+json");
  const manifest = await manifestResponse.json();
  expect(manifest).toMatchObject({ id: "/", name: "Ops Center", short_name: "Ops Center", start_url: "/", scope: "/", display: "standalone", orientation: "any" });
  for (const icon of manifest.icons) {
    const response = await request.get(icon.src);
    const metadata = await sharp(await response.body()).metadata();
    expect(icon.sizes).toBe(metadata.width + "x" + metadata.height);
  }
  const apple = page.locator('link[rel="apple-touch-icon"]');
  expect(await apple.getAttribute("href")).toBe("/icons/apple-touch-icon.png");
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute("content", "yes");
  for (const shortcut of manifest.shortcuts) {
    const response = await request.get(shortcut.url);
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain('id="root"');
  }
  await page.goto("/ai-agents/agents");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  const session = await context.newCDPSession(page);
  const result = await session.send("Page.getInstallabilityErrors");
  expect(result.installabilityErrors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("web.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("only static assets are cached; API, auth, commands, SSE and WebSocket pass through", async ({ page, context }) => {
  await controlled(page);
  await context.addCookies([{ name: "pwa-session-test", value: "fixture-only", url: "http://127.0.0.1:4175" }]);
  const result = await page.evaluate(async () => {
    const options = { headers: { Authorization: "Bearer fixture-only", "X-CSRF-Token": "fixture-csrf" } };
    const first = await (await fetch("/api/test/echo", options)).json();
    const second = await (await fetch("/api/test/echo", options)).json();
    const mutation = await (await fetch("/api/test/echo", { ...options, method: "POST", body: "test-command" })).json();
    const events = await new Promise<number>((resolve, reject) => {
      const stream = new EventSource("/api/test/events");
      let count = 0;
      stream.onmessage = () => { if (++count === 2) { stream.close(); resolve(count); } };
      stream.onerror = () => { stream.close(); reject(new Error("SSE failed")); };
    });
    const socket = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket("ws://" + location.host + "/api/test/socket");
      ws.onopen = () => ws.send("live-agent-status");
      ws.onmessage = event => { ws.close(); resolve(event.data); };
      ws.onerror = () => reject(new Error("WebSocket failed"));
    });
    return { first, second, mutation, events, socket };
  });
  expect(result.second.counter).toBeGreaterThan(result.first.counter);
  expect(result.mutation).toMatchObject({ method: "POST", body: "test-command", authorization: "Bearer fixture-only", csrf: "fixture-csrf" });
  expect(result.mutation.cookie).toContain("pwa-session-test=fixture-only");
  expect(result.events).toBe(2);
  expect(result.socket).toBe("live-agent-status");
  const urls = await cacheUrls(page);
  expect(urls).toContain("/offline.html");
  expect(urls.some(url => url.startsWith("/assets/"))).toBe(true);
  expect(urls.every(url => /^(\/assets\/|\/icons\/|\/offline\.(html|css|js)$|\/manifest\.webmanifest$)/.test(url))).toBe(true);
  await context.setOffline(true);
  expect(await page.evaluate(() => fetch("/api/test/echo").then(() => false, () => true))).toBe(true);
  expect(await page.evaluate(() => fetch("/api/test/echo", { method: "POST", body: "never-queue" }).then(() => false, () => true))).toBe(true);
});

test("offline hides live UI, navigation falls back without data and recovery fetches fresh state", async ({ page, context }) => {
  await controlled(page);
  await context.setOffline(true);
  await expect(page.getByRole("heading", { name: "Ops Center is currently offline" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Servers", exact: true })).toBeHidden();
  await page.goto("/servers");
  await expect(page.getByRole("heading", { name: "Ops Center is currently offline" })).toBeVisible();
  expect(await page.locator("#root").count()).toBe(0);
  await page.screenshot({ path: test.info().outputPath("offline.png"), fullPage: true });
  await context.setOffline(false);
  await page.getByRole("button", { name: "Retry connection" }).click();
  await expect(page.getByRole("heading", { name: "Servers", exact: true })).toBeVisible();
});

test("backend failures are not hidden by cached data; polling detects failure", async ({ page, request }) => {
  await controlled(page);
  await page.getByRole("button", { name: "Add Server", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await request.get("/__test__/backend-down");
  await expect(page.getByRole("heading", { name: "Ops Center is currently offline" })).toBeVisible({ timeout: 12000 });
  await expect(page.getByRole("heading", { name: "Servers", exact: true })).toBeHidden();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="alertdialog"]'))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await request.get("/__test__/reset");
  await page.getByRole("button", { name: "Retry connection" }).click();
  await page.getByRole("button", { name: "Reload Ops Center" }).click();
  await expect(page.getByRole("heading", { name: "Servers", exact: true })).toBeVisible();
  await request.get("/__test__/frontend-down");
  await page.goto("/servers");
  await expect(page.getByRole("heading", { name: "Ops Center is currently offline" })).toBeVisible();
});

test("install prompt is discreet, conditional and hidden in standalone simulation", async ({ page }) => {
  await controlled(page);
  await expect(page.getByRole("button", { name: "Install Ops Center", exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt");
    Object.assign(event, { prompt: async () => {}, userChoice: Promise.resolve({ outcome: "dismissed" }) });
    window.dispatchEvent(event);
  });
  await page.getByRole("button", { name: "Install Ops Center", exact: true }).click();
  await expect(page.getByRole("button", { name: "Install Ops Center", exact: true })).toHaveCount(0);
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = query => {
      const result = original(query);
      if (query === "(display-mode: standalone)") Object.defineProperty(result, "matches", { value: true });
      return result;
    };
  });
  await page.reload();
  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt");
    Object.assign(event, { prompt: async () => {}, userChoice: Promise.resolve({ outcome: "accepted" }) });
    window.dispatchEvent(event);
  });
  await expect(page.getByRole("button", { name: "Install Ops Center", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Servers", exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("standalone-simulation.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("updates wait for Reload and do not automatically reload other active tabs", async ({ page, context, request }) => {
  await controlled(page);
  const other = await context.newPage();
  await other.goto("/servers");
  await page.evaluate(() => { document.documentElement.dataset.sessionMarker = "preserve"; });
  await other.evaluate(() => { document.documentElement.dataset.sessionMarker = "preserve"; });
  await request.get("/__test__/update");
  await page.evaluate(async () => { await (await navigator.serviceWorker.ready).update(); });
  await expect(page.getByText("New Ops Center version available.", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.dataset.sessionMarker)).toBe("preserve");
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-session-marker", "preserve");
  await expect(page.getByRole("heading", { name: "Servers", exact: true })).toBeVisible();
  expect(await other.evaluate(() => document.documentElement.dataset.sessionMarker)).toBe("preserve");
  await expect(other.getByRole("button", { name: "Reload", exact: true })).toBeVisible();
  await other.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(other.locator("html")).not.toHaveAttribute("data-session-marker", "preserve");
});

test.describe("ordinary web without service workers", () => {
  test.use({ serviceWorkers: "block" });
  test("normal navigation and logout continue to work", async ({ page }) => {
    await page.goto("/servers");
    await expect(page.getByRole("heading", { name: "Servers", exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then(items => items.length))).toBe(0);
    if (!await page.getByRole("button", { name: "Sign out" }).isVisible()) await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(await page.evaluate(() => localStorage.getItem("ops_center_token"))).toBeNull();
  });
});
