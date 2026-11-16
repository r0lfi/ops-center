import { expect, test, type Page } from "@playwright/test";

import { signIn } from "./gui-helpers";

// Synthetic fixtures only.
test.use({ serviceWorkers: "block" });
const now = new Date().toISOString();
const agents = [{ id: "a1", slug: "coordinator", name: "Coordinator", description: "Entry point", enabled: true, runtime: "native" }];

async function askMocks(page: Page) {
  const asks: Record<string, unknown>[] = [];
  await page.route("**/api/ai/agents", r => r.fulfill({ json: agents }));
  await page.route("**/api/ai/history?*", r => r.fulfill({ json: { total: 0, items: [] } }));
  await page.route("**/api/ai/ask", async r => {
    asks.push(r.request().postDataJSON());
    await r.fulfill({ status: 201, json: { id: "t1", status: "queued", input_message: "q", agents_used: [], tools_used: [], data_sources: [] } });
  });
  await page.route("**/api/ai/tasks/t1", r => r.fulfill({ json: { id: "t1", status: "completed", response_message: "All good.", input_message: "q", agents_used: ["coordinator"], tools_used: [], data_sources: [], duration_ms: 1200 } }));
  await page.route("**/api/ai/actions?*", r => r.fulfill({ json: [] }));
  return asks;
}

test("Ask Ops AI opens as a compact floating window with page context, minimizes and pins", async ({ page, isMobile }) => {
  await signIn(page);
  const asks = await askMocks(page);
  await page.goto("/servers");
  await page.getByRole("button", { name: "Ask Ops AI" }).click();
  await expect(page).toHaveURL(/\/servers$/); // stays on the page
  const dialog = page.getByRole("dialog", { name: "Ask Ops AI" });
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  const viewport = page.viewportSize()!;
  if (!isMobile) expect(box.width).toBeLessThan(450);
  expect(box.width).toBeLessThanOrEqual(viewport.width);
  await expect(dialog.getByText("Context: Servers")).toBeVisible();
  await dialog.getByRole("textbox", { name: "Message" }).fill("Which servers need a reboot?");
  await dialog.getByRole("button", { name: "Send" }).click();
  await expect(dialog.getByText("All good.")).toBeVisible();
  expect(asks[0]).toMatchObject({ message: "Which servers need a reboot?", context: { page: "Servers", path: "/servers" } });

  await dialog.getByRole("button", { name: "Minimize" }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Restore Ask Ops AI" }).click();
  await expect(dialog.getByText("All good.")).toBeVisible(); // conversation kept

  if (!isMobile) {
    await dialog.getByRole("button", { name: "Pin as side panel" }).click();
    const pinned = (await dialog.boundingBox())!;
    expect(pinned.x + pinned.width).toBeCloseTo(viewport.width, 0);
    expect(pinned.height).toBeGreaterThan(viewport.height - 2);
    // The content makes room instead of being covered.
    const heading = page.getByRole("heading", { name: "Servers", exact: true });
    await expect.poll(async () => { const b = (await heading.boundingBox())!; return b.x + b.width; }).toBeLessThanOrEqual(pinned.x + 1);
    await dialog.getByRole("button", { name: "Close" }).click();
    await page.reload();
    await page.getByRole("button", { name: "Ask Ops AI" }).click();
    await expect(page.getByRole("button", { name: "Undock (float)" })).toBeVisible(); // layout remembered
    await page.getByRole("button", { name: "Undock (float)" }).click();
    await expect(page.getByRole("button", { name: "Pin as side panel" })).toBeVisible();
  }
  // Removing the context chip sends the next question without it.
  await page.getByRole("button", { name: "Ask without page context" }).click();
  await page.getByRole("dialog", { name: "Ask Ops AI" }).getByRole("textbox", { name: "Message" }).fill("Hello");
  await page.getByRole("dialog", { name: "Ask Ops AI" }).getByRole("button", { name: "Send" }).click();
  await expect.poll(() => asks.length).toBe(2);
  expect(asks[1].context).toBeUndefined();
});

const change = (stage: string) => ({
  id: "00000000-0000-0000-0000-000000000001", title: "file_grep tool", status: stage, stage, summary: "Read configuration lines",
  proposed_by: "Monitoring", runs: 1, files: 2, added: 40, removed: 2, has_patch: true, patch_sha256: "b".repeat(64),
  developer_run: { id: "11111111-1111-1111-1111-111111111111", status: "completed", outcome: null, requested_by: "admin", created_at: now, started_at: now, completed_at: now, duration_ms: 1000, tools_used: 6, error: null },
  approved_by: null, approved_at: null, release_ref: null, branch: "tool-proposal/00000000", created_at: now, updated_at: now, started_at: now, finished_at: now,
});

test("Developer Agent: review needs a fresh password and approves exactly the reviewed patch", async ({ page }) => {
  await signIn(page);
  let stage = "ready_for_review";
  await page.route("**/api/ai/developer/overview", r => r.fulfill({ json: { agent: { name: "Developer", status: "working", activity: "Analysing results", enabled: true, configured: true }, counts: { [stage]: 1 }, items: [change(stage)], can_decide: true } }));
  await page.route("**/api/ai/developer/changes/*", r => r.fulfill({ json: { ...change(stage), details: { missing: "grep" }, notes: "Tests added", task_id: null, traffic_events: 3,
    files_changed: [{ path: "worker_ai/ai/tools/file_grep.py", added: 30, removed: 0, status: "added", kind: "code" }, { path: "worker_ai/tests/test_file_grep.py", added: 10, removed: 2, status: "modified", kind: "test" }],
    checks: [{ name: "Credential scan", result: "passed", detail: "ok" }, { name: "Test run", result: "not_run", detail: "Run them on the branch" }],
    runs_detail: [], timeline: [{ at: now, kind: "proposed", text: "Proposed by Monitoring" }], reviews: [] } }));
  let reviewCalls = 0, reauthed = false;
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/ai/proposals/*/review", async r => {
    reviewCalls++;
    bodies.push(r.request().postDataJSON());
    if (!reauthed) return r.fulfill({ status: 403, json: { detail: "reauthentication required" }, headers: { "X-Reauth-Required": "1" } });
    stage = "approved";
    return r.fulfill({ json: { stage: "approved" } });
  });
  await page.route("**/api/auth/reauth", async r => {
    reauthed = r.request().postDataJSON().password === "correct horse";
    return reauthed ? r.fulfill({ json: { access_token: "pwa-test-only", role: "admin", username: "PWA Test" } }) : r.fulfill({ status: 403, json: { detail: "password incorrect" } });
  });
  await page.goto("/ai-agents/developer");
  await expect(page.getByText("Analysing results")).toBeVisible();
  await page.getByRole("button", { name: /file_grep tool/ }).click();
  await expect(page.getByText("worker_ai/ai/tools/file_grep.py")).toBeVisible();
  await expect(page.getByText("Not run")).toBeVisible();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm it is you" });
  await expect(confirm).toBeVisible();
  await confirm.getByLabel("Password").fill("correct horse");
  await confirm.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Approved for production")).toBeVisible();
  expect(reviewCalls).toBe(2);
  expect(bodies[1]).toMatchObject({ decision: "approve", patch_sha256: "b".repeat(64) });
  await expect(page.getByText(/apply-tool-proposal\.sh 00000000-0000-0000-0000-000000000001 .* b{64}/)).toBeVisible();
});

test("Tool proposals: a finished patch can be approved or sent back right in the list", async ({ page }) => {
  await signIn(page);
  const proposal = (id: string, status: string) => ({ id, task_id: null, title: `${status} tool`, status, details: { missing: "grep" }, has_patch: status !== "proposed",
    patch_notes: "Tests added", dev_task_id: null, decided_by: null, decided_at: null, created_at: now });
  let statuses = { a: "ready_for_review", b: "ready_for_review" } as Record<string, string>;
  const id = (k: string) => `00000000-0000-0000-0000-00000000000${k === "a" ? 1 : 2}`;
  await page.route("**/api/ai/proposals", r => r.fulfill({ json: Object.entries(statuses).map(([k, s]) => proposal(id(k), s)) }));
  await page.route("**/api/ai/developer/changes/*", r => r.fulfill({ json: { ...change("ready_for_review"), checks: [{ name: "Credential scan", result: "passed", detail: "ok" }] } }));
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/ai/proposals/*/review", async r => {
    const body = r.request().postDataJSON();
    bodies.push(body);
    const key = r.request().url().includes(id("a")) ? "a" : "b";
    statuses = { ...statuses, [key]: body.decision === "approve" ? "approved" : "changes_requested" };
    return r.fulfill({ json: { stage: statuses[key] } });
  });
  await page.goto("/ai-agents/approvals");
  const first = page.locator("details", { hasText: "ready_for_review tool" }).first();
  await expect(first.getByRole("button", { name: "Approve change" })).toBeVisible();
  await first.getByRole("button", { name: "Approve change" }).click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toMatchObject({ decision: "approve", patch_sha256: "b".repeat(64) });
  const second = page.locator("details", { hasText: "ready_for_review tool" }).first();
  await expect(second.getByRole("button", { name: "Request changes" })).toBeDisabled();
  await second.getByLabel("Review comment").fill("Add a size limit");
  await second.getByRole("button", { name: "Request changes" }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toMatchObject({ decision: "request_changes", comment: "Add a size limit" });
  await expect(page.getByRole("button", { name: "Approve change" })).toHaveCount(0);
});

test("Tool proposals: long text and run history stay folded until expanded", async ({ page }) => {
  await signIn(page);
  const long = Array.from({ length: 30 }, (_, i) => `Line ${i} of a long design description.`).join("\n");
  const notes = Array.from({ length: 12 }, (_, i) => `Developer run r${i} ended without a patch: tool budget used up`).join("\n");
  await page.route("**/api/ai/proposals", r => r.fulfill({ json: [{ id: "00000000-0000-0000-0000-000000000009", task_id: null, title: "Long proposal",
    status: "proposed", details: { missing: "grep", design: long }, has_patch: false, patch_notes: notes, dev_task_id: null, decided_by: null, decided_at: null, created_at: now }] }));
  await page.goto("/ai-agents/approvals");
  const item = page.locator("details", { hasText: "Long proposal" }).first();
  await expect(item.getByText("Developer run r11 ended")).toBeVisible();
  await expect(item.getByText("Developer run r3 ended")).toBeHidden();
  const folded = await item.locator("dl").evaluate(el => el.parentElement!.getBoundingClientRect().height);
  expect(folded).toBeLessThan(120);
  await item.getByRole("button", { name: "Show full proposal" }).click();
  await expect(item.getByRole("button", { name: "Show less" }).first()).toBeVisible();
  expect(await item.locator("dl").evaluate(el => el.parentElement!.getBoundingClientRect().height)).toBeGreaterThan(folded * 3);
  await item.getByText("Earlier developer notes (11)").click();
  await expect(item.getByText("Developer run r3 ended")).toBeVisible();
});

test("Live Map: public destinations on the map, private ones only in the internal view", async ({ page }) => {
  await signIn(page);
  const group = (key: string, ip: string, scope: string, status: string, geo: unknown, agent: string | null) => ({
    key, agent, process: agent ? "python" : "celery", node: "node-a", container: "ai-worker", model: agent ? "model-x" : null, provider: null, tool: null, mcp_tool: null,
    src_ip: "203.0.113.18", src_count: 1, dst_ip: ip, dst_port: scope === "external" ? 443 : 6379, dst_host: scope === "external" ? "api.example.com" : null,
    protocol: scope === "external" ? "https" : "tcp", kind: scope === "external" ? "http" : "tcp", status, outcomes: [status === "ok" ? "ok" : "firewall_block"], reason: null,
    count: scope === "external" ? 3 : 4000, bytes_sent: 100, bytes_recv: 200, unmeasured: 0, first_seen: now, last_seen: now, last_id: 1, scope,
    category: agent ? "ai" : "system", direction: "outbound", service: scope === "external" ? null : "Redis", geo,
  });
  const requests: string[] = [];
  await page.route("**/api/ai-traffic/map?*", r => {
    requests.push(r.request().url());
    return r.fulfill({ json: {
      since: now, generated_at: now, truncated: false, group_limit: 1500, geoip: true, sites: { "node-a": { lat: 59.9, lon: 10.7 } },
      groups: [group("e1", "192.0.2.10", "external", "ok", { lat: 50.1, lon: 8.7, city: "Frankfurt", country: "Germany" }, "developer"),
        group("i1", "198.51.100.45", "internal", "ok", null, null), group("b1", "192.0.2.99", "external", "blocked", { lat: 52.5, lon: 13.4, city: "Berlin", country: "Germany" }, "developer")],
      countries: [{ country: "Germany", count: 6, bytes: 600, problems: 3 }], coverage: [],
    } });
  });
  await page.goto("/ai-traffic/map");
  const map = page.getByRole("img", { name: "World map of observed AI-layer connections" });
  await expect(map).toBeVisible();
  await expect(map.getByRole("button")).toHaveCount(2); // two public locations, the private address is not a point
  await expect(page.getByRole("cell", { name: "198.51.100.45:6379" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Internal network connections" }).getByText("usually Redis")).toBeVisible();
  await map.getByRole("button", { name: /Frankfurt/ }).click();
  await page.getByRole("button", { name: /api\.example\.com:443/ }).first().click();
  await expect(page.getByText("Frankfurt, Germany (approximate)")).toBeVisible();
  await expect(page.getByText("HTTPS", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Status" }).selectOption("blocked");
  await expect.poll(() => requests.some(u => u.includes("status=blocked"))).toBe(true);
  await page.getByRole("button", { name: "Pause" }).click();
  const before = requests.length;
  await page.waitForTimeout(6000);
  expect(requests.length).toBe(before);
});

test("the agent picker in Ask Ops AI is a dark list with the current agent marked", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/ai/agents", r => r.fulfill({ json: [...agents, { id: "a2", slug: "network", name: "Network", description: "DNS and HTTP", enabled: true, runtime: "native" }] }));
  await page.route("**/api/ai/history?*", r => r.fulfill({ json: { total: 0, items: [] } }));
  await page.goto("/servers");
  await page.getByRole("button", { name: "Ask Ops AI" }).click();
  const dialog = page.getByRole("dialog", { name: "Ask Ops AI" });
  await dialog.getByRole("button", { name: /^Agent: Coordinator/ }).click();
  const list = page.getByRole("listbox", { name: "Agent" });
  await expect(list).toBeVisible();
  const bg = await list.evaluate(el => getComputedStyle(el).backgroundColor);
  const [r, g, b] = bg.match(/\d+/g)!.map(Number);
  expect(r + g + b).toBeLessThan(150); // dark, never white
  await expect(list.getByRole("option", { name: /Coordinator/ })).toHaveAttribute("aria-selected", "true");
  const box = (await list.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("button", { name: /^Agent: Network/ })).toBeVisible();
  await expect(list).toBeHidden();
});

test("AI overview counts one agent with twelve tasks once", async ({ page }) => {
  await signIn(page);
  const names = ["coordinator", "monitoring", "linux", "developer"];
  await page.route("**/api/ai/agents", r => r.fulfill({ json: names.map((slug, i) => ({ id: `a${i}`, slug, name: slug === "developer" ? "Developer" : slug, description: "", enabled: true,
    status: "idle", current_task: null, runtime: "native", allowed_tools: [], provider_id: null, model: null, personal: false, allowed_dispatch_targets: null, error_message: null,
    running_tasks: slug === "developer" ? 12 : 0, queued_tasks: 0 })) }));
  await page.route("**/api/ai/agents/stream*", r => r.fulfill({ status: 204, body: "" }));
  await page.route("**/api/ai/tasks?*", r => r.fulfill({ json: Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, agent_id: "a3", status: "running", input_message: "x", created_at: now, started_at: now, completed_at: null, agents_used: [], tools_used: [], data_sources: [], source: "development" })) }));
  await page.route("**/api/ai/usage*", r => r.fulfill({ json: { days: 7, points: [] } }));
  await page.goto("/ai-agents");
  const kpi = (label: string) => page.locator(`[data-kpi="${label}"] .text-lg`);
  await expect(kpi("Active Agents")).toHaveText("1");
  await expect(kpi("Running Tasks")).toHaveText("12");
  await expect(kpi("Idle Agents")).toHaveText("3");
  await expect(page.locator('[data-agent="developer"]')).toHaveCount(1);
  await expect(page.locator('[data-agent="developer"]')).toContainText("12 running tasks");
  // Only agents at work are listed at the top; the idle ones are one line.
  const strip = page.getByRole("list", { name: "Agents at work" });
  await expect(strip.getByRole("listitem")).toHaveCount(1);
  await expect(strip).toContainText("Developer");
  await expect(page.getByText("Also 3 idle, shown on the floor below.")).toBeVisible();
});
