import { expect, test } from "@playwright/test";

import { alert, container, host, signIn } from "./gui-helpers";

test.use({ serviceWorkers: "block" });

test("a firing ServerDown alert counts the host as offline", async ({ page }) => {
  await signIn(page, {
    "/api/hosts": [host("alpha"), host("beta")],
    "/api/alerts": { available: true, alerts: [alert("ServerDown", "critical", { hostname: "beta" })] },
  });
  await page.goto("/");
  await expect(page.getByRole("link", { name: /^Offline\s*1$/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Online\s*1$/ })).toBeVisible();
  await expect(page.getByText("1 server offline")).toBeVisible();
  await page.goto("/servers");
  await expect(page.getByRole("row", { name: /beta/ }).getByText("Down")).toBeVisible();
});

test("the critical badge says it counts areas", async ({ page }) => {
  await signIn(page, {
    "/api/hosts": [host("alpha")],
    "/api/alerts": { available: true, alerts: [alert("ServerDown", "critical", { hostname: "alpha" })] },
    "/api/security/summary": { kev: 3, critical: 9, high: 0, sources: [] },
  });
  await page.goto("/");
  await expect(page.getByText("3 critical areas")).toBeVisible();
});

test("exited containers are not unhealthy", async ({ page }) => {
  const rows = [container("ok", "running", "healthy"), container("sick", "running", "unhealthy"), container("old", "exited", "unhealthy"), container("off", "exited", null)];
  await signIn(page, { "/api/containers": rows, "/api/alerts": { available: true, alerts: [] } });
  await page.goto("/");
  await expect(page.getByRole("link", { name: /^Containers unhealthy\s*1$/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Containers exited\s*2$/ })).toBeVisible();
  await page.goto("/containers/all");
  await expect(page.locator("div").filter({ hasText: /^Exited$/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /old/ }).getByText("Not running")).toBeVisible();
  await expect(page.getByRole("row", { name: /old/ }).getByText("unhealthy")).toHaveCount(0);
});

test("security attention tells loading and failure apart from empty", async ({ page }) => {
  await signIn(page, { "/api/security/summary": { sources: [] } });
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/security/attention*", async (route) => {
    await held;
    await route.fulfill({ status: 500, json: { detail: "boom" } });
  });
  await page.goto("/security-intelligence");
  await expect(page.getByText("Checking vulnerabilities…")).toBeVisible();
  await expect(page.getByText("Nothing needs attention right now.")).toHaveCount(0);
  release();
  await expect(page.getByText(/Could not load this list/)).toBeVisible();
  await expect(page.getByText("Nothing needs attention right now.")).toHaveCount(0);
});

test("only the useful bulk agent action is offered", async ({ page }) => {
  const agent = { id: "a", slug: "a", name: "A", description: "", enabled: false, provider_id: null, model: null, allowed_tools: [], allowed_hosts: [], allowed_environments: [], system_prompt: "", autonomy_level: 1, max_tool_calls: 1, max_execution_seconds: 1, runtime: "native", status: "idle", last_activity_at: null, updated_at: new Date().toISOString() };
  await signIn(page, { "/api/ai/agents": [agent] });
  await page.route("**/api/ai/budget", (route) => route.fulfill({ status: 403, json: { detail: "Not in this test" } }));
  await page.goto("/ai-agents/agents");
  await expect(page.getByRole("button", { name: "Enable all agents" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disable all agents" })).toHaveCount(0);
});

test("investigation settings look disabled while the Incident workflow is off", async ({ page }) => {
  const config = { revision: 0, talk_enabled: true, categories: [], severities: [], excluded_rules: [], excluded_resources: [], recovery_minutes: 30, talk_progress: false, workflow_enabled: false, auto_investigate: true, investigation_agent: "coordinator", max_active_investigations: 2 };
  await signIn(page, { "/api/settings/incidents": config });
  await page.route("**/api/settings/traffic", (route) => route.fulfill({ status: 403, json: { detail: "Not in this test" } }));
  await page.goto("/settings?tab=incidents");
  const box = page.getByRole("checkbox", { name: "Investigate new incidents automatically" });
  await expect(box).toBeDisabled();
  await expect(page.getByText(/Not in use while the incident workflow is off/)).toBeVisible();
});
