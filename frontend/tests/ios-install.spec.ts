import { expect, test } from "@playwright/test";

const profiles = [
  { name: "iPad Safari with desktop identity", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15", platform: "MacIntel", touch: 5 },
  { name: "Chrome on iPad", userAgent: "Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.39 Mobile/15E148 Safari/604.1", platform: "iPad", touch: 5 },
  { name: "Safari on iPhone", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1", platform: "iPhone", touch: 5 },
];
for (const profile of profiles) {
  test(profile.name + " offers instructions before login and hides them in standalone", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, userAgent: profile.userAgent, viewport: { width: 820, height: 1180 }, hasTouch: true });
    await context.addInitScript(({ platform, touch }) => {
      Object.defineProperty(navigator, "platform", { get: () => platform });
      Object.defineProperty(navigator, "maxTouchPoints", { get: () => touch });
    }, profile);
    const page = await context.newPage();
    try {
      await page.goto("/login?return_to=fixture-only");
      await page.getByLabel("Password", { exact: true }).fill("unsent-fixture");
      const install = page.getByRole("button", { name: "Add to Home Screen", exact: true });
      await expect(install).toBeVisible();
      await install.click();
      await expect(page.getByRole("dialog", { name: "Add Ops Center to your Home Screen" })).toBeVisible();
      await expect(page.getByText("Open as Web App", { exact: true })).toBeVisible();
      await page.getByText("Cannot find Add to Home Screen?", { exact: true }).click();
      await expect(page.getByLabel("Ops Center app link")).toHaveValue(baseURL + "/");
      await page.screenshot({ path: test.info().outputPath("apple-install-help.png"), fullPage: true });
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await expect(page.getByLabel("Password", { exact: true })).toHaveValue("unsent-fixture");
      await page.evaluate(() => localStorage.setItem("ops_center_token", "pwa-test-only"));
      await page.goto("/servers");
      await expect(page.getByRole("heading", { name: "Servers", exact: true })).toBeVisible();
      await expect(install).toBeVisible();
      await install.click();
      await expect(page.getByRole("dialog", { name: "Add Ops Center to your Home Screen" })).toBeVisible();
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await context.addInitScript(() => Object.defineProperty(navigator, "standalone", { get: () => true }));
      await page.reload();
      await expect(page.getByRole("heading", { name: "Servers", exact: true })).toBeVisible();
      await expect(install).toHaveCount(0);
    } finally { await context.close(); }
  });
}

test("a Mac without touch does not receive iPad instructions", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
    Object.defineProperty(navigator, "userAgent", { get: () => "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15" });
    Object.defineProperty(navigator, "maxTouchPoints", { get: () => 0 });
  });
  await page.goto("/login");
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add to Home Screen", exact: true })).toHaveCount(0);
});

test("production PWA registration, offline document and recovery work in the browser engine", async ({ page, context, request }) => {
  await page.goto("/login");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("sizes", "180x180");
  const manifest = await page.evaluate(() => fetch("/manifest.webmanifest").then(response => response.json()));
  expect(manifest.display).toBe("standalone");
  await context.setOffline(true);
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeHidden();
  await context.setOffline(false);
  // This WebKit runner aborts context-offline navigations before SW fallback.
  // Close real HTTP sockets instead to exercise the worker's network-error path.
  await request.get("/__test__/frontend-offline");
  try {
    await page.reload();
    await expect(page.getByRole("heading", { name: "Ops Center is currently offline" })).toBeVisible();
    await expect(page.locator("#root")).toHaveCount(0);
  } finally { await request.get("/__test__/reset"); }
  await page.getByRole("button", { name: "Retry connection" }).click();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
});
