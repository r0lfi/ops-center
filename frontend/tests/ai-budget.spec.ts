import { expect, test, type Page } from "@playwright/test";
test.use({ serviceWorkers: "block" });
const budget = { limit_usd: 20, warning_usd: 16, billed_usd: 15, reserved_usd: 2, remaining_usd: 3,
  reset_at: "2026-09-28T00:00:00Z", week_start: "2026-09-21T00:00:00Z", warning: true, exhausted: false, pricing_unknown: 0 };
const agent = { id: "synthetic-agent", slug: "coordinator", name: "Coordinator", enabled: true };
async function session(page: Page) {
  await page.route("**/api/settings/traffic", route => route.fulfill({ json: { revision: 0, enabled: false, sources: [], allowed_countries: [], trusted_dns: [], trusted_ips: [], retention_days: 30, max_rows: 500000, notify_authentication: true } }));
  await page.addInitScript(() => (document.cookie = "ops_refresh=" + "pwa-test-only" + "; path=/"));
  await page.route("**/api/ai/agents", route => route.fulfill({ json: [agent] }));
  await page.route("**/api/ai/providers", route => route.fulfill({ json: [] }));
}
test("shared weekly budget distinguishes usage, reservations and early warning", async ({ page }) => {
  await session(page);
  await page.route("**/api/ai/budget", route => route.fulfill({ json: budget }));
  await page.goto("/ai-agents/settings");
  await expect(page.getByRole("heading", { name: "Weekly AI budget" })).toBeVisible();
  await expect(page.locator("dl").filter({ hasText: "Reported usage estimate" })).toContainText("$15.00");
  await expect(page.locator("dl").filter({ hasText: "Reported usage estimate" })).toContainText("$2.00");
  await expect(page.getByRole("alert").filter({ hasText: "running low" })).toContainText("$3.00 remains");
  await expect(page.getByRole("progressbar", { name: "Weekly AI budget committed" })).toHaveAttribute("value", "17");
  await expect(page.getByText(/Warning at \$16.00/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});
test("exhausted budget pauses new calls and failed refresh does not display stale remaining funds", async ({ page }) => {
  await session(page);
  await page.clock.install();
  let unavailable = false;
  await page.route("**/api/ai/budget", route => route.fulfill(unavailable ? { status: 403, json: { detail: "Synthetic status unavailable" } } : { json: { ...budget, billed_usd: 18, remaining_usd: 0, exhausted: true } }));
  await page.goto("/ai-agents/settings");
  await expect(page.getByRole("alert").filter({ hasText: "budget exhausted" })).toContainText("paused");
  unavailable = true;
  await page.clock.fastForward(16000);
  await expect(page.getByText("Weekly budget status is unavailable.", { exact: false })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Weekly AI budget committed" })).toHaveCount(0);
});
test("IM automation settings preserve owner, show memory and omit readonly fields", async ({ page }) => {
  await session(page);
  let config = { revision: 1, talk_enabled: true, categories: ["disk"], severities: ["warning"], excluded_rules: [], excluded_resources: [], recovery_minutes: 30, talk_progress: false, transport_enabled: true,
    auto_investigate: false, investigation_agent: "coordinator", investigation_owner_user_id: "synthetic-owner", max_active_investigations: 2, memory_enabled: true };
  let saved: Record<string, unknown> | null = null;
  await page.route("**/api/settings/incidents", route => {
    if (route.request().method() === "PUT") { saved = route.request().postDataJSON(); config = { ...config, ...saved, revision: 2 }; }
    return route.fulfill({ json: config });
  });
  await page.goto("/settings?tab=incidents");
  await expect(page.getByText("Troubleshooting memory for the investigation owner: enabled.")).toBeVisible();
  await page.getByLabel("Investigate new incidents automatically").check();
  await page.getByLabel("Concurrent incident investigations", { exact: true }).fill("3");
  await page.getByRole("button", { name: "Save incident settings" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Incident notification settings saved" })).toBeVisible();
  expect(saved).toMatchObject({ auto_investigate: true, investigation_agent: "coordinator", investigation_owner_user_id: "synthetic-owner", max_active_investigations: 3 });
  expect(saved).not.toHaveProperty("memory_enabled");
  expect(saved).not.toHaveProperty("transport_enabled");
});
test("IM investigation link opens its report without marking the incident resolved", async ({ page }) => {
  await session(page);
  await page.route("**/api/incidents/42", route => route.fulfill({ json: {
    id: 42, category: "disk", rule: "disk_capacity", resource: "demo-host /data", title: "Storage capacity", severity: "warning", status: "in_progress", source_state: "firing", details: {}, observations: 1, revision: 1,
    created_at: "2026-09-21T01:00:00Z", last_seen: "2026-09-21T01:00:00Z", completed_at: null, updated_by: null, talk_policy: "muted", history: [], deliveries: [],
    investigation: { task_id: "synthetic-task", status: "completed", agent_id: agent.id, created_at: "2026-09-21T01:01:00Z" }
  } }));
  await page.route("**/api/ai/tasks?*", route => route.fulfill({ json: [] }));
  await page.route("**/api/ai/tasks/synthetic-task", route => route.fulfill({ json: { id: "synthetic-task", agent_id: agent.id, source: "incident", status: "completed", input_message: "Investigate IM-000042", response_message: "Capacity checked. Expansion requires approval.", error_message: null } }));
  await page.goto("/incidents/42");
  await page.getByRole("link", { name: "View investigation and findings" }).click();
  await expect(page).toHaveURL(/task=synthetic-task/);
  await expect(page.getByText("Capacity checked. Expansion requires approval.")).toBeVisible();
  await expect(page.getByText(/before marking the incident resolved/)).toBeVisible();
});

test("unpriced usage is distinguished from an exhausted money allowance", async ({ page }) => {
  await session(page);
  await page.route("**/api/ai/budget", route => route.fulfill({ json: { ...budget, billed_usd: 0, reserved_usd: 0, remaining_usd: 20, warning: false, exhausted: true, pricing_unknown: 1 } }));
  await page.goto("/ai-agents/settings");
  await expect(page.getByRole("alert").filter({ hasText: "no verified price" })).toBeVisible();
  await expect(page.getByText("Weekly AI budget exhausted.", { exact: false })).toHaveCount(0);
});

async function setBudgetPageVisibility(page: Page, visibility: "visible" | "hidden") {
  await page.evaluate(value => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visibility);
}

async function configurationSession(page: Page) {
  await session(page);
  await page.clock.install();
  const provider = { id: "fixture-provider", slug: "fixture", kind: "openai", display_name: "Fixture provider", base_url: null, default_model: "initial-provider-model", enabled: false, has_key: true };
  const configuredAgent = { ...agent, description: "Fixture agent", provider_id: provider.id, model: "initial-agent-model", system_prompt: "Original diagnostic instructions", max_tool_calls: 64, status: "idle", allowed_tools: [], allowed_hosts: [], allowed_environments: [], current_task: null, last_activity_at: null, error_message: null };
  const saved = { agent: null as Record<string, unknown> | null, provider: null as Record<string, unknown> | null };
  await page.route("**/api/ai/agents", route => route.fulfill({ json: [configuredAgent] }));
  await page.route("**/api/ai/providers", route => route.fulfill({ json: [provider] }));
  await page.route("**/api/ai/budget", route => route.fulfill({ json: budget }));
  await page.route(`**/api/ai/agents/${configuredAgent.id}`, async route => {
    saved.agent = route.request().postDataJSON();
    Object.assign(configuredAgent, saved.agent);
    await route.fulfill({ json: configuredAgent });
  });
  await page.route(`**/api/ai/providers/${provider.id}`, async route => {
    saved.provider = route.request().postDataJSON();
    Object.assign(provider, saved.provider);
    await route.fulfill({ json: provider });
  });
  await page.goto("/ai-agents/agents");
  await expect(page.getByRole("button", { name: "Configuration", exact: true })).toBeVisible();
  return { provider, configuredAgent, saved };
}

test("agent configuration refreshes on open and preserves edits during background refresh", async ({ page }) => {
  const state = await configurationSession(page);
  state.configuredAgent.model = "cheaper-agent-model";
  state.configuredAgent.system_prompt = "Current diagnostic instructions";
  await page.clock.fastForward(16000);
  await expect(page.locator("p").filter({ hasText: "Model:" })).toContainText("cheaper-agent-model");
  await page.getByRole("button", { name: "Configuration", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Coordinator - configuration", exact: true });
  const model = dialog.getByLabel("Model override (blank = provider default)", { exact: true });
  await expect(model).toHaveValue("cheaper-agent-model");
  await expect(dialog.getByLabel("System prompt", { exact: true })).toHaveValue("Current diagnostic instructions");
  await dialog.getByLabel("System prompt", { exact: true }).fill("Keep this operator edit.");
  state.configuredAgent.system_prompt = "Another background revision";
  await page.clock.fastForward(16000);
  await expect(dialog.getByLabel("System prompt", { exact: true })).toHaveValue("Keep this operator edit.");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.saved.agent).toMatchObject({ model: "cheaper-agent-model", system_prompt: "Keep this operator edit.", max_tool_calls: 64 });
  state.configuredAgent.model = "latest-agent-model";
  await page.clock.fastForward(16000);
  await expect(page.locator("p").filter({ hasText: "Model:" })).toContainText("latest-agent-model");
  await page.getByRole("button", { name: "Configuration", exact: true }).click();
  await expect(model).toHaveValue("latest-agent-model");
});

test("provider configuration refreshes its model without enabling a disabled provider", async ({ page }) => {
  const state = await configurationSession(page);
  state.provider.default_model = "cheaper-provider-model";
  await page.clock.fastForward(16000);
  await expect(page.locator("p").filter({ hasText: "cheaper-provider-model" })).toBeVisible();
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Fixture provider", exact: true });
  const model = dialog.getByLabel("Default model", { exact: true });
  await expect(model).toHaveValue("cheaper-provider-model");
  await model.fill("operator-selected-model");
  state.provider.default_model = "another-provider-model";
  await page.clock.fastForward(16000);
  await expect(page.locator("p").filter({ hasText: "another-provider-model" })).toHaveCount(1);
  await expect(model).toHaveValue("operator-selected-model");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.saved.provider).toMatchObject({ default_model: "operator-selected-model" });
  expect(state.saved.provider).not.toHaveProperty("enabled");
  expect(state.provider.enabled).toBe(false);
});

test("weekly budget polling serializes slow requests and pauses while the page is hidden", async ({ page }) => {
  await session(page);
  await page.clock.install();
  let requests = 0;
  let release: () => void = () => {};
  const heldResponse = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/ai/budget", async route => {
    requests += 1;
    const index = requests;
    if (index === 2) await heldResponse;
    await route.fulfill({ json: index === 1 ? budget : { ...budget, billed_usd: 17, reserved_usd: 2, remaining_usd: 1 } });
  });
  await page.goto("/ai-agents/settings");
  await expect(page.getByRole("alert").filter({ hasText: "running low" })).toContainText("$3.00 remains");
  await page.clock.fastForward(16000);
  await expect.poll(() => requests).toBe(2);
  await page.clock.fastForward(31000);
  expect(requests).toBe(2);
  release();
  await expect(page.getByRole("alert").filter({ hasText: "running low" })).toContainText("$1.00 remains");
  await setBudgetPageVisibility(page, "hidden");
  await page.clock.fastForward(31000);
  expect(requests).toBe(2);
  await setBudgetPageVisibility(page, "visible");
  await expect.poll(() => requests).toBe(3);
  await expect(page.getByRole("progressbar", { name: "Weekly AI budget committed" })).toHaveAttribute("value", "19");
});
test("an administrator changes the weekly limit after confirming the password", async ({ page }) => {
  await session(page);
  let current = { ...budget };
  const sent: unknown[] = [];
  let reauthed = false;
  await page.route("**/api/ai/budget", async route => {
    if (route.request().method() === "PUT") {
      sent.push(route.request().postDataJSON());
      if (!reauthed) return route.fulfill({ status: 403, json: { detail: "reauthentication required" }, headers: { "X-Reauth-Required": "1" } });
      current = { ...budget, limit_usd: 35, warning_usd: 28, remaining_usd: 18, warning: false };
    }
    return route.fulfill({ json: current });
  });
  await page.route("**/api/auth/reauth", async route => {
    reauthed = true;
    return route.fulfill({ json: { access_token: "pwa-test-only", role: "admin", username: "PWA Test" } });
  });
  await page.goto("/ai-agents/settings");
  await page.getByRole("button", { name: "Change limit" }).click();
  const input = page.getByLabel("Weekly limit (USD)");
  await input.fill("0");
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  await input.fill("35");
  await page.getByRole("button", { name: "Save" }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm it is you" });
  await confirm.getByLabel("Password").fill("synthetic");
  await confirm.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("$35.00 per week")).toBeVisible();
  expect(sent.at(-1)).toEqual({ limit_usd: 35 });
});
