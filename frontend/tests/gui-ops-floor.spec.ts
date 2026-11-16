import { expect, test, type Page } from "@playwright/test";

import { layoutFloor, ROOMS, SEATS } from "../src/lib/opsFloor/config";
import { activityRows, buildEdges, buildFloor, buildFlows, floorCounts, floorStatus, groupActivity, matchesFilter, motionOf } from "../src/lib/opsFloor/model";
import type { AIAction, AIAgent, AITask } from "../src/lib/api";
import { stationBoxes } from "../src/components/ops-floor/office3d/geometry";

const SLUGS = Object.keys(SEATS);

function agent(slug: string, extra: Partial<AIAgent> = {}) {
  return {
    id: `id-${slug}`, slug, name: slug, enabled: true, status: "idle", runtime: slug.startsWith("oc-") ? "external" : "native", provider_id: null, model: "m",
    allowed_tools: ["ssh_run"], allowed_hosts: [], allowed_environments: [], current_task: null, description: `The ${slug} agent`, error_message: null, responsibility: null,
    system_prompt: "", autonomy_level: 0, max_tool_calls: 1, max_execution_seconds: 1, last_activity_at: null, updated_at: "2026-10-25T08:00:00Z", ...extra,
  } as AIAgent;
}
const action = (over: Partial<AIAction> = {}) => ({ id: "a1", request_code: "R", agent_id: "id-automation", task_id: null, host_id: null, action: "Remove unused images", tool: "docker_prune", arguments: { hostname: "box-1" }, approval_level: 2, risk: "medium", reason: "Disk is full", status: "pending", source: "x", requested_by: null, approved_by: null, result: null, requested_at: "2026-01-01T00:00:00Z", expires_at: null, approved_at: null, executed_at: null, ...over }) as AIAction;
const task = (over: Partial<AITask> = {}) => ({ id: "t1", agent_id: "id-coordinator", requested_by: null, source: "x", conversation_key: null, input_message: "Do a thing", response_message: null, status: "running", error_message: null, agents_used: [], tools_used: [], data_sources: [], confidence: null, started_at: "2026-01-01T00:00:00Z", completed_at: null, duration_ms: null, ...over }) as AITask;

test.describe("model", () => {
  test("one agent with twelve running tasks is one active agent and twelve running tasks", () => {
    // The agent row says idle (another of its tasks finished last); the running tasks decide.
    const configs = SLUGS.map((slug) => agent(slug, slug === "developer" ? { running_tasks: 12, status: "idle" } : {}));
    const tasks = Array.from({ length: 12 }, (_, i) => task({ id: `t${i}`, agent_id: "id-developer" }));
    const floor = buildFloor(configs, {}, [], tasks);
    const counts = floorCounts(floor.agents, tasks);
    expect(counts.active).toBe(1);
    expect(counts.runningTasks).toBe(12);
    expect(counts.idle).toBe(SLUGS.length - 1 - floor.agents.filter((a) => a.status === "paused").length);
    expect(floor.agents.filter((a) => a.slug === "developer")).toHaveLength(1);
    expect(floor.agents.find((a) => a.slug === "developer")!.status).toBe("working");
  });

  test("repeated steps of one task fold into one line without losing events", () => {
    const live = Array.from({ length: 9 }, (_, i) => ({
      id: `e${i}`, ts: 1000 + i, slug: "developer", status: "working" as const, activity: null, target: null, taskId: "t1",
      event: (i % 3 === 0 ? "tool_finished" : "tool_started") as "tool_finished" | "tool_started", tool: i % 3 === 1 ? "read_repo_file" : "search_code",
    }));
    const rows = activityRows(live, [task({ id: "t1", agent_id: "id-developer", started_at: new Date(500).toISOString() })], [{ id: "id-developer", slug: "developer" }], 300);
    const groups = groupActivity(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(rows.length);
    expect(groups[0].rows).toHaveLength(rows.length);
    expect(Object.fromEntries(groups[0].tally)).toMatchObject({ "Analysing results": 3, "Running read_repo_file": 3, "Running search_code": 3 });
    // A live "Started a task" is not repeated by the saved task.
    const started = activityRows([{ id: "s", ts: 600, slug: "developer", status: "working", activity: null, target: null, taskId: "t1", event: "task_started" }],
      [task({ id: "t1", agent_id: "id-developer", started_at: new Date(600).toISOString() })], [{ id: "id-developer", slug: "developer" }]);
    expect(started.filter((row) => row.text === "Started a task")).toHaveLength(1);
    // Twelve tasks that each just started: one line, every task still there.
    const starts = groupActivity(activityRows([], Array.from({ length: 12 }, (_, i) => task({ id: `s${i}`, agent_id: "id-developer", started_at: new Date(1000 + i).toISOString() })),
      [{ id: "id-developer", slug: "developer" }], 300));
    expect(starts).toHaveLength(1);
    expect(starts[0].count).toBe(12);
    expect(new Set(starts[0].rows.map((row) => row.taskId)).size).toBe(12);
  });

  test("one status for each state, worst news first", () => {
    expect(floorStatus({ enabled: false, status: "disabled", pendingApprovals: 0 })).toBe("paused");
    expect(floorStatus({ enabled: true, status: "idle", pendingApprovals: 0 })).toBe("idle");
    expect(floorStatus({ enabled: true, status: "investigating", pendingApprovals: 0 })).toBe("working");
    expect(floorStatus({ enabled: true, status: "idle", pendingApprovals: 1 })).toBe("approval");
    expect(floorStatus({ enabled: false, status: "error", pendingApprovals: 1 })).toBe("error");
  });

  test("waiting on another agent is working, waiting on a person is approval", () => {
    expect(floorStatus({ enabled: true, status: "waiting", pendingApprovals: 0, activity: "Waiting on Linux Ops" })).toBe("working");
    expect(floorStatus({ enabled: true, status: "waiting", pendingApprovals: 0, activity: "Waiting for approval: restart" })).toBe("approval");
  });

  test("every agent has a seat inside its room, and cards fit", () => {
    for (const [slug, seat] of Object.entries(SEATS)) {
      const room = ROOMS.find((item) => item.id === seat.room)!;
      const half = seat.big ? 110 : seat.room === "crew" ? 52 : 58;
      expect(seat.x - half, slug).toBeGreaterThanOrEqual(room.x);
      expect(seat.x + half, slug).toBeLessThanOrEqual(room.x + room.w);
      expect(seat.y - 55, slug).toBeGreaterThanOrEqual(room.y);
      expect(seat.y + 55, slug).toBeLessThanOrEqual(room.y + room.h);
    }
    expect(SLUGS).toHaveLength(16);
  });

  test("an unknown agent gets a seat in Other and nobody else moves", () => {
    const layout = layoutFloor([...SLUGS, "new-one"]);
    expect(layout.seats["new-one"].room).toBe("other");
    expect(layout.rooms.at(-1)!.name).toBe("Other");
    expect(layout.height).toBeGreaterThan(600);
    expect(layout.seats.linux).toEqual(SEATS.linux);
    expect(layoutFloor(SLUGS).height).toBe(600);
    expect(stationBoxes("new-one", layout.seats["new-one"]).length).toBeGreaterThan(10);
  });

  test("filters dim by status, name and skill", () => {
    const base = { name: "Linux Ops", short: "Linux Ops", skills: ["ssh_run"] };
    expect(matchesFilter({ ...base, status: "error" }, "needs", "")).toBe(true);
    expect(matchesFilter({ ...base, status: "idle" }, "needs", "")).toBe(false);
    expect(matchesFilter({ ...base, status: "paused" }, "quiet", "")).toBe(true);
    expect(matchesFilter({ ...base, status: "idle" }, "all", "ssh")).toBe(true);
    expect(matchesFilter({ ...base, status: "idle" }, "all", "nginx")).toBe(false);
  });

  test("counts, links and the log come from the data", () => {
    const configs = [agent("coordinator"), agent("automation"), agent("nova", { personal: true }), agent("ext-coder", { runtime: "external" })];
    const tasks = [task({ agents_used: ["automation"] }), task({ id: "t2", status: "queued", agent_id: "id-automation" })];
    const { agents } = buildFloor(configs, {}, [action()], tasks);
    const counts = floorCounts(agents, tasks);
    expect(counts).toMatchObject({ needs: 1, queued: 1, paused: 0, total: 4, allPaused: false });
    const edges = buildEdges(configs, tasks, agents);
    expect(edges).toEqual([{ from: "coordinator", to: "automation", tone: "approval", taskId: "t1" }]);
    const rows = activityRows([{ id: "x", ts: 5, slug: "linux", status: "idle", activity: "Idle", target: null }], tasks, agents);
    expect(rows.map((row) => row.text)).toEqual(["Started a task"]);
  });

  test("looks come from events, and unknown work stays plain working", () => {
    const at = 1000;
    const live = (event: string | null, extra = {}) => ({ status: "working" as const, activity: "x", target: null, taskId: "t1", receivedAt: at, event: event as never, ...extra });
    expect(motionOf("working", live(null), at)).toBe("busy");
    expect(motionOf("working", live("tool_started"), at)).toBe("tool");
    expect(motionOf("working", live("tool_finished"), at)).toBe("thinking");
    expect(motionOf("working", live("delegated"), at)).toBe("delegating");
    expect(motionOf("idle", { ...live("completed"), status: "idle" }, at + 1000)).toBe("completed");
    expect(motionOf("idle", { ...live("completed"), status: "idle" }, at + 60000)).toBe("idle");
    expect(motionOf("error", live("tool_started"), at)).toBe("error");
  });

  test("flows only follow a published delegation between known agents", () => {
    const configs = [agent("coordinator", { status: "waiting" }), agent("linux", { status: "working" })];
    const live = {
      coordinator: { status: "waiting" as const, activity: "Waiting on linux", target: null, taskId: "t1", receivedAt: 0, event: "delegated" as const, peer: "linux" },
      linux: { status: "working" as const, activity: "x", target: null, taskId: "t1", receivedAt: 0, event: "delegated" as const, peer: "ghost" },
    };
    const { agents } = buildFloor(configs, live, [], [], 0);
    expect(buildFlows(agents, live, 0)).toEqual([{ from: "coordinator", to: "linux", kind: "delegate", taskId: "t1" }]);
    expect(agents.find((item) => item.slug === "coordinator")?.peer).toBe("linux");
  });

  test("the log tells events in words and keeps their task", () => {
    const { agents } = buildFloor([agent("coordinator"), agent("linux")], {}, [], []);
    const base = { id: "r", ts: 5, slug: "coordinator", status: "working" as const, activity: "Waiting on linux", target: null, taskId: "t9" };
    const rows = activityRows([
      { ...base, id: "a", event: "delegated", peer: "linux" },
      { ...base, id: "b", slug: "linux", activity: "get_disk_usage(web-1)", target: "web-1", event: "tool_started", tool: "get_disk_usage" },
      { ...base, id: "c", status: "idle", activity: null, event: "completed" },
    ], [], agents);
    expect(rows.map((row) => row.text)).toEqual(["Handed work to linux", "Running get_disk_usage on web-1", "Completed its work"]);
    expect(rows[0].taskId).toBe("t9");
  });
});

async function openFloor(page: Page, configs: AIAgent[], extra: { pending?: AIAction[]; tasks?: AITask[]; view?: "2d" | "3d"; stream?: string } = {}) {
  await page.addInitScript((view) => {
    (document.cookie = "ops_refresh=" + "pwa-test-only" + "; path=/");
    localStorage.setItem("ops_floor_view", view);
  }, extra.view ?? "2d");
  await page.route("**/api/ai/agents/stream?*", (route) => route.fulfill({ status: extra.stream ? 200 : 204, contentType: "text/event-stream", body: extra.stream ?? "" }));
  await page.route("**/api/ai/providers", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/ai/tasks?*", (route) => route.fulfill({ json: extra.tasks ?? [] }));
  await page.route("**/api/ai/actions?*", (route) => route.fulfill({ json: extra.pending ?? [] }));
  await page.route("**/api/ai/agents", (route) => route.fulfill({ json: configs }));
  await page.route("**/api/hosts", (route) => route.fulfill({ json: [] }));
  await page.goto("/ai-agents/ops-floor");
  await expect(page.locator("[data-agent]").first()).toBeVisible();
}

const all = () => SLUGS.map((slug) => agent(slug));

test.describe("page", () => {
  test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

  test("one status everywhere, and the all-paused banner resumes with confirmation", async ({ page }) => {
    const updates: string[] = [];
    await page.route("**/api/ai/agents/*", (route) => { updates.push(route.request().postData() ?? ""); return route.fulfill({ json: agent("linux") }); });
    await openFloor(page, SLUGS.map((slug) => agent(slug, { enabled: false, status: "disabled" })));
    await expect(page.locator('[data-status="paused"]')).toHaveCount(SLUGS.length);
    await expect(page.getByText("0 Agents Online")).toHaveCount(0);
    await expect(page.locator(".of-stat", { hasText: "Total agents" })).toContainText(String(SLUGS.length));
    await expect(page.locator(".of-stat", { hasText: "Paused" })).toContainText(String(SLUGS.length));
    await page.getByRole("button", { name: "Resume all agents" }).click();
    expect(updates).toEqual([]);
    await page.getByRole("dialog").getByRole("button", { name: "Resume all agents" }).click();
    await expect.poll(() => updates.length).toBe(SLUGS.length);
  });

  test("filters dim without moving, and selection survives a view switch", async ({ page }) => {
    await openFloor(page, all(), { pending: [action()] });
    const linux = page.locator('[data-agent="linux"]');
    const before = await linux.boundingBox();
    await page.getByRole("button", { name: "Needs you", exact: true }).click();
    await expect(linux).toHaveClass(/of-dim/);
    await expect(page.locator('[data-agent="automation"]')).not.toHaveClass(/of-dim/);
    expect(await linux.boundingBox()).toEqual(before);

    await page.locator('[data-agent="automation"]').click();
    await page.getByRole("button", { name: "3D Office" }).click();
    await expect(page.locator('.of-plate[data-agent="automation"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Needs you", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => localStorage.getItem("ops_floor_view"))).toBe("3d");
  });

  test("approve shows target and risk first, and uses the existing API", async ({ page }) => {
    const posts: string[] = [];
    await page.route("**/api/ai/actions/a1/*", (route) => { posts.push(route.request().url()); return route.fulfill({ json: action({ status: "approved" }) }); });
    await openFloor(page, all(), { pending: [action()] });
    await page.locator('[data-agent="automation"]').click();
    const box = page.getByRole("group", { name: "Approval for Remove unused images" });
    await expect(box).toContainText("box-1");
    await expect(box).toContainText("L2 - medium");
    expect(posts).toEqual([]);
    await box.getByRole("button", { name: "Approve" }).click();
    await expect.poll(() => posts.at(-1)).toMatch(/\/a1\/approve$/);
  });

  test("a level 3 request cannot be answered by an operator", async ({ page }) => {
    await page.route("**/api/auth/me", async (route) => { const res = await route.fetch(); const body = await res.json(); return route.fulfill({ json: { ...body, role: "operator" } }); });
    await openFloor(page, all(), { pending: [action({ approval_level: 3, risk: "high" })] });
    await page.locator('[data-agent="automation"]').click();
    const box = page.getByRole("group", { name: "Approval for Remove unused images" });
    await expect(box.getByRole("button", { name: "Approve" })).toHaveCount(0);
    await expect(box).toContainText("Your role cannot answer");
  });

  test("stop and resume call the existing endpoints and pointless actions are off", async ({ page }) => {
    const calls: string[] = [];
    await page.route("**/api/ai/tasks/t1/cancel", (route) => { calls.push("cancel"); return route.fulfill({ json: task({ status: "cancelled" }) }); });
    await page.route("**/api/ai/agents/id-linux", (route) => { calls.push(route.request().postData() ?? ""); return route.fulfill({ json: agent("linux") }); });
    const configs = SLUGS.map((slug) => slug === "linux" ? agent(slug, { enabled: false, status: "disabled" }) : agent(slug));
    await openFloor(page, configs, { tasks: [task({ agent_id: "id-automation" })] });
    await page.locator('[data-agent="automation"]').click();
    const panel = page.getByRole("complementary", { name: "Agent details" });
    await expect(panel.getByRole("button", { name: "Resume" })).toBeDisabled();
    await panel.getByRole("button", { name: "Stop task" }).click();
    await expect.poll(() => calls).toEqual(["cancel"]);

    await page.locator('[data-agent="linux"]').click();
    await expect(panel.getByRole("button", { name: "Stop task" })).toBeDisabled();
    await panel.getByRole("button", { name: "Resume" }).click();
    await expect.poll(() => calls.at(-1)).toContain('"enabled":true');
  });

  test("the log shows the date, and a replayed saved state is not an event", async ({ page }) => {
    const replay = { agent: "linux", status: "error", activity: "Delegated personal request", target: null, task_id: null };
    const real = { ...replay, status: "working", activity: "Checking disks", ts: Date.parse("2026-11-08T12:00:00Z") / 1000 };
    const stream = [replay, real].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    const old = task({ status: "completed", agent_id: "id-linux", started_at: "2026-10-26T12:00:00Z", completed_at: "2026-10-26T12:00:05Z" });
    await openFloor(page, [agent("linux")], { tasks: [old], stream });
    const log = page.locator(".of-log");
    await expect(log.getByText("Checking disks")).toBeVisible();
    await expect(log.locator("li", { hasText: "Finished a task" }).locator("time")).toContainText("26 Oct");
    await expect(log.locator("li", { hasText: "Checking disks" }).locator("time")).toContainText("8 Nov");
    await expect(log.getByText("Delegated personal request")).toHaveCount(0);
  });

  test("a real delegation shows who hands work to whom, and the line opens the task", async ({ page }) => {
    const ts = Date.now() / 1000;
    const events = [
      { agent: "coordinator", status: "waiting", activity: "Waiting on linux", target: null, task_id: "t1", ts, event: "delegated", peer: "linux" },
      { agent: "linux", status: "investigating", activity: "get_disk_usage(web-1)", target: "web-1", task_id: "t1", ts, event: "tool_started", tool: "get_disk_usage" },
    ];
    const stream = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    await openFloor(page, all(), { tasks: [task({ agents_used: ["linux"], tools_used: [{ tool: "get_disk_usage", arguments: { hostname: "web-1" } }] })], stream });
    await expect(page.locator('[data-agent="coordinator"]')).toHaveAttribute("data-motion", "delegating");
    await expect(page.locator('[data-agent="linux"]')).toContainText("get_disk_usage on web-1");
    await expect(page.locator('[data-flow="delegate"][data-connection="coordinator-linux"]')).toHaveCount(1);
    await expect(page.locator(".of-log")).toContainText("Handed work to linux");
    await page.locator('[data-connection="coordinator-linux"] .of-hit').dispatchEvent("click");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Do a thing");
    await expect(dialog).toContainText("get_disk_usage");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "3D Office" }).click();
    await expect(page.locator('[data-station="coordinator"]')).toHaveAttribute("data-motion", "delegating");
    await expect(page.locator('[data-station="linux"]')).toHaveAttribute("data-motion", "tool");
  });

  test("status numbers filter the floor, and names are not cut off", async ({ page }) => {
    await openFloor(page, SLUGS.map((slug) => slug === "security" ? agent(slug, { name: "Security and Compliance Agent", status: "error", error_message: "Provider failed" }) : agent(slug)));
    await page.locator(".of-stat", { hasText: "Errors" }).click();
    await expect(page.locator('[data-agent="linux"]')).toHaveClass(/of-dim/);
    await expect(page.locator('[data-agent="security"]')).not.toHaveClass(/of-dim/);
    const name = page.locator('[data-agent="security"] .of-card-name');
    await expect(name).toHaveText("Security and Compliance Agent");
    expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(page.locator('[data-agent="security"]')).toContainText("Failed. Select for details.");
  });

  test("unknown agents appear in Other, in both views", async ({ page }) => {
    await openFloor(page, [...all(), agent("brand-new")]);
    await expect(page.locator('[data-agent="brand-new"]')).toBeVisible();
    await expect(page.locator(".of-room", { hasText: "Other" })).toBeVisible();
    await page.getByRole("button", { name: "3D Office" }).click();
    await expect(page.locator('[data-station="brand-new"]')).toHaveCount(1);
  });

  test("a drag turns the camera and does not select, a click selects", async ({ page }) => {
    await openFloor(page, all(), { view: "3d" });
    const world = page.locator(".of-world");
    const plate = page.locator('.of-plate[data-agent="network"]');
    await expect(plate).toHaveAttribute("aria-pressed", "false");
    const start = await world.evaluate((el) => (el as HTMLElement).style.transform);
    const box = (await plate.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + 40, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => world.evaluate((el) => (el as HTMLElement).style.transform)).not.toBe(start);
    await expect(plate).toHaveAttribute("aria-pressed", "false");
    await plate.click();
    await expect(plate).toHaveAttribute("aria-pressed", "true");
  });

  test("a status change does not reset the camera, and the screens follow status", async ({ page }) => {
    let configs = all();
    await page.route("**/api/ai/agents", (route) => route.fulfill({ json: configs }));
    await openFloor(page, all(), { view: "3d" });
    await page.getByRole("button", { name: "Top", exact: true }).click();
    const world = page.locator(".of-world");
    await expect.poll(() => world.evaluate((el) => (el as HTMLElement).style.transform)).toContain("rotateX(12deg)");
    await expect(page.locator('[data-station="coordinator"] .of-screen')).toHaveCount(4);
    await expect(page.locator(".of-station")).toHaveCount(SLUGS.length);
    configs = SLUGS.map((slug) => slug === "security" ? agent(slug, { status: "error" }) : agent(slug));
    await page.unroute("**/api/ai/agents");
    await page.route("**/api/ai/agents", (route) => route.fulfill({ json: configs }));
    await page.reload();
    await expect(page.locator('[data-station="security"]')).toHaveAttribute("data-status", "error");
    await expect(page.locator(".of-bubble-error")).toHaveText("!");
  });
});
