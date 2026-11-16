import { expect, test, type Page } from "@playwright/test";

// Sessions: the access token lives only in memory and is renewed from an HttpOnly refresh cookie.
test.use({ serviceWorkers: "block" });
const token = (expires: number) => "fixture." + Buffer.from(JSON.stringify({ exp: expires })).toString("base64url") + ".signature";
const user = { id: "fixture", username: "Dashboard Test", role: "viewer", is_active: true };

async function setup(page: Page, { cookie = true } = {}) {
  await page.clock.install();
  await page.route("**/api/auth/me", route => route.request().headers().authorization?.startsWith("Bearer fixture.")
    ? route.fulfill({ json: user }) : route.fulfill({ status: 401, json: { detail: "not authenticated" } }));
  await page.route("**/api/metrics/services", route => route.fulfill({ json: { available: true, services: [] } }));
  await page.route("**/api/metrics/hosts?*", route => route.fulfill({ json: { available: true, cpu: [], memory: [], disk: [], network_rx: [], network_tx: [] } }));
  if (cookie) await page.context().addCookies([{ name: "ops_refresh", value: "remembered", url: "http://127.0.0.1:4175/api/auth" }]);
}
async function tick(page: Page, ms: number) {
  await page.clock.fastForward(ms);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}
const noStoredToken = (page: Page) => page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));

test("a remembered browser opens signed in, keeps the token out of storage and renews it while open", async ({ page }) => {
  await setup(page);
  const refreshes: { csrf?: string; cookie?: string }[] = [];
  await page.route("**/api/auth/refresh", async route => {
    // allHeaders(): WebKit leaves the Cookie header out of headers().
    const headers = await route.request().allHeaders();
    refreshes.push({ csrf: headers["x-requested-with"], cookie: headers.cookie });
    const now = await page.evaluate(() => Date.now());
    await route.fulfill({ json: { access_token: token(now / 1000 + 15 * 60), role: "viewer", username: "Dashboard Test", remember: true } });
  });
  await page.goto("/wallboard");
  await expect(page.getByRole("heading", { name: "Ops Center Wallboard" })).toBeVisible();
  expect(refreshes[0]).toMatchObject({ csrf: "ops-center" });
  // WebKit does not expose cookies on intercepted requests; check the browser's
  // cookie for the refresh path there, and the header everywhere else.
  if (test.info().project.name.includes("webkit")) {
    expect(await page.context().cookies("http://127.0.0.1:4175/api/auth/refresh")).toContainEqual(expect.objectContaining({ name: "ops_refresh", value: "remembered" }));
  } else {
    expect(refreshes[0].cookie).toContain("ops_refresh=remembered");
  }
  for (let i = 2; i <= 4; i++) {
    await tick(page, 14 * 60 * 1000);
    await expect.poll(() => refreshes.length).toBe(i);
    await expect(page.getByRole("heading", { name: "Ops Center Wallboard" })).toBeVisible();
  }
  expect(await noStoredToken(page)).not.toContain("fixture.");
});

test("temporary failure while resuming keeps the session and recovers", async ({ page }) => {
  await setup(page);
  let attempts = 0;
  await page.route("**/api/auth/refresh", async route => {
    attempts++;
    const now = await page.evaluate(() => Date.now());
    return attempts === 1 ? route.fulfill({ status: 502, json: { detail: "Temporary failure" } })
      : route.fulfill({ json: { access_token: token(now / 1000 + 900), role: "viewer", username: "Dashboard Test" } });
  });
  await page.goto("/wallboard");
  await expect.poll(async () => { await tick(page, 6000); return attempts; }).toBeGreaterThan(1);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Ops Center Wallboard" })).toBeVisible();
});

test("a revoked or expired session signs out", async ({ page }) => {
  await setup(page);
  let revoked = false;
  await page.route("**/api/auth/refresh", async route => {
    if (revoked) return route.fulfill({ status: 401, json: { detail: "session revoked" } });
    const now = await page.evaluate(() => Date.now());
    return route.fulfill({ json: { access_token: token(now / 1000 + 900), role: "viewer", username: "Dashboard Test" } });
  });
  await page.goto("/wallboard");
  await expect(page.getByRole("heading", { name: "Ops Center Wallboard" })).toBeVisible();
  revoked = true;
  await tick(page, 14 * 60 * 1000);
  await expect(page).toHaveURL(/\/login$/);
});

test("without a session cookie the login page asks for Remember me", async ({ page }) => {
  await setup(page, { cookie: false });
  await page.route("**/api/auth/refresh", route => route.fulfill({ status: 401, json: { detail: "not signed in" } }));
  let body: Record<string, unknown> = {};
  await page.route("**/api/auth/login", async route => {
    body = route.request().postDataJSON();
    const now = await page.evaluate(() => Date.now());
    await route.fulfill({ json: { access_token: token(now / 1000 + 900), role: "viewer", username: "Dashboard Test", remember: true } });
  });
  await page.goto("/wallboard");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Username").fill("dashboard");
  await page.getByLabel("Password").fill("correct horse");
  await page.getByRole("checkbox", { name: /Remember me for 30 days/ }).check();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Ops Center Wallboard" })).toBeVisible();
  expect(body).toMatchObject({ username: "dashboard", remember_me: true });
});
