import { expect, test } from "@playwright/test";

import { alert, container, host, signIn } from "./gui-helpers";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

const data = {
  "/api/hosts": [host("alpha")],
  "/api/containers": [container("grafana", "running", "healthy")],
  "/api/alerts": { available: true, alerts: [alert("DiskWarning", "warning", { hostname: "alpha" })] },
  "/api/ansible/playbooks": ["patch-all.yml"],
};

test("Ctrl+K searches every type, grouped, and only navigates", async ({ page }) => {
  await signIn(page, data);
  const writes: string[] = [];
  // Session renewal (POST /api/auth/refresh) is not a write the palette made.
  page.on("request", (request) => { if (request.method() !== "GET" && request.url().includes("/api/") && !request.url().includes("/api/auth/refresh")) writes.push(request.url()); });
  await page.route("**/api/security/vulnerabilities?*", (route) => route.fulfill({ json: [{ cve_id: "CVE-2026-0001", severity: "critical" }] }));
  await page.goto("/alerts");
  // The session is resumed from the refresh cookie before the layout (and its shortcut) mounts.
  await expect(page.getByRole("button", { name: "Search Ops Center" })).toBeVisible();
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox", { name: /Search pages/ });
  await expect(input).toBeFocused();

  await input.fill("alpha");
  await expect(page.getByRole("group", { name: "Servers" }).getByRole("option", { name: /alpha/ })).toBeVisible();
  await expect(page.getByRole("group", { name: "Containers" }).getByRole("option", { name: /grafana/ })).toBeVisible();
  await expect(page.getByRole("group", { name: "Alerts" }).getByRole("option", { name: /DiskWarning/ })).toBeVisible();

  await input.fill("patch-all");
  await expect(page.getByRole("group", { name: "Playbooks" }).getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/automation\/playbooks\?playbook=patch-all\.yml$/);

  await page.keyboard.press("Control+k");
  await input.fill("cve-2026");
  await expect(page.getByRole("group", { name: "CVEs" }).getByRole("option", { name: /CVE-2026-0001/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("arrow keys move, and recent picks come first", async ({ page }) => {
  await signIn(page, data);
  await page.goto("/alerts");
  await page.getByRole("button", { name: "Search Ops Center" }).click();
  const input = page.getByRole("combobox", { name: /Search pages/ });
  await input.fill("vuln");
  await expect(page.getByRole("option", { name: /Vulnerabilities/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/vulnerabilities$/);

  await page.keyboard.press("Control+k");
  const recent = page.getByRole("group", { name: "Recent" }).getByRole("option");
  await expect(recent).toHaveCount(1);
  await expect(recent).toContainText("Vulnerabilities");
  await expect(recent).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(recent).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("ArrowUp");
  await expect(recent).toHaveAttribute("aria-selected", "true");
});
