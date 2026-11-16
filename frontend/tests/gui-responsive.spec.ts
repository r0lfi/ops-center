import { expect, test } from "@playwright/test";

import { alert, container, host, signIn } from "./gui-helpers";

test.use({ serviceWorkers: "block" });

const job = { id: "j1", playbook: "patch-security.yml", target_description: "alpha", status: "failed", started_at: new Date().toISOString(), created_at: new Date().toISOString(), finished_at: null, changed_hosts: 1, successful_hosts: 2, failed_hosts: 1, unreachable_hosts: 0, events: [], extra_vars: {}, limit: null, user: "a" };
const group = { id: "g1", name: "a-group-with-quite-a-long-name", description: "Weekly", cron_expression: "0 3 * * 1", schedule_enabled: true, patch_type: "security", batch_size: 1, hosts: [{ id: "id-alpha", hostname: "alpha" }], last_triggered_at: null };
const data = {
  "/api/hosts": [host("alpha", { tags: ["web", "prod"] })],
  "/api/containers": [container("a-container-with-a-very-long-name-that-should-not-widen-the-page", "running", "healthy")],
  "/api/alerts": { available: true, alerts: [alert("DiskFull", "critical", { hostname: "alpha" })] },
  "/api/jobs": [job],
  "/api/host-groups": [group],
  "/api/cluster/status": { postgres: { scope: "s", vip: "198.51.100.19", vip_holder: null, nodes: [] }, redis: { master_name: "m", nodes: [], sentinels: [{ host: "sentinel-with-a-long-name-01", reachable: true, master_host: "198.51.100.110" }] } },
};

for (const width of [375, 1024, 1440]) {
  for (const path of ["/", "/alerts", "/servers", "/containers/all", "/jobs", "/vulnerabilities", "/patching", "/automation", "/cluster"]) {
    test(`${path} does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await signIn(page, data);
      await page.goto(path);
      await expect(page.locator("h1").first()).toBeVisible();
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(() => {
        const main = document.querySelector("main");
        return { doc: document.documentElement.scrollWidth - innerWidth, main: main ? main.scrollWidth - main.clientWidth : 0 };
      });
      expect(overflow.doc).toBeLessThanOrEqual(0);
      expect(overflow.main).toBeLessThanOrEqual(0);
    });
  }
}

test("patch group and host actions stay on screen at 375px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await signIn(page, data);
  await page.goto("/patching");
  for (const name of ["Reports", "Edit", "More actions for a-group-with-quite-a-long-name", "Check", "Security", "All"]) {
    const box = await page.getByRole(name === "Reports" ? "link" : "button", { name, exact: true }).boundingBox();
    expect(box, name).not.toBeNull();
    expect(box!.x, name).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, name).toBeLessThanOrEqual(375);
  }
});

test("tables become labelled cards on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await signIn(page, data);
  await page.goto("/servers");
  const row = page.locator("tbody tr").first();
  await expect(row).toBeVisible();
  expect(await row.evaluate((el) => getComputedStyle(el).display)).toBe("block");
  expect(await page.locator('td[data-label="Status"]').first().evaluate((el) => getComputedStyle(el, "::before").content)).toContain("Status");
});

test("Ask Ops AI is compact on a phone and gone on the chat page", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await signIn(page, data);
  await page.goto("/alerts");
  const ask = page.getByRole("button", { name: "Ask Ops AI" });
  await expect(ask).toBeVisible();
  expect((await ask.boundingBox())!.width).toBeLessThan(60);
  await page.goto("/ai-agents/chat");
  await expect(page.getByRole("button", { name: "Ask Ops AI" })).toHaveCount(0);
});
