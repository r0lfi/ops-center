import { expect, test } from "@playwright/test";

import { alert, container, host, signIn } from "./gui-helpers";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

const hour = (n: number) => new Date(Date.now() - n * 3600_000).toISOString();

function job(id: string, playbook: string, target: string, status: string, counts = { changed_hosts: 2, successful_hosts: 3, failed_hosts: 0, unreachable_hosts: 0 }) {
  return { id, playbook, target_description: target, status, started_at: hour(1), created_at: hour(1), finished_at: null, events: [], extra_vars: {}, limit: null, user: null, ...counts };
}

test("alerts sort by severity then time, and filters live in the URL", async ({ page }) => {
  await signIn(page, { "/api/alerts": { available: true, alerts: [
    alert("OldWarning", "warning", { hostname: "beta" }, hour(5)),
    alert("OldCritical", "critical", { hostname: "alpha" }, hour(9)),
    alert("NewCritical", "critical", { hostname: "beta" }, hour(1)),
  ] } });
  await page.goto("/alerts");
  const names = page.locator("tbody tr td:first-child");
  await expect(names).toHaveText(["NewCritical", "OldCritical", "OldWarning"]);

  await page.goto("/alerts?severity=critical");
  await expect(names).toHaveText(["NewCritical", "OldCritical"]);
  await expect(page.getByLabel("Severity")).toHaveValue("critical");

  await page.getByRole("button", { name: "Group by host" }).click();
  await expect(page).toHaveURL(/group=host/);
  await expect(page.getByRole("rowheader", { name: "beta · 1" })).toBeVisible();

  await page.getByLabel("Search alerts").fill("oldcrit");
  await expect(names).toHaveText(["OldCritical"]);
});

test("the Overview links to filtered lists and its rows open what they show", async ({ page }) => {
  await signIn(page, {
    "/api/alerts": { available: true, alerts: [alert("DiskFull", "critical", { hostname: "alpha" })] },
    "/api/hosts": [host("alpha")],
    "/api/jobs": [job("j1", "patch.yml", "x", "failed")],
  });
  await page.goto("/");
  await page.getByRole("link", { name: /1 critical alert firing/ }).click();
  await expect(page).toHaveURL(/\/alerts\?severity=critical$/);
  await page.goto("/");
  await page.getByRole("link", { name: /DiskFull/ }).click();
  await expect(page).toHaveURL(/\/alerts\?alert=DiskFull&host=alpha$/);
  await page.goto("/");
  await page.getByRole("link", { name: /patch\.yml/ }).click();
  await expect(page).toHaveURL(/\/jobs\/j1$/);
});

test("servers put status after the name and filter from the URL", async ({ page }) => {
  await signIn(page, {
    "/api/alerts": { available: true, alerts: [alert("ServerDown", "critical", { hostname: "down-1" })] },
    "/api/hosts": [host("up-1"), host("down-1")],
  });
  await page.goto("/servers?status=offline");
  await expect(page.locator("thead th").nth(1)).toHaveText("Status");
  await expect(page.locator("thead th").nth(2)).toHaveText("IP / FQDN");
  await expect(page.getByRole("link", { name: "down-1" })).toBeVisible();
  await expect(page.getByRole("link", { name: "up-1" })).toHaveCount(0);
});

test("long container images are cut with the full name on hover", async ({ page }) => {
  await signIn(page, { "/api/containers": [container("grafana", "running", "healthy"), container("old", "exited", null)] });
  await page.goto("/containers/all?status=exited");
  await expect(page.getByLabel("Container status")).toHaveValue("exited");
  await expect(page.getByRole("link", { name: "grafana" })).toHaveCount(0);
  const cell = page.getByRole("cell", { name: /very\/long/ });
  await expect(cell).toHaveAttribute("title", /image-name:1\.2\.3/);
  expect(await cell.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(60);
});

test("jobs filter by origin, status and playbook and name the result", async ({ page }) => {
  await signIn(page, { "/api/jobs": [job("a", "scan.yml", "scheduled:alpha", "successful"), job("b", "patch.yml", "group:web (2 hosts, scheduled)", "failed"), job("c", "patch.yml", "alpha", "failed")] });
  await page.goto("/jobs?status=failed");
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await page.getByLabel("Started by").selectOption("manual");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr").first()).toContainText("2 changed");
  await expect(page.locator("tbody tr").first()).toContainText("3 ok");
  await expect(page.locator("tbody tr").first()).not.toContainText("0 failed");
});

test("vulnerabilities take their filter from the URL and explain the empty list", async ({ page }) => {
  const asked: string[] = [];
  await signIn(page);
  await page.route("**/api/security/vulnerabilities*", (route) => { asked.push(route.request().url()); return route.fulfill({ json: [] }); });
  await page.goto("/vulnerabilities?severity=critical");
  await expect(page.getByText("No vulnerabilities match these filters.")).toBeVisible();
  await expect(page.getByText(/Showing every server\./)).toBeVisible();
  expect(asked.some((url) => url.includes("severity=critical"))).toBe(true);
});

test("timestamps are 24-hour with the full date on hover", async ({ page }) => {
  await signIn(page, { "/api/alerts": { available: true, alerts: [alert("A", "warning", {}, "2026-01-02T15:04:05Z")] } });
  await page.goto("/alerts");
  await expect(page.locator("time").first()).toHaveAttribute("title", /^\d{1,2} Jan 2026, \d{2}:\d{2}:\d{2}$/);
});
