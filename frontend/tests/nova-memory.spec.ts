import { expect, test, type Page } from "@playwright/test";
test.use({ serviceWorkers: "block" });

const NOVA = "agent-nova";
const agent = { id: NOVA, slug: "nova", name: "Nova", enabled: true, status: "idle", provider_id: "p1", model: null, allowed_tools: [], allowed_hosts: [],
  allowed_environments: [], allowed_dispatch_targets: ["coordinator"], personal: true, runtime: "native", current_task: null, error_message: null,
  description: "", responsibility: null, system_prompt: "", autonomy_level: 0, max_tool_calls: 12, max_execution_seconds: 900, last_activity_at: null,
  updated_at: "2026-10-25T08:00:00Z" };
const provider = { id: "p1", slug: "local-llm", kind: "openai_compatible", display_name: "Synthetic local", base_url: "https://llm.example/v1", default_model: "m", has_key: false, enabled: true, updated_at: "" };
const at = "2026-10-25T08:00:00Z";
const note = (id: string, key: string, content: string, agent_id: string | null, category: string | null = null) =>
  ({ id, key, content, agent_id, category, kind: null, source_task_id: null, created_at: at, updated_at: at });
const NOTES = [
  note("n1", "career.current_employer.with_a_very_long_key_that_never_breaks_on_its_own_xxxxxxxxxxxxxxxx", "Platform engineer at Sample ASA.", NOVA, "Career & Work"),
  note("n2", "homelab.proxmox", "Three Proxmox nodes with Ceph storage.", null, "Homelab Infrastructure"),
  note("n3", "homelab.proxmox_cluster", "Three Proxmox nodes with Ceph storage and 10G.", null, "Homelab Infrastructure"),
  note("n4", "pref.answers", "Prefers short answers in Norwegian.", NOVA),
  note("n5", "claude.homelab.01", "Imported.", null),
];
const proposals = [
  { id: "p1", key: "family.household", category: "Family & Lifestyle", kind: "fact", content: "Lives in Springfield.", scope: "nova", suggested_scope: "nova", action: "create", reason: null, target: null, section: 0 },
  { id: "p2", key: "career.current_employer", category: "Career & Work", kind: "fact", content: "Principal engineer at Sample ASA.", scope: "nova", suggested_scope: "nova",
    action: "update", reason: "same key", target: { id: "n1", key: "career.current_employer", category: "Career & Work", kind: "fact", content: "Platform engineer at Sample ASA.", scope: "nova" }, section: 0 },
  { id: "p3", key: "homelab.gpu", category: "AI & GPU Infrastructure", kind: "fact", content: "RTX 3080 laptop serves local models.", scope: "nova", suggested_scope: "shared", action: "create", reason: null, target: null, section: 1 },
  { id: "p4", key: "pref.answers", category: null, kind: "fact", content: "Prefers short answers in Norwegian.", scope: "nova", suggested_scope: "nova", action: "unchanged", reason: "same text",
    target: { id: "n4", key: "pref.answers", category: null, kind: "fact", content: "Prefers short answers in Norwegian.", scope: "nova" }, section: 1 },
];

async function session(page: Page) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let jobStatus = "running";
  const record = (route: import("@playwright/test").Route) => {
    const request = route.request();
    calls.push({ method: request.method(), path: new URL(request.url()).pathname, body: request.postDataJSON?.() ?? null });
  };
  await page.addInitScript(() => (document.cookie = "ops_refresh=" + "pwa-test-only" + "; path=/"));
  await page.route("**/api/ai/agents", route => route.fulfill({ json: [agent] }));
  await page.route("**/api/ai/providers", route => route.fulfill({ json: [provider] }));
  await page.route("**/api/ai/tasks?*", route => route.fulfill({ json: [] }));
  await page.route("**/api/ai/actions?*", route => route.fulfill({ json: [] }));
  await page.route("**/api/ai/imports", route => route.fulfill({ json: { memory_enabled: true, conversations: 0, analyzed: 0, pending_import_suggestions: 0, max_upload_mb: 200 } }));
  await page.route("**/api/ai/memory/suggestions?*", route => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/ai/memory/duplicates", route => route.fulfill({ json: { pairs: [{ a: "n2", b: "n3", score: 0.8 }] } }));
  await page.route("**/api/ai/memory/history?*", route => route.fulfill({ json: { items: [
    { id: "v1", memory_id: null, agent_id: NOVA, key: "pref.old", category: null, kind: null, content: "Deleted synthetic note.", change: "delete", changed_by: "owner", created_at: at }] } }));
  await page.route("**/api/ai/memory/history/*/restore", route => { record(route); return route.fulfill({ json: NOTES[3] }); });
  await page.route("**/api/ai/memory/merge", route => { record(route); return route.fulfill({ json: NOTES[1] }); });
  await page.route("**/api/ai/memory/organize", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { items: [] } });
    calls.push({ method: "POST", path: "/api/ai/memory/organize", body: route.request().postData() });
    return route.fulfill({ json: { id: "job1", status: "queued", source_name: "Pasted text", created_at: at, finished_at: null, proposals: [], proposal_count: 0,
      sections: [{ index: 0, chars: 100, status: "pending", error: null, secrets: null, dropped: null }, { index: 1, chars: 100, status: "pending", error: null, secrets: null, dropped: null }] } });
  });
  await page.route("**/api/ai/memory/organize/job1", route => {
    const done = jobStatus !== "running";
    jobStatus = "done";
    return route.fulfill({ json: { id: "job1", status: done ? "partial" : "running", source_name: "Pasted text", created_at: at, finished_at: null,
      sections: [{ index: 0, chars: 100, status: "done", error: null, secrets: 1, dropped: 0 }, { index: 1, chars: 100, status: done ? "failed" : "pending", error: done ? "synthetic outage" : null, secrets: 0, dropped: 0 }],
      proposals: done ? proposals : [], proposal_count: done ? proposals.length : 0 } });
  });
  let applies = 0;
  await page.route("**/api/ai/memory/organize/job1/apply", route => {
    record(route);
    applies += 1;
    if (applies === 1) return route.fulfill({ status: 422, json: { detail: { message: "Nothing was saved; fix these items.", errors: [{ index: 2, key: "homelab.gpu", error: "Synthetic key clash." }] } } });
    return route.fulfill({ json: { created: 2, updated: 1, skipped: 1 } });
  });
  await page.route("**/api/ai/memory/*", route => {
    if (["PATCH", "DELETE"].includes(route.request().method())) { record(route); return route.fulfill(route.request().method() === "DELETE" ? { status: 204, body: "" } : { json: NOTES[0] }); }
    return route.fallback();
  });
  await page.route("**/api/ai/memory", route => {
    if (route.request().method() === "PUT") { record(route); return route.fulfill({ json: { ok: true } }); }
    return route.fulfill({ json: { enabled: true, items: NOTES } });
  });
  return calls;
}

async function openKnowledge(page: Page) {
  await page.goto("/ai-agents/nova");
  await page.getByRole("tab", { name: "What Nova knows" }).click();
}

test("memories are grouped by category, filtered, searched, edited, merged and restored", async ({ page }) => {
  const calls = await session(page);
  await openKnowledge(page);
  await expect(page.locator('[data-category="Career & Work"]')).toBeVisible();
  await expect(page.locator('[data-category="Homelab Infrastructure"] [data-note]')).toHaveCount(2);
  await expect(page.locator('[data-category="Uncategorized"]')).toContainText("pref.answers");
  await expect(page.getByText("claude.homelab.01")).toHaveCount(0);
  await expect(page.locator('[data-note="homelab.proxmox"]')).toContainText("Possible duplicate of homelab.proxmox_cluster");

  await page.getByLabel("Filter by scope").selectOption("shared");
  await expect(page.locator("[data-note]")).toHaveCount(2);
  await page.getByLabel("Filter by scope").selectOption("all");
  await page.getByLabel("Search memories").fill("norwegian");
  await expect(page.locator("[data-note]")).toHaveCount(1);
  await page.getByLabel("Search memories").fill("");
  await page.locator('[data-category="Homelab Infrastructure"] button[aria-expanded]').click();
  await expect(page.locator('[data-category="Homelab Infrastructure"] [data-note]')).toHaveCount(0);
  await page.locator('[data-category="Homelab Infrastructure"] button[aria-expanded]').click();

  await page.locator('[data-note="pref.answers"]').getByRole("button", { name: "Edit" }).click();
  const editor = page.locator("[data-note-editor]");
  await editor.getByLabel("Memory category").fill("Communication Preferences");
  await editor.getByLabel("Scope").selectOption("shared");
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => calls.find(c => c.method === "PATCH")?.body).toMatchObject({ category: "Communication Preferences", agent_id: null });

  await page.getByLabel("Select homelab.proxmox for merging").check();
  await page.getByLabel("Select homelab.proxmox_cluster for merging").check();
  await page.getByRole("button", { name: "Merge selected (2)" }).click();
  await page.getByLabel("Merged key").fill("homelab.cluster");
  await page.getByRole("button", { name: "Merge notes" }).click();
  await expect.poll(() => calls.find(c => c.path === "/api/ai/memory/merge")?.body).toMatchObject({ ids: ["n2", "n3"], key: "homelab.cluster", agent_id: null });

  page.once("dialog", dialog => dialog.accept());
  await page.locator('[data-note="pref.answers"]').getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => calls.some(c => c.method === "DELETE")).toBeTruthy();
  await page.getByRole("button", { name: "Recently deleted" }).click();
  await page.locator('[data-version="v1"]').getByRole("button", { name: "Restore this version" }).click();
  await expect.poll(() => calls.some(c => c.path === "/api/ai/memory/history/v1/restore")).toBeTruthy();
});

test("Import & Organize: analyze, review, fix a rejected item and save all", async ({ page }) => {
  const calls = await session(page);
  await page.clock.install();
  await openKnowledge(page);
  await page.getByLabel("Text to organize").fill("# About me\nI live in Springfield.\n\n# Work\nPrincipal engineer.");
  await page.getByRole("button", { name: "Analyze & Organize" }).click();
  await expect(page.locator('[data-organize-status="queued"], [data-organize-status="running"]')).toBeVisible();
  await page.clock.fastForward(3100);
  await page.clock.fastForward(3100);
  await expect(page.locator('[data-organize-status="partial"]')).toBeVisible();
  await expect(page.getByText("Section 2 failed: synthetic outage")).toBeVisible();
  await expect(page.getByText("1 line(s) that looked like credentials were removed before analysis.")).toBeVisible();
  await expect(page.getByText("2 new, 1 updates, 1 already known.", { exact: false })).toBeVisible();

  const gpu = page.locator('[data-proposal="homelab.gpu"]');
  await expect(gpu.getByLabel("Proposed scope")).toHaveValue("nova");
  await gpu.getByRole("button", { name: "Use it" }).click();
  await expect(gpu.getByLabel("Proposed scope")).toHaveValue("shared");
  await expect(page.locator('[data-proposal="pref.answers"]').getByLabel("Save pref.answers")).not.toBeChecked();
  await page.locator('[data-proposal="career.current_employer"]').getByText("Current text of", { exact: false }).click();
  await expect(page.locator('[data-proposal="career.current_employer"]')).toContainText("Platform engineer at Sample ASA.");

  await page.getByRole("button", { name: "Save All (3)" }).click();
  await expect(gpu.getByRole("alert")).toHaveText("Synthetic key clash.");
  const first = calls.find(c => c.path === "/api/ai/memory/organize/job1/apply")?.body as { items: Record<string, unknown>[] };
  expect(first.items.map(i => i.action)).toEqual(["create", "update", "create", "skip"]);
  expect(first.items[1]).toMatchObject({ target_id: "n1", scope: "nova" });
  expect(first.items[2]).toMatchObject({ key: "homelab.gpu", scope: "shared", target_id: null });

  await gpu.getByLabel("Proposed key").fill("ai.gpu_laptop");
  await page.getByRole("button", { name: "Save All (3)" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved: 2 new, 1 updated, 1 skipped." })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test("long keys never overlap the note actions on a phone", async ({ page }) => {
  await session(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openKnowledge(page);
  const card = page.locator('[data-note^="career.current_employer"]');
  const key = await card.locator("span.font-mono").boundingBox();
  const box = await card.boundingBox();
  const buttons = await card.getByRole("button").evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; }));
  expect(key && box && key.x + key.width <= box.x + box.width + 1).toBeTruthy();
  for (const b of buttons) expect(b.top >= key!.y + key!.height || b.bottom <= key!.y, "button overlaps the key").toBeTruthy();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});
