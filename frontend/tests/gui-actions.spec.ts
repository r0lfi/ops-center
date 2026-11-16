import { expect, test } from "@playwright/test";

import { alert, container, host, signIn } from "./gui-helpers";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

const group = { id: "g1", name: "web", description: "", cron_expression: null, schedule_enabled: false, patch_type: "security", batch_size: 1, hosts: [{ id: "id-alpha", hostname: "alpha" }], last_triggered_at: null };

test("deleting a patch group takes the menu and a confirmation", async ({ page }) => {
  await signIn(page, { "/api/host-groups": [group], "/api/hosts": [host("alpha"), host("beta")], "/api/patching/scans": [] });
  const deletes: string[] = [];
  await page.route("**/api/host-groups/g1", (route) => { if (route.request().method() === "DELETE") deletes.push(route.request().url()); return route.fulfill({ status: 204, body: "" }); });
  await page.goto("/patching");
  await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Server to add" })).toHaveCount(0);

  await page.getByRole("button", { name: "More actions for web" }).click();
  await page.getByRole("menuitem", { name: "Delete group" }).click();
  expect(deletes).toEqual([]);
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  expect(deletes).toEqual([]);

  await page.getByRole("button", { name: "More actions for web" }).click();
  await page.keyboard.press("Enter");
  await page.getByRole("dialog").getByRole("button", { name: "Delete group" }).click();
  await expect.poll(() => deletes.length).toBe(1);
});

test("group membership is edited inside the group", async ({ page }) => {
  await signIn(page, { "/api/host-groups": [group], "/api/hosts": [host("alpha"), host("beta")] });
  await page.goto("/patching");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Servers in this group" })).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Server to add" })).toContainText("beta");
  await expect(dialog.getByRole("button", { name: "Remove alpha from group" })).toBeVisible();
});

test("removing a registry asks first", async ({ page }) => {
  await signIn(page, { "/api/registries": [{ id: "r1", name: "ghcr", url: "ghcr.io", description: "", username: "bot" }] });
  const deletes: string[] = [];
  await page.route("**/api/registries/r1", (route) => { deletes.push(route.request().method()); return route.fulfill({ status: 204, body: "" }); });
  await page.goto("/registries");
  await page.getByRole("button", { name: "More actions for ghcr" }).click();
  await page.getByRole("menuitem", { name: "Remove registry" }).click();
  expect(deletes).toEqual([]);
  await page.getByRole("dialog").getByRole("button", { name: "Remove registry" }).click();
  await expect.poll(() => deletes).toEqual(["DELETE"]);
});

test("automation separates checks from changes and uses plain names", async ({ page }) => {
  await signIn(page, { "/api/automation/playbooks": ["patch-check.yml", "reboot.yml", "install-alloy.yml", "my-own.yml"] });
  await page.goto("/automation");
  const checks = page.getByRole("region", { name: "Checks" });
  await expect(checks.getByText("read only")).toBeVisible();
  await expect(checks.getByText("Check for patches")).toBeVisible();
  const power = page.getByRole("region", { name: "Power" });
  await expect(power.getByText("changes hosts")).toBeVisible();
  await expect(page.getByText("Install Grafana Alloy", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Custom playbooks" }).getByText("my-own.yml")).toBeVisible();
});

test("server detail has tabs, and Delete sits behind the menu", async ({ page }) => {
  const alpha = { ...host("alpha"), ssh_port: 22, ssh_user: "ops", reboot_policy: "manual", security_patch_policy: "manual", date_added: new Date().toISOString(), ssh_host_fingerprint: null };
  await signIn(page, {
    "/api/hosts/id-alpha": alpha,
    "/api/alerts": { available: true, alerts: [alert("DiskFull", "critical", { hostname: "alpha" }), alert("Other", "warning", { hostname: "beta" })] },
    "/api/containers?hostname=alpha": [container("grafana", "running", "healthy")],
  });
  await page.goto("/servers/id-alpha");
  await expect(page.getByRole("button", { name: "Delete server" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Verify SSH connectivity")).toHaveCount(0);

  await page.getByRole("tab", { name: "Alerts" }).click();
  await expect(page).toHaveURL(/tab=alerts/);
  await expect(page.getByText("DiskFull", { exact: true })).toBeVisible();
  await expect(page.getByText("Other", { exact: true })).toHaveCount(0);

  await page.getByRole("tab", { name: "Containers" }).click();
  await expect(page.getByRole("link", { name: /grafana/ })).toBeVisible();

  await page.goto("/servers/id-alpha?tab=onboarding");
  await expect(page.getByText("Verify SSH connectivity")).toBeVisible();

  await page.getByRole("button", { name: "More server actions" }).click();
  await page.getByRole("menuitem", { name: "Delete server" }).click();
  await expect(page.getByRole("dialog")).toContainText("This cannot be undone.");
});
