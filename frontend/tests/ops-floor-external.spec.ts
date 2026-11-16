import { expect, test } from "@playwright/test";
test.use({ serviceWorkers: "block" });

const external = ["ext-coordinator", "ext-coder", "ext-reader", "ext-reviewer"].map((slug, i) => ({
  id: `agent-${i}`, slug, name: slug, enabled: true, status: "idle", runtime: "external", provider_id: null, model: null,
  allowed_tools: [], allowed_hosts: [], allowed_environments: [], current_task: null, description: "Synthetic external agent",
  error_message: null, responsibility: null, system_prompt: "", autonomy_level: 0, max_tool_calls: 1, max_execution_seconds: 1,
  last_activity_at: null, updated_at: "2026-10-25T08:00:00Z" }));

test("opencode agents have their own 2D group without coordinator links or chat", async ({ page }) => {
  await page.addInitScript(() => {
    (document.cookie = "ops_refresh=" + "pwa-test-only" + "; path=/");
    localStorage.setItem("ops_floor_view", "2d");
    localStorage.removeItem("ops-floor-2d-layout-v3");
  });
  await page.route("**/api/ai/**", route => route.fulfill({ json: [] }));
  await page.route("**/api/ai/agents/stream?*", route => route.fulfill({ status: 204, body: "" }));
  await page.route("**/api/ai/agents", route => route.fulfill({ json: external }));
  await page.goto("/ai-agents/ops-floor");
  for (const agent of external) await expect(page.locator(`[data-agent="${agent.slug}"]`)).toBeVisible();
  await expect(page.locator('[data-connection^="oc-"]')).toHaveCount(0);
  await page.locator('[data-agent="ext-coder"]').click();
  await expect(page.getByText("Runs in an external runtime such as opencode.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Message External Coder")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Agents", exact: true })).toHaveAttribute("href", "/ai-agents/agents");
  await expect(page.getByRole("link", { name: "Open chat" })).toHaveCount(0);
});
