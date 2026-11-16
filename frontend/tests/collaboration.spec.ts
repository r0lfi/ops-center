import { expect, test, type Page } from "@playwright/test";
import type { CollaborationDetail, CollaborationPolicy, CollaborationPost, CollaborationSettings } from "../src/lib/api";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });
test.beforeEach(async ({ request }) => { await request.get("/__test__/reset"); });

// Synthetic operational fixtures only; no production incidents, sessions or host data.
const latestId = "10000000-0000-4000-8000-000000000001";
const previousId = "20000000-0000-4000-8000-000000000002";
const stoppedId = "30000000-0000-4000-8000-000000000003";
const createdId = "40000000-0000-4000-8000-000000000004";
const cancelledId = "50000000-0000-4000-8000-000000000005";
const now = new Date("2026-09-22T12:03:00Z");
const title = "Investigate elevated response time on the application service";
const previousTitle = "Review application connection pool saturation";
const stoppedTitle = "Review a paused certificate investigation";
const cancelledTitle = "Cancelled network investigation";
const agents = [
  { id: "coordinator-id", slug: "coordinator", name: "Coordinator" },
  { id: "linux-id", slug: "linux", name: "Linux Ops" },
  { id: "security-id", slug: "security", name: "Security" },
  { id: "monitoring-id", slug: "monitoring", name: "Monitoring" },
].map(agent => ({ ...agent, enabled: true, allowed_tools: ["get_host_metrics"], allowed_hosts: ["app-fixture-01"], allowed_environments: ["fixture"], status: agent.slug === "monitoring" ? "error" : "working", current_task: "Unrelated global task; never show on this board" }));
const policy: CollaborationPolicy = {
  enabled: true, max_active_investigations: 4, max_tokens: 60000, max_daily_tokens: 500000,
  max_output_tokens: 1500, max_model_calls: 12, max_messages: 24, max_help_requests: 4,
  max_depth: 2, max_participants: 4, max_seconds: 300, max_post_chars: 3000,
  rules: ["Cite observed evidence.", "Do not change services during diagnosis."],
  agents: Object.fromEntries(agents.map(agent => [agent.slug, { read: true, post: true, ask: true, respond: true, peers: agents.filter(peer => peer.slug !== agent.slug).map(peer => peer.slug), tools: ["get_host_metrics"] }])),
};
const posts: CollaborationPost[] = [
  { id: "question-linux", sequence: 1, agent: "coordinator", recipient: "linux", kind: "question", content: "Compare host pressure with the application response-time increase.", created_at: "2026-09-22T12:00:10Z" },
  { id: "finding-linux", sequence: 2, agent: "linux", recipient: null, kind: "evidence", content: "Host metrics: memory pressure remained low while application request latency increased. The recorded sample covers 11:55–12:00 UTC; the comparison alone does not establish a cause.", created_at: "2026-09-22T12:00:35Z" },
  { id: "answer-linux", sequence: 3, agent: "linux", recipient: null, kind: "answer", reply_to_id: "question-linux", content: "No host memory pressure is visible in this sample. Inspect the application connection pool next; no service changes have been performed.", created_at: "2026-09-22T12:00:50Z" },
  { id: "question-monitoring", sequence: 4, agent: "coordinator", recipient: "monitoring", kind: "question", content: "Does the request latency change align with the connection pool warning?", created_at: "2026-09-22T12:01:00Z" },
  { id: "answer-monitoring", sequence: 5, agent: "monitoring", recipient: null, kind: "answer", reply_to_id: "question-monitoring", content: "Both signals increased in the same recorded window; correlation still requires an application-level check.", created_at: "2026-09-22T12:01:15Z" },
  { id: "legacy-answer", sequence: 6, agent: "monitoring", recipient: null, kind: "answer", content: "Earlier observation with no recorded question association.", created_at: "2026-09-22T12:01:20Z" },
  { id: "question-security", sequence: 7, agent: "coordinator", recipient: "security", kind: "question", content: "Review recorded authentication signals for the affected service window.", created_at: "2026-09-22T12:01:35Z" },
  { id: "hypothesis-security", sequence: 8, agent: "security", recipient: null, kind: "hypothesis", content: "Authentication retries might add load. The available sample does not yet confirm this hypothesis.", created_at: "2026-09-22T12:01:45Z" },
  { id: "finding-monitoring", sequence: 9, agent: "monitoring", recipient: null, kind: "evidence", content: "The application latency chart and connection pool warning share the 11:58 UTC interval.", created_at: "2026-09-22T12:02:00Z" },
];
const latest: CollaborationDetail = {
  board: { task_id: latestId, status: "running", stop_reason: null, participants: agents.map(agent => agent.slug), charged_tokens: 4000, actual_tokens: 1200, model_calls: 3, message_count: posts.length, created_at: "2026-09-22T12:00:00Z", expires_at: "2026-09-22T12:05:00Z", policy },
  question: `Problem: ${title}\n\nAffected resources: app-fixture-01 · application service\n\nSeverity (operator supplied): High\n\nContext:\nLatency increased after the midday traffic rise.`,
  task_status: "running", lead_agent: "coordinator", task_started_at: "2026-09-22T12:00:04Z", task_completed_at: null, posts,
  tool_executions: [{ tool: "get_host_metrics", arguments: { host: "app-fixture-01", window_minutes: 5 } }],
  data_sources: ["Host metrics", "Application latency", "Authentication signals"], confidence: null, response_message: null,
};
const summary = "The recorded evidence points to application connection pool saturation. No corrective action or recovery verification is recorded; review the pool limit before planning a change.";
const experience = { id: "experience-1", task_id: previousId, agent: "linux", content: "Compare application pool saturation with host pressure before proposing a memory increase.", created_at: "2026-09-21T12:01:00Z", question: previousTitle };
const previous: CollaborationDetail = { ...latest, question: previousTitle, task_status: "completed", task_completed_at: "2026-09-22T12:02:30Z", board: { ...latest.board, task_id: previousId, status: "completed", message_count: 2 }, posts: [{ ...experience, sequence: 1, recipient: null, kind: "experience" }, { id: "summary-previous", agent: "coordinator", recipient: null, kind: "summary", content: summary, sequence: 2, created_at: "2026-09-22T12:02:30Z" }], tool_executions: [], data_sources: [], response_message: summary };
const stopped: CollaborationDetail = { ...latest, question: stoppedTitle, task_status: "cancelled", task_completed_at: "2026-09-22T12:01:00Z", board: { ...latest.board, task_id: stoppedId, status: "stopped", stop_reason: "Stopped by operator", message_count: 0 }, posts: [], tool_executions: [] };
const cancelled: CollaborationDetail = { ...stopped, question: cancelledTitle, board: { ...stopped.board, task_id: cancelledId, status: "running", stop_reason: null } };
const initialBudget = { limit_usd: 20, warning_usd: 16, billed_usd: 2, reserved_usd: 1, remaining_usd: 17, reset_at: "2026-09-28T00:00:00Z", week_start: "2026-09-21T00:00:00Z", warning: false, exhausted: false, pricing_unknown: 0 };

async function session(page: Page, memoryEnabled = true) {
  await page.addInitScript(() => (document.cookie = "ops_refresh=" + "pwa-test-only" + "; path=/"));
  await page.clock.install({ time: now });
  const state = {
    details: new Map<string, CollaborationDetail>([latest, previous, stopped, cancelled].map(detail => [detail.board.task_id, structuredClone(detail)])),
    denied: false, memoryEnabled, searches: [] as string[], budgetFailed: false, budget: { ...initialBudget },
    counts: { boards: 0, details: 0, budget: 0 },
    starts: [] as { message: string; agent: string }[], stops: [] as string[],
    saved: null as { revision: number; policy: CollaborationPolicy } | null,
    settings: { revision: 7, policy: structuredClone(policy), tools: ["get_host_metrics"], daily_charged_tokens: 4000 } as CollaborationSettings,
  };
  await page.route("**/api/ai/agents", route => route.fulfill({ json: agents }));
  await page.route("**/api/ai/budget", route => { state.counts.budget += 1; return route.fulfill(state.budgetFailed ? { status: 403, json: { detail: "Fixture budget refresh unavailable" } } : { json: state.budget }); });
  await page.route("**/api/ai/collaboration/settings", async route => {
    if (route.request().method() === "PUT") {
      state.saved = route.request().postDataJSON();
      state.settings = { ...state.settings, revision: 8, policy: state.saved!.policy };
    }
    await route.fulfill({ json: state.settings });
  });
  await page.route("**/api/ai/collaboration/boards?*", route => { state.counts.boards += 1; return route.fulfill({ json: [...state.details.values()].map(({ posts: _posts, ...detail }) => detail) }); });
  await page.route("**/api/ai/collaboration/boards", async route => {
    const payload = route.request().postDataJSON() as { message: string; agent: string };
    state.starts.push(payload);
    state.details.set(createdId, { ...structuredClone(latest), question: payload.message, lead_agent: payload.agent, task_status: "queued", task_started_at: null, posts: [], tool_executions: [], data_sources: [], board: { ...structuredClone(latest.board), task_id: createdId, status: "queued", participants: [payload.agent], model_calls: 0, message_count: 0, actual_tokens: 0, charged_tokens: 0 } });
    await route.fulfill({ json: { task_id: createdId } });
  });
  await page.route(/\/api\/ai\/collaboration\/boards\/[^/?]+(?:\/stop)?$/, async route => {
    const path = new URL(route.request().url()).pathname.split("/");
    const stop = path.at(-1) === "stop", id = path.at(stop ? -2 : -1)!;
    if (!stop) state.counts.details += 1;
    if (state.denied && id === latestId) { await route.fulfill({ status: 404, json: { detail: "Collaboration board not found" } }); return; }
    const detail = state.details.get(id);
    if (!detail) { await route.fulfill({ status: 404, json: { detail: "Collaboration board not found" } }); return; }
    if (stop) {
      state.stops.push(id);
      detail.board.status = "stopped"; detail.board.stop_reason = "Stopped by operator"; detail.task_status = "cancelled";
      await route.fulfill({ json: detail.board });
    } else await route.fulfill({ json: detail });
  });
  await page.route("**/api/ai/collaboration/experiences?*", route => {
    const query = new URL(route.request().url()).searchParams.get("q") || "";
    state.searches.push(query);
    return route.fulfill({ json: { items: query && !experience.content.toLowerCase().includes(query.toLowerCase()) ? [] : [experience], memory_enabled: state.memoryEnabled } });
  });
  return state;
}
async function openWorkspace(page: Page, id = latestId) {
  await page.goto(`/ai-agents/collaboration?board=${id}`);
  await expect(page.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
}
async function investigationList(page: Page) {
  const browse = page.getByRole("button", { name: "Browse investigations", exact: true });
  if (await browse.isVisible()) {
    await browse.click();
    return page.getByRole("dialog", { name: "Investigations", exact: true }).getByRole("navigation", { name: "Investigations", exact: true });
  }
  return page.getByRole("navigation", { name: "Investigations", exact: true });
}

test("Overview maps recorded questions and replies with responsive board-specific agent states", async ({ page }, testInfo) => {
  if (testInfo.project.name === "desktop") await page.setViewportSize({ width: 1440, height: 1000 });
  await session(page);
  await page.goto("/ai-agents/collaboration");
  await expect(page).toHaveURL(new RegExp(`board=${latestId}`));
  await expect(page.getByRole("heading", { name: title, exact: true, level: 1 })).toBeVisible();
  const floor = page.getByRole("region", { name: "Agent collaboration floor" });
  await expect(floor.getByRole("button", { name: "Coordinator: Waiting for reply. View contributions", exact: true })).toBeVisible();
  await expect(floor.getByRole("button", { name: "Linux Ops: Responded. View contributions", exact: true })).toBeVisible();
  await expect(floor.getByRole("button", { name: "Security: Response requested. View contributions", exact: true })).toBeVisible();
  await expect(floor.getByRole("button", { name: "Monitoring: Finding shared. View contributions", exact: true })).toBeVisible();
  await expect(floor.getByRole("button", { name: /^View .+: (Question|Reply)$/ })).toHaveCount(5);
  await expect(floor.getByRole("button", { name: "View Linux Ops to Coordinator: Reply", exact: true })).toBeVisible();
  await expect(page.getByText("Unrelated global task; never show on this board")).toHaveCount(0);
  await expect(page.getByText("Reported confidence", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Investigation progress" }).locator('[aria-current="step"]')).toHaveText(/Evidence/);
  await expect(page.locator(".collab-floor-agent-fresh, .collab-floor-edge-fresh")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Shared weekly budget" })).toContainText("$17.00");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  // ResizeObserver positions cards after the responsive shell settles. Require
  // both strict containment and a centered lead; do not hide overflow with slack.
  await expect.poll(async () => floor.locator(".collab-floor-agent").evaluateAll(cards => cards.flatMap(card => {
    const bounds = card.getBoundingClientRect(), map = card.parentElement!.getBoundingClientRect();
    const contained = bounds.left >= map.left && bounds.right <= map.right && bounds.top >= map.top && bounds.bottom <= map.bottom;
    const centered = !card.classList.contains("collab-floor-lead") || Math.abs((bounds.left + bounds.right - map.left - map.right) / 2) < 1;
    return contained && centered ? [] : [{ agent: card.getAttribute("aria-label"), card: bounds.toJSON(), map: map.toJSON(), contained, centered }];
  })), { message: "Agent cards should be contained with the lead centered after responsive layout" }).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath(`workspace-overview-${testInfo.project.name}.png`), fullPage: true });
  const question = floor.getByRole("button", { name: "View Coordinator to Linux Ops: Question", exact: true });
  await question.focus(); await page.keyboard.press("Enter");
  const exchange = page.getByRole("dialog", { name: "Agent exchange", exact: true });
  await expect(exchange.getByText(posts[0].content, { exact: true })).toBeVisible();
  await expect(exchange.getByText(posts[2].content, { exact: true })).toBeVisible();
  await expect(exchange.getByRole("article")).toHaveCount(2);
  await exchange.getByRole("button", { name: "Close dialog", exact: true }).click();
});

test("Timeline links exact replies and exposes recorded tools; Evidence separates observations from hypotheses", async ({ page }) => {
  await session(page); await openWorkspace(page);
  await page.getByRole("tab", { name: "Timeline", exact: true }).click();
  const timeline = page.getByRole("region", { name: "Investigation timeline", exact: true });
  await expect(timeline.locator("#timeline-post-answer-linux").getByRole("link", { name: "Reply to question #1", exact: true })).toHaveAttribute("href", "#timeline-post-question-linux");
  await expect(timeline.locator("#timeline-post-legacy-answer").getByRole("link")).toHaveCount(0);
  await timeline.locator("#timeline-post-answer-linux summary").click();
  await expect(timeline.locator("#timeline-post-answer-linux details > div")).toHaveText(posts[2].content);
  await timeline.locator("summary").filter({ hasText: "get_host_metrics" }).click();
  await expect(timeline.locator("pre")).toContainText('"host": "app-fixture-01"');
  await expect(timeline).toContainText("Per-call timestamps, agent attribution and results are not available.");
  await expect(timeline).not.toContainText("Tool succeeded");
  await expect(timeline).not.toContainText("sudo");
  await page.getByRole("tab", { name: "Evidence", exact: true }).click();
  const evidence = page.getByRole("region", { name: "Evidence & hypotheses", exact: true });
  await expect(evidence.getByLabel("Recorded data sources")).toContainText("Host metrics");
  await evidence.locator("summary").filter({ hasText: "Host metrics: memory pressure" }).click();
  await expect(evidence.locator("details[open] > div")).toHaveText(posts[1].content);
  await expect(evidence).toContainText(posts[7].content);
  await expect(page.getByText("Reported confidence", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Evidence", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("completed history has a recorded conclusion without invented recovery or live activity", async ({ page }) => {
  await session(page); await openWorkspace(page, previousId);
  const floor = page.getByRole("region", { name: "Agent collaboration floor" });
  await expect(floor.getByRole("button", { name: /: Completed\. View contributions$/ })).toHaveCount(4);
  await expect(page.getByText("Live updates", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop investigation", exact: true })).toHaveCount(0);
  await expect(page.locator(".collab-floor-agent-fresh, .collab-floor-edge-fresh")).toHaveCount(0);
  const outcome = page.getByRole("region", { name: "Investigation outcome", exact: true });
  await outcome.locator("summary").click();
  await expect(outcome.locator("details > div")).toHaveText(summary);
  await expect(outcome).toContainText("does not establish that the underlying issue is resolved");
  await expect(page.getByRole("list", { name: "Investigation progress" }).locator('[aria-current="step"]')).toHaveText(/Conclusion/);
  await page.getByRole("tab", { name: "Timeline", exact: true }).click();
  await expect(page.getByText("No tool calls recorded for this investigation.", { exact: true })).toBeVisible();
  await expect(page.getByText("Reported confidence", { exact: true })).toHaveCount(0);
});

test("experience search keeps source provenance and memory opt-out while board selection survives reload", async ({ page }) => {
  const state = await session(page, false); await openWorkspace(page);
  await page.getByRole("tab", { name: "Shared experience", exact: true }).click();
  const panel = page.getByRole("region", { name: "Shared experience", exact: true });
  await expect(panel).toContainText("Experience recall paused");
  await panel.getByRole("textbox", { name: "Search saved experiences", exact: true }).fill("saturation");
  await page.clock.fastForward(350);
  await expect.poll(() => state.searches.includes("saturation")).toBeTruthy();
  await expect(panel.getByRole("article")).toContainText(experience.content);
  await panel.getByRole("link", { name: "Open source investigation", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`board=${previousId}`));
  await expect(page.getByRole("heading", { name: previousTitle, exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`board=${previousId}`));
  await expect(page.getByRole("heading", { name: previousTitle, exact: true, level: 1 })).toBeVisible();
  await page.getByRole("tab", { name: "Shared experience", exact: true }).click();
  await expect(panel).toContainText("Experience recall paused");
  await panel.getByRole("textbox", { name: "Search saved experiences", exact: true }).fill("no-match");
  await page.clock.fastForward(350);
  await expect(panel.getByText("No matching experience notes.", { exact: true })).toBeVisible();
});

test("a private detail failure clears the old floor, timeline and state even when list polling succeeds", async ({ page }) => {
  const state = await session(page); await openWorkspace(page);
  await expect(page.getByRole("region", { name: "Agent collaboration floor" })).toBeVisible();
  state.denied = true;
  await page.clock.fastForward(3500);
  await expect(page.getByRole("alert").filter({ hasText: "Investigation unavailable" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Agent collaboration floor" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Investigation state" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Investigation timeline" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Investigation outcome" })).toHaveCount(0);
  await expect(page.getByText(posts[8].content, { exact: true })).toHaveCount(0);
  await page.clock.fastForward(3500);
  await expect(page.getByRole("alert").filter({ hasText: "Investigation unavailable" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`board=${latestId}`));
  await expect(page.getByRole("region", { name: "Shared weekly budget" })).toBeVisible();
});

test("new investigation preserves context and the 4000-character plain prompt contract; stop uses the selected board", async ({ page }) => {
  const state = await session(page); await openWorkspace(page);
  const headerNew = page.getByRole("region", { name: "Agent collaboration workspace", exact: true }).locator(":scope > header").getByRole("button", { name: "New investigation", exact: true });
  await headerNew.click();
  const dialog = page.getByRole("dialog", { name: "New investigation", exact: true });
  await expect(dialog.getByRole("button", { name: "Start investigation", exact: true })).toBeDisabled();
  await dialog.getByLabel("Problem description", { exact: true }).fill("  Investigate delayed health checks  ");
  await dialog.getByLabel(/Affected hosts or resources/).fill(" app-fixture-02 ");
  await dialog.getByRole("combobox", { name: "Lead agent", exact: true }).selectOption("linux");
  await dialog.getByRole("combobox", { name: /^Severity/ }).selectOption("High");
  await dialog.getByLabel(/^Additional context/).fill("Latency increased after the fixture deployment.");
  await dialog.getByRole("button", { name: "Start investigation", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`board=${createdId}`));
  await expect(page.getByRole("heading", { name: "Investigate delayed health checks", exact: true, level: 1 })).toBeVisible();
  expect(state.starts[0]).toEqual({ agent: "linux", message: "Problem: Investigate delayed health checks\n\nAffected resources: app-fixture-02\n\nSeverity (operator supplied): High\n\nContext:\nLatency increased after the fixture deployment." });
  await page.getByRole("button", { name: "Stop investigation", exact: true }).click();
  await expect.poll(() => state.stops).toEqual([createdId]);
  await expect(page.getByRole("status").filter({ hasText: "Stop requested." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop investigation", exact: true })).toHaveCount(0);
  await headerNew.click();
  const plain = ("Investigate delayed application responses. " + "Additional observed fixture context. ".repeat(120)).slice(0, 3999) + "x";
  await dialog.getByLabel("Problem description", { exact: true }).fill(plain);
  await expect(dialog.getByText("4000 / 4000 total characters", { exact: true })).toBeVisible();
  await dialog.getByLabel(/^Additional context/).fill("Extra context exceeds the total limit.");
  await expect(dialog.getByRole("button", { name: "Start investigation", exact: true })).toBeDisabled();
  await dialog.getByLabel(/^Additional context/).fill("");
  await dialog.getByRole("button", { name: "Start investigation", exact: true }).click();
  await expect.poll(() => state.starts.length).toBe(2);
  expect(state.starts[1]).toEqual({ agent: "linux", message: plain });
  await expect(dialog).toHaveCount(0);
});

test("sidebar filters include stopped history and exclude a cancelled task with a lagging running board", async ({ page }) => {
  await session(page); await openWorkspace(page);
  const list = await investigationList(page);
  await list.getByRole("button", { name: "Active", exact: true }).click();
  await expect(list.getByRole("button", { name: title, exact: true })).toBeVisible();
  await expect(list.getByRole("button", { name: previousTitle, exact: true })).toHaveCount(0);
  await expect(list.getByRole("button", { name: cancelledTitle, exact: true })).toHaveCount(0);
  await list.getByRole("button", { name: "Completed", exact: true }).click();
  await expect(list.getByRole("button", { name: previousTitle, exact: true })).toBeVisible();
  await expect(list.getByRole("button", { name: title, exact: true })).toHaveCount(0);
  await list.getByRole("button", { name: "All", exact: true }).click();
  await expect(list.getByRole("button", { name: stoppedTitle, exact: true })).toContainText("Stopped");
  await expect(list.getByRole("button", { name: cancelledTitle, exact: true })).toContainText("Stopped");
  await list.getByRole("button", { name: cancelledTitle, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`board=${cancelledId}`));
  await expect(page.getByRole("heading", { name: cancelledTitle, exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText("Live updates", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop investigation", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Investigation state", exact: true })).toContainText("Cancelled");
});

test("the separate settings page saves permissions, partners, rules and unchanged safety limits", async ({ page }) => {
  const state = await session(page);
  await page.goto("/ai-agents/collaboration/settings");
  await expect(page.getByRole("heading", { name: "Collaboration settings", exact: true })).toBeVisible();
  await page.locator("summary").filter({ hasText: "Advanced investigation safety limits" }).click();
  await page.getByLabel("Model calls per investigation", { exact: true }).fill("14");
  const security = page.getByRole("group", { name: "Security", exact: true });
  await security.getByLabel("Post evidence", { exact: true }).uncheck();
  await security.getByLabel("Monitoring", { exact: true }).uncheck();
  await page.getByRole("textbox", { name: "Rule 1", exact: true }).fill("Cite the source and observation window.");
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Collaboration settings saved." })).toBeVisible();
  const expected = structuredClone(policy);
  expected.max_model_calls = 14; expected.agents.security.post = false;
  expected.agents.security.peers = expected.agents.security.peers.filter(peer => peer !== "monitoring");
  expected.rules[0] = "Cite the source and observation window.";
  expect(state.saved).toEqual({ revision: 7, policy: expected });
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Rule 1", exact: true })).toHaveValue(expected.rules[0]);
  await expect(security.getByLabel("Post evidence", { exact: true })).not.toBeChecked();
});

test("budget refresh failure clears stale figures and unknown pricing never claims dollar exhaustion", async ({ page }) => {
  const state = await session(page); await openWorkspace(page);
  const budget = page.getByRole("region", { name: "Shared weekly budget", exact: true });
  await expect(budget.getByRole("progressbar", { name: "Weekly budget used or reserved" })).toHaveAttribute("aria-valuenow", "3");
  await expect(budget).toContainText("Estimated spend");
  await expect(budget).toContainText("Reserved");
  state.budgetFailed = true;
  await page.clock.fastForward(15500);
  await expect(budget.getByRole("alert")).toContainText("Budget status is unavailable. The server still enforces the spending limit.");
  await expect(budget).not.toContainText("$17.00");
  await expect(budget.getByRole("progressbar")).toHaveCount(0);
  state.budgetFailed = false;
  state.budget = { ...initialBudget, billed_usd: 0, reserved_usd: 0, remaining_usd: 20, pricing_unknown: 1, exhausted: true };
  await budget.getByRole("button", { name: "Retry refresh", exact: true }).click();
  await expect(budget.getByRole("alert")).toHaveText("Paid AI is paused. Some usage has no verified price.");
  await expect(budget).toContainText("$20.00");
  await expect(budget).not.toContainText("Allowance exhausted");
  await budget.locator("summary").filter({ hasText: "All agents share this allowance" }).click();
  await expect(budget).toContainText("Warning at $16.00 used or reserved.");
  await expect(budget).toContainText("these values are not an invoice");
});

async function setWorkspaceVisibility(page: Page, visibility: "visible" | "hidden") {
  await page.evaluate(value => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visibility);
}

test("completed investigation polling slows down and experiences only load on their tab", async ({ page }) => {
  const state = await session(page); await openWorkspace(page);
  await expect.poll(() => state.counts.details).toBe(1);
  expect(state.searches).toEqual([]);
  const current = state.details.get(latestId)!;
  current.board.status = "completed"; current.task_status = "completed";
  await page.clock.fastForward(3500);
  await expect.poll(() => state.counts.details).toBe(2);
  await expect(page.getByRole("button", { name: "Stop investigation", exact: true })).toHaveCount(0);
  await page.clock.fastForward(16000);
  expect(state.counts.details).toBe(2);
  expect(state.searches).toEqual([]);
  await page.clock.fastForward(15000);
  await expect.poll(() => state.counts.details).toBe(3);
  await page.getByRole("tab", { name: "Shared experience", exact: true }).click();
  await page.clock.fastForward(350);
  await expect.poll(() => state.searches.length).toBe(1);
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await page.clock.fastForward(16000);
  expect(state.searches).toHaveLength(1);
});

test("hidden workspace polling pauses and returning immediately clears inaccessible detail", async ({ page }) => {
  const state = await session(page); await openWorkspace(page);
  await expect.poll(() => state.counts.details).toBe(1);
  await expect.poll(() => state.counts.boards).toBe(1);
  await page.getByRole("tab", { name: "Shared experience", exact: true }).click();
  await page.clock.fastForward(350);
  await expect.poll(() => state.searches.length).toBe(1);
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("region", { name: "Agent collaboration floor" })).toBeVisible();
  await setWorkspaceVisibility(page, "hidden");
  const counts = { ...state.counts };
  await page.clock.fastForward(65000);
  expect(state.counts).toEqual(counts);
  expect(state.searches).toHaveLength(1);
  state.denied = true;
  await setWorkspaceVisibility(page, "visible");
  await expect.poll(() => state.counts.details).toBe(counts.details + 1);
  await expect.poll(() => state.counts.boards).toBe(counts.boards + 1);
  await expect.poll(() => state.counts.budget).toBe(counts.budget + 1);
  await expect(page.getByRole("alert").filter({ hasText: "Investigation unavailable" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Agent collaboration floor" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Investigation state" })).toHaveCount(0);
});
