import { expect, test, type Page } from "@playwright/test";

test.use({ serviceWorkers: "block" });
const token = (expires: number) => "fixture." + Buffer.from(JSON.stringify({ exp: expires })).toString("base64url") + ".signature";
const user = { id: "fixture", username: "Dashboard Test", role: "viewer", is_active: true };
async function setup(page: Page) {
  await page.clock.install();
  await page.route("**/api/auth/me", route => route.fulfill({ json: user }));
  await page.route("**/api/metrics/services", route => route.fulfill({ json: { available: true, services: [] } }));
  await page.route("**/api/metrics/hosts?*", route => route.fulfill({ json: { available: true, cpu: [], memory: [], disk: [], network_rx: [], network_tx: [] } }));
  await page.addInitScript(value => { if (!localStorage.getItem("ops_center_token")) localStorage.setItem("ops_center_token", value); }, token(Date.now() / 1000 + 3600));
}
async function tick(page: Page, ms: number) {
  await page.clock.fastForward(ms);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}

test("an unattended dashboard renews across multiple token lifetimes without input", async ({ page }) => {
  await setup(page);
  let refreshes = 0;
  await page.route("**/api/auth/refresh", async route => {
    refreshes++;
    const now = await page.evaluate(() => Date.now());
    await route.fulfill({ json: { access_token: token(now / 1000 + 3600), role: "viewer", username: "Dashboard Test" } });
  });
  await page.goto("/wallboard");
  await expect(page.getByRole("heading", { name: "Ops Center Wallboard" })).toBeVisible();
  for (let i = 1; i <= 3; i++) {
    await tick(page, 56 * 60 * 1000);
    await expect.poll(() => refreshes).toBe(i);
    await expect.poll(() => page.evaluate(() => JSON.parse(atob(localStorage.getItem("ops_center_token")!.split(".")[1])).exp - Date.now() / 1000)).toBeGreaterThan(3500);
    await expect(page.getByRole("heading", { name: "Ops Center Wallboard" })).toBeVisible();
  }
});

test("temporary bootstrap failure preserves saved login and recovers", async ({ page }) => {
  await setup(page);
  let attempts = 0;
  await page.route("**/api/auth/me", route => {
    attempts++;
    return attempts === 1 ? route.fulfill({ status: 502, json: { detail: "Temporary failure" } }) : route.fulfill({ json: user });
  });
  await page.goto("/wallboard");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("ops_center_token"))).toBeTruthy();
  await tick(page, 6000);
  await expect.poll(() => attempts).toBeGreaterThan(1);
  // The conservative offline guard still requires a reload before revealing data.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Ops Center Wallboard" })).toBeVisible();
});

test("rejected renewal signs out a disabled/expired session", async ({ page }) => {
  await setup(page);
  await page.route("**/api/auth/refresh", route => route.fulfill({ status: 401, json: { detail: "user not found or inactive" } }));
  await page.goto("/wallboard");
  await expect(page.getByRole("heading", { name: "Ops Center Wallboard" })).toBeVisible();
  await tick(page, 56 * 60 * 1000);
  await expect(page).toHaveURL(/\/login$/);
  expect(await page.evaluate(() => localStorage.getItem("ops_center_token"))).toBeNull();
});

test("logout wins over an in-flight renewal", async ({ page }) => {
  await setup(page);
  let pending: (() => Promise<void>) | undefined;
  await page.route("**/api/auth/refresh", route => { pending = () => route.fulfill({ json: { access_token: token(Date.now() / 1000 + 7200) } }); });
  await page.goto("/servers");
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await tick(page, 56 * 60 * 1000);
  await expect.poll(() => !!pending).toBe(true);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await pending!();
  await expect(page).toHaveURL(/\/login$/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ops_center_token"))).toBeNull();
});

test("a late 401 from an old request does not discard the renewed token", async ({ page }) => {
  await setup(page);
  let rejectOld: (() => Promise<void>) | undefined;
  await page.route("**/api/metrics/services", route => {
    if (!rejectOld) rejectOld = () => route.fulfill({ status: 401, json: { detail: "expired old request" } });
    else return route.fulfill({ json: { available: true, services: [] } });
  });
  await page.route("**/api/auth/refresh", async route => {
    const now = await page.evaluate(() => Date.now());
    await route.fulfill({ json: { access_token: token(now / 1000 + 3600) } });
  });
  await page.goto("/wallboard");
  await expect.poll(() => !!rejectOld).toBe(true);
  const before = await page.evaluate(() => localStorage.getItem("ops_center_token"));
  await tick(page, 56 * 60 * 1000);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ops_center_token"))).not.toBe(before);
  await rejectOld!();
  await expect(page.getByRole("heading", { name: "Ops Center Wallboard" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("ops_center_token"))).toBeTruthy();
});

test("agent event streams reconnect with the renewed token", async ({ page }) => {
  await setup(page);
  await page.addInitScript(() => {
    // Exercise stream lifetime independently of accelerated 3D animation frames.
    localStorage.setItem("ops_floor_view", "2d");
    const streams: { url: string; closed: boolean }[] = [];
    Object.assign(window, { fixtureStreams: streams, EventSource: class {
      record: { url: string; closed: boolean };
      constructor(url: string) { this.record = { url, closed: false }; streams.push(this.record); }
      close() { this.record.closed = true; }
    } });
  });
  await page.route("**/api/auth/refresh", async route => {
    const now = await page.evaluate(() => Date.now());
    await route.fulfill({ json: { access_token: token(now / 1000 + 3600) } });
  });
  await page.route("**/api/ai/usage?*", route => route.fulfill({ json: { points: [] } }));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/ai-agents");
  const connections = () => page.evaluate(() => (window as Window & { fixtureStreams: { url: string; closed: boolean }[] }).fixtureStreams);
  await expect.poll(async () => (await connections()).length).toBe(2);
  const before = (await connections())[0].url;
  await tick(page, 56 * 60 * 1000);
  await expect.poll(async () => (await connections()).length).toBe(4);
  const after = await connections();
  expect(after.slice(0, 2).every(stream => stream.closed)).toBe(true);
  expect(after.slice(2).every(stream => !stream.closed && stream.url !== before)).toBe(true);
  expect(errors).toEqual([]);
});


test("a stalled renewal times out without clearing login and the next attempt succeeds", async ({ page }) => {
  await setup(page);
  let attempts = 0;
  await page.route("**/api/auth/refresh", async route => {
    attempts++;
    if (attempts === 1) return; // Simulated stalled response.
    const now = await page.evaluate(() => Date.now());
    await route.fulfill({ json: { access_token: token(now / 1000 + 3600) } });
  });
  await page.goto("/wallboard");
  await expect(page.getByRole("heading", { name: "Ops Center Wallboard" })).toBeVisible();
  const before = await page.evaluate(() => localStorage.getItem("ops_center_token"));
  await tick(page, 56 * 60 * 1000);
  await expect.poll(() => attempts).toBe(1);
  await page.clock.fastForward(16000);
  await expect(page.getByRole("alertdialog")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("ops_center_token"))).toBe(before);
  await tick(page, 60000);
  await expect.poll(() => attempts).toBe(2);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ops_center_token"))).not.toBe(before);
});
