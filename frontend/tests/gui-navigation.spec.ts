import { expect, test } from "@playwright/test";

import { alert, signIn } from "./gui-helpers";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

const nav = (page: import("@playwright/test").Page) => page.getByRole("complementary", { name: "Main navigation" });

test("menu has the agreed groups and no item counts", async ({ page }) => {
  await signIn(page, { "/api/alerts": { available: true, alerts: [] } });
  await page.goto("/");
  const groups = nav(page).getByRole("region");
  await expect(groups).toHaveCount(6);
  for (const name of ["Alerts & Incidents", "Infrastructure", "Security", "Automation", "AI Traffic Monitor", "AI"]) {
    await expect(nav(page).getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expect(nav(page).getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await expect(nav(page).getByText("Air-Gap")).toHaveCount(0);
});

test("the current group opens, the page scrolls into view, others close unless pinned", async ({ page }) => {
  await signIn(page, { "/api/alerts": { available: true, alerts: [] } });
  await page.setViewportSize({ width: 1440, height: 420 });
  await page.goto("/cameras");
  await expect(nav(page).getByRole("link", { name: "Cameras" })).toBeInViewport();
  await nav(page).getByRole("button", { name: "Keep open: Infrastructure" }).click();
  await nav(page).getByRole("button", { name: "Security", exact: true }).click();
  await nav(page).getByRole("link", { name: "Patching", exact: true }).click();
  await expect(nav(page).getByRole("link", { name: "Cameras" })).toBeAttached();
  await nav(page).getByRole("button", { name: "Unpin Infrastructure" }).click();
  await nav(page).getByRole("button", { name: "Alerts & Incidents", exact: true }).click();
  await nav(page).getByRole("link", { name: "Alerts", exact: true }).click();
  await expect(nav(page).getByRole("link", { name: "Cameras" })).toBeHidden();
  await expect(nav(page).getByRole("link", { name: "Patching", exact: true })).toBeHidden();
});

test("alerts and approvals show live counts", async ({ page }) => {
  await signIn(page, {
    "/api/alerts": { available: true, alerts: [alert("ServerDown", "critical", { hostname: "a" }), alert("DiskWarning", "warning", { hostname: "a" })] },
  });
  await page.route("**/api/ai/actions?*", (route) => route.fulfill({ json: [{ id: "1" }, { id: "2" }, { id: "3" }] }));
  await page.goto("/alerts");
  await expect(nav(page).getByLabel("2 active alerts")).toBeVisible();
  await expect(nav(page).getByLabel("3 waiting in AI")).toBeVisible();
});

test("the open menu does not repeat the logo, search or close control", async ({ page }) => {
  await signIn(page, { "/api/alerts": { available: true, alerts: [] } });
  await page.goto("/alerts");
  await expect(page.getByText("Ops Center", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Close menu" }).filter({ visible: true })).toHaveCount(1);
  await expect(page.getByRole("searchbox")).toHaveCount(0);
});

test("old settings URLs land on the right tab", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/ai/budget", (route) => route.fulfill({ status: 403, json: { detail: "Not in this test" } }));
  await page.goto("/ai-agents/settings");
  await expect(page).toHaveURL(/\/settings\?tab=ai$/);
  await expect(page.getByRole("tab", { name: "AI & budget" })).toHaveAttribute("data-state", "active");
  await expect(page.getByText("Weekly budget status is unavailable.", { exact: false })).toBeVisible();
  await page.goto("/airgap/distrobox");
  await expect(page).toHaveURL(/\/$/);
});

test("Ops Floor and Collaboration lead back the same way", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/ai/collaboration/**", (route) => route.fulfill({ status: 403, json: { detail: "Not in this test" } }));
  await page.goto("/ai-agents/collaboration");
  await expect(page.getByRole("link", { name: "AI overview" }).filter({ visible: true }).first()).toHaveAttribute("href", "/ai-agents");
  await page.goto("/ai-agents/ops-floor");
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "AI Agents" })).toHaveAttribute("href", "/ai-agents");
});
