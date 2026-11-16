import { expect, test, type Page } from "@playwright/test";
test.use({ serviceWorkers: "block" });

const nova = { id: "agent-nova", slug: "nova", name: "Nova", enabled: true, status: "idle", provider_id: "provider-local", model: null,
  allowed_tools: ["web_search", "web_fetch", "dispatch_to_agent"], allowed_hosts: [], allowed_environments: [], allowed_dispatch_targets: ["coordinator"],
  personal: true, runtime: "native", current_task: null, error_message: null, description: "Personal assistant", responsibility: null, system_prompt: "",
  autonomy_level: 0, max_tool_calls: 12, max_execution_seconds: 900, last_activity_at: null, updated_at: "2026-10-25T08:00:00Z" };
const coordinator = { ...nova, id: "agent-coordinator", slug: "coordinator", name: "Coordinator", personal: false, allowed_dispatch_targets: null };
const local = { id: "provider-local", slug: "local-llm", kind: "openai_compatible", display_name: "Synthetic local", base_url: "https://llm.example/v1", default_model: "local-model", has_key: false, enabled: true, updated_at: "2026-10-25T08:00:00Z" };
const cloud = { ...local, id: "provider-cloud", slug: "anthropic", kind: "anthropic", display_name: "Synthetic cloud", default_model: "cloud-model" };
const note = (id: string, key: string, agent_id: string | null) => ({ id, key, agent_id, content: `Synthetic ${key}`, source_task_id: null, updated_at: "2026-10-25T08:00:00Z" });
const delegated = { id: "task-1", agent_id: nova.id, requested_by: "owner", source: "web", conversation_key: null, input_message: "Restart the demo service on demo-host",
  response_message: "Coordinator requested approval ACT-2026-0000AAAA.", status: "completed", error_message: null, agents_used: ["nova", "coordinator"], tools_used: [],
  data_sources: [], confidence: null, started_at: null, completed_at: null, duration_ms: null, created_at: "2026-10-25T08:00:00Z" };
const chatOnly = { ...delegated, id: "task-2", input_message: "Private chat only", agents_used: ["nova"] };

const pending = [
  { id: "s1", agent_id: "agent-nova", key: "morning_run", content: "Runs before work", source: "conversation", evidence_task_id: null, status: "pending", created_at: "2026-10-25T08:00:00Z", decided_at: null },
  { id: "s2", agent_id: "agent-nova", key: "chatgpt.diet", content: "Synthetic imported item", source: "import", evidence_task_id: null, status: "pending", created_at: "2026-10-25T08:00:00Z", decided_at: null },
];

async function session(page: Page, { provider = local, memory = true } = {}) {
  const saved: unknown[] = [];
  await page.addInitScript(() => (document.cookie = "ops_refresh=" + "pwa-test-only" + "; path=/"));
  await page.route("**/api/ai/agents", route => route.fulfill({ json: [nova, coordinator].map(a => a.slug === "nova" ? { ...a, provider_id: provider.id } : a) }));
  await page.route("**/api/ai/providers", route => route.fulfill({ json: [local, cloud] }));
  await page.route("**/api/ai/tasks?*", route => {
    // Only the owner's own nova tasks are requested for the activity list.
    const url = new URL(route.request().url());
    const own = url.searchParams.get("agent") === "nova" && url.searchParams.get("mine") === "true";
    return route.fulfill({ json: own ? [delegated, chatOnly] : [] });
  });
  await page.route("**/api/ai/actions?*", route => route.fulfill({ json: [
    { id: "action-1", request_code: "ACT-2026-0000AAAA", task_id: "task-1", action: "Restart demo service", risk: "medium", status: "pending" },
    { id: "action-2", request_code: "ACT-2026-0000BBBB", task_id: "someone-else", action: "Unrelated", risk: "low", status: "pending" },
  ] }));
  await page.route("**/api/ai/memory/suggestions?*", route => route.fulfill({ json: { items: pending } }));
  await page.route("**/api/ai/memory/suggestions/*/*", route => {
    saved.push({ url: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    return route.fulfill({ json: { ...pending[0], status: "accepted" } });
  });
  await page.route("**/api/ai/memory", route => {
    if (route.request().method() === "PUT") { saved.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); }
    return route.fulfill({ json: { enabled: memory, items: [note("n1", "coffee", nova.id), note("n2", "preferred_language", null),
      note("n3", "linux_runbook", coordinator.id), note("n4", "claude.homelab.01", null)] } });
  });
  return saved;
}

test("nova overview shows a local provider and only its own Ops Center requests", async ({ page }) => {
  await session(page);
  await page.goto("/ai-agents/nova");
  await expect(page.getByRole("heading", { name: "Nova" })).toBeVisible();
  await expect(page.getByText("Synthetic local / local-model")).toBeVisible();
  await expect(page.getByText("Local", { exact: true })).toBeVisible();
  await expect(page.getByText("Restart the demo service on demo-host")).toBeVisible();
  await expect(page.getByText("Private chat only")).toHaveCount(0);
  await expect(page.getByText("1 waiting for approval")).toBeVisible();
  await expect(page.getByText("ACT-2026-0000BBBB")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Chat with Nova" })).toHaveAttribute("href", "/ai-agents/chat?agent=nova");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test("nova warns when its provider is a cloud service", async ({ page }) => {
  await session(page, { provider: cloud, memory: false });
  await page.goto("/ai-agents/nova");
  await expect(page.getByRole("alert").filter({ hasText: "sent to Synthetic cloud" })).toBeVisible();
  await expect(page.getByText("Cloud", { exact: true })).toBeVisible();
  await expect(page.getByText("Nova uses no notes or earlier conversations.", { exact: false })).toBeVisible();
});

test("what nova knows lists shared and nova notes and saves in nova scope", async ({ page }) => {
  const saved = await session(page);
  await page.goto("/ai-agents/nova");
  await page.getByRole("tab", { name: "What Nova knows" }).click();
  await expect(page.getByText("coffee", { exact: true })).toBeVisible();
  await expect(page.getByText("preferred_language", { exact: true })).toBeVisible();
  await expect(page.getByText("linux_runbook")).toHaveCount(0);
  await expect(page.getByText("claude.homelab.01")).toHaveCount(0);
  await expect(page.getByText("1 imported homelab notes (claude.*)", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Add memory" }).click();
  await page.getByLabel("Memory key").fill("morning_routine");
  await page.getByLabel("Memory content").fill("Synthetic routine");
  await page.getByRole("button", { name: "Save note" }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0]).toEqual({ key: "morning_routine", content: "Synthetic routine", agent_id: nova.id, category: null, kind: "fact" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test("nova has its own 2D Ops Floor desk without overlapping others", async ({ page }) => {
  await session(page);
  await page.addInitScript(() => { localStorage.setItem("ops_floor_view", "2d"); localStorage.removeItem("ops-floor-2d-layout-v3"); });
  await page.route("**/api/ai/agents/stream?*", route => route.fulfill({ status: 204, body: "" }));
  await page.goto("/ai-agents/ops-floor");
  await expect(page.locator('[data-agent="nova"]')).toBeVisible();
  const boxes = await page.locator("[data-floor-canvas] [data-agent]").evaluateAll(cards => cards.map(card => {
    const r = card.getBoundingClientRect();
    return { slug: card.getAttribute("data-agent"), left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }));
  expect(boxes.length).toBeGreaterThanOrEqual(2);
  for (const a of boxes) for (const b of boxes) {
    if (a.slug! >= b.slug!) continue;
    const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    expect(overlap, `${a.slug} overlaps ${b.slug}`).toBeFalsy();
  }
});

test("accept all saves every shown suggestion after confirming and reports failures", async ({ page }) => {
  await session(page);
  const bulk: unknown[] = [];
  await page.route("**/api/ai/memory/suggestions/accept-all", route => {
    bulk.push(route.request().postDataJSON());
    return route.fulfill({ json: { accepted: 1, failed: [{ id: "s2", key: "chatgpt.diet", error: "A note with this key already exists in that scope." }] } });
  });
  await page.goto("/ai-agents/nova");
  await page.getByRole("tab", { name: "Suggestions (2)" }).click();
  page.once("dialog", dialog => void dialog.dismiss());
  await page.getByRole("button", { name: "Accept all (2)" }).click();
  expect(bulk).toEqual([]);
  page.once("dialog", dialog => { expect(dialog.message()).toContain("Accept all 2 suggestions"); void dialog.accept(); });
  await page.getByRole("button", { name: "Accept all (2)" }).click();
  await expect.poll(() => bulk).toEqual([{ ids: ["s1", "s2"] }]);
  const result = page.locator("[data-accept-all-result]");
  await expect(result).toContainText("Accepted 1; 1 could not be saved");
  await expect(result).toContainText("chatgpt.diet: A note with this key already exists");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test("suggestions can be edited and accepted or rejected, nothing saved before", async ({ page }) => {
  const saved = await session(page);
  await page.goto("/ai-agents/nova");
  await page.getByRole("tab", { name: "Suggestions (2)" }).click();
  await expect(page.getByText("Runs before work")).toBeVisible();
  await expect(page.getByText("Imported", { exact: true })).toBeVisible();
  expect(saved).toEqual([]);
  const first = page.locator('[data-suggestion="morning_run"]');
  await first.getByRole("button", { name: "Edit" }).click();
  await first.getByLabel("Suggested note").fill("Runs at 06:30 before work");
  await first.getByRole("button", { name: "Save and accept" }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0]).toEqual({ url: "/api/ai/memory/suggestions/s1/accept", body: { key: "morning_run", content: "Runs at 06:30 before work" } });
  await page.locator('[data-suggestion="chatgpt.diet"]').getByRole("button", { name: "Reject" }).click();
  await expect.poll(() => saved.length).toBe(2);
  expect(saved[1]).toMatchObject({ url: "/api/ai/memory/suggestions/s2/reject" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test("import previews before saving, then imports a memory list and a ChatGPT export", async ({ page }) => {
  await session(page);
  const posts: { path: string; form: string }[] = [];
  await page.route("**/api/ai/imports", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { memory_enabled: true, conversations: 4, analyzed: 1, pending_import_suggestions: 0, max_upload_mb: 200 } });
    posts.push({ path: "/api/ai/imports", form: route.request().postData() ?? "" });
    const kind = (route.request().postData() ?? "").includes("chatgpt_export") ? "chatgpt_export" : "memory_list";
    return route.fulfill({ json: kind === "memory_list"
      ? { kind, imported: true, items: 2, new_suggestions: 2, already_suggested: 0, filtered_secrets: 1, duplicates: 0, skipped_short: 0, sample: [] }
      : { kind, imported: true, conversations: 3, new: 2, updated: 1, unchanged: 0, filtered_secret_lines: 1, skipped_empty: 0, ignored_files: 2, sample: [] } });
  });
  await page.route("**/api/ai/imports/preview", route => {
    posts.push({ path: "/api/ai/imports/preview", form: route.request().postData() ?? "" });
    const kind = (route.request().postData() ?? "").includes("chatgpt_export") ? "chatgpt_export" : "memory_list";
    return route.fulfill({ json: kind === "memory_list"
      ? { kind, items: 2, new_suggestions: 2, already_suggested: 0, filtered_secrets: 1, duplicates: 0, skipped_short: 0, sample: ["Prefers short answers"] }
      : { kind, conversations: 3, new: 2, updated: 1, unchanged: 0, filtered_secret_lines: 1, skipped_empty: 0, ignored_files: 2, sample: ["Coffee"] } });
  });
  await page.route("**/api/ai/imports/suggest-estimate", route => route.fulfill({ json: { conversations: 3, model_calls: 1, input_tokens: 4000, output_tokens: 900, provider: "Synthetic local", local: true, cost_usd: 0, note: null } }));
  await page.route("**/api/ai/imports/suggest", route => { posts.push({ path: "/api/ai/imports/suggest", form: route.request().postData() ?? "" }); return route.fulfill({ json: { queued: true } }); });
  await page.route("**/api/ai/imports/chatgpt", route => { posts.push({ path: "/api/ai/imports/chatgpt", form: route.request().method() }); return route.fulfill({ json: { deleted_conversations: 4, deleted_suggestions: 2, deleted_notes: 1 } }); });
  await page.goto("/ai-agents/nova");
  await page.getByRole("tab", { name: "Import" }).click();

  await page.getByLabel("Memory list source").selectOption("gemini");
  await page.getByLabel("Paste memory list").fill("- Prefers short answers\n- Runs before work");
  await expect(page.getByRole("button", { name: "Import as suggestions" })).toBeDisabled();
  await page.getByRole("button", { name: "Preview" }).first().click();
  await expect(page.getByText("Preview: nothing has been saved yet")).toBeVisible();
  expect(posts.map(p => p.path)).toEqual(["/api/ai/imports/preview"]);
  expect(posts[0].form).toContain("memory_list");
  expect(posts[0].form).toContain("gemini");
  await page.getByRole("button", { name: "Import as suggestions" }).click();
  await expect(page.locator('[data-import-summary="memory_list"]').getByText("Imported", { exact: true })).toBeVisible();

  await page.getByLabel("ChatGPT export file").setInputFiles({ name: "export.zip", mimeType: "application/zip", buffer: Buffer.from("PK synthetic") });
  await page.getByRole("button", { name: "Preview" }).nth(1).click();
  await expect(page.locator('[data-import-summary="chatgpt_export"]')).toContainText("user.json is recognized but never stored.");
  await page.getByRole("button", { name: "Import archive" }).click();
  await expect.poll(() => posts.filter(p => p.path === "/api/ai/imports").length).toBe(2);
  expect(posts.filter(p => p.path === "/api/ai/imports")[1].form).toContain("chatgpt_export");

  await expect(page.getByRole("button", { name: "Confirm and suggest facts" })).toBeDisabled();
  await page.getByRole("button", { name: "Estimate" }).click();
  await expect(page.locator("[data-import-estimate]")).toContainText("runs on Synthetic local, no API cost");
  await page.getByRole("button", { name: "Confirm and suggest facts" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Started." })).toBeVisible();
  expect(posts.find(p => p.path === "/api/ai/imports/suggest")?.form).toBe('{"confirm":true}');

  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Delete all imported ChatGPT data" }).click();
  await expect(page.getByText("Deleted 4 conversations, 2 suggestions and 1 notes.")).toBeVisible();
  expect(posts.at(-1)).toEqual({ path: "/api/ai/imports/chatgpt", form: "DELETE" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});
