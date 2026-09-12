import { expect, test } from "@playwright/test";

// Route fixtures stay in an isolated browser context and never use real credentials.
test.use({ serviceWorkers: "block" });
test.beforeEach(async ({ page }) => {
  await page.route("**/api/traffic/history?*", route => route.fulfill({ json: {
    now: Math.floor(Date.now() / 1000), stats: { total: 0, clients: 0, countries: 0, errors: 0, handshakes: 0 },
    events: [], countries: [], timeline: [], sources: [], destinations: {},
  } }));
  await page.route("**/api/traffic/security?*", route => route.fulfill({ json: { alerts: [], logins: [] } }));
});

test("Traffic Map opens its own wallboard and preserves filters through refresh and return", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ops_center_token", "pwa-test-only"));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/traffic-map?hours=168&service=vpn&errors=true");
  await page.getByRole("link", { name: "Open Wallboard" }).click();
  await expect(page).toHaveURL(/\/traffic-map\/wallboard\?hours=168&service=vpn&errors=true$/);
  await expect(page.getByRole("heading", { name: "Traffic Map Wallboard", exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "Geolocated traffic to configured servers" })).toBeVisible();
  await expect(page.locator("#ops-navigation")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Ops Center Wallboard", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Time period")).toHaveValue("168");
  await expect(page.getByLabel("Rejections / errors only")).toBeChecked();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Traffic Map Wallboard", exact: true })).toBeVisible();
  const refreshed = page.waitForRequest(request => request.url().includes("/api/traffic/history?"));
  await page.getByRole("button", { name: "Refresh traffic history" }).click();
  const query = new URL((await refreshed).url()).searchParams;
  expect(query.get("service")).toBe("vpn");
  expect(query.get("hours")).toBe("168");
  await page.getByLabel("Time period").selectOption("24");
  await page.getByRole("link", { name: "Back to Traffic Map" }).click();
  await expect(page).toHaveURL(/\/traffic-map\?hours=24&service=vpn&errors=true$/);
  await expect(page.getByRole("heading", { name: "Traffic Map", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("direct wallboard navigation requires authentication", async ({ page }) => {
  await page.goto("/traffic-map/wallboard");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
});
