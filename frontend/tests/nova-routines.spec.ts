import { expect, test, type Page } from "@playwright/test";
test.use({ serviceWorkers: "block" });

const agent = { id: "agent-nova", slug: "nova", name: "Nova", enabled: true, status: "idle", provider_id: "p1", model: null, allowed_tools: [], allowed_hosts: [],
  allowed_environments: [], allowed_dispatch_targets: ["coordinator"], personal: true, runtime: "native", current_task: null, error_message: null,
  description: "", responsibility: null, system_prompt: "", autonomy_level: 0, max_tool_calls: 12, max_execution_seconds: 900, last_activity_at: null,
  updated_at: "2026-10-25T08:00:00Z" };
const provider = { id: "p1", slug: "local-llm", kind: "openai_compatible", display_name: "Synthetic local", base_url: "https://llm.example/v1", default_model: "m", has_key: false, enabled: true, updated_at: "" };
const at = "2026-10-25T05:00:00Z";
const brief = { id: "r1", name: "Morning brief", schedule: "0 7 * * *", instruction: "Brief me on open threads.", channel: "web", enabled: true,
  last_run_at: at, next_run_at: "2026-10-26T06:00:00Z", created_at: at };
const runs = [
  { id: "run1", routine_id: "r1", routine_name: "Morning brief", due_at: at, manual: false, channel: "talk", status: "started", reason: null, task_id: "t1",
    task_status: "completed", response: "Good morning. Shall I ask Ops Center to check the backups?", error: null, completed_at: at, delivered_at: null,
    delivery_error: "No private Talk room is routed to nova for this owner." },
  { id: "run2", routine_id: "r1", routine_name: "Morning brief with a very long routine name that must wrap on a phone screen xxxxxxxxxxxxxxxx", due_at: at,
    manual: false, channel: "web", status: "skipped", reason: "quiet hours", task_id: null, task_status: null, response: null, error: null, completed_at: null,
    delivered_at: null, delivery_error: null },
];

async function session(page: Page, proactive = false) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let routines = [brief];
  let settings = { enabled: proactive, quiet_start: "22:00", quiet_end: "07:00", max_per_day: 3 };
  await page.addInitScript(() => (document.cookie = "ops_refresh=" + "pwa-test-only" + "; path=/"));
  await page.route("**/api/ai/agents", route => route.fulfill({ json: [agent] }));
  await page.route("**/api/ai/providers", route => route.fulfill({ json: [provider] }));
  await page.route("**/api/ai/tasks?*", route => route.fulfill({ json: [] }));
  await page.route("**/api/ai/actions?*", route => route.fulfill({ json: [] }));
  await page.route("**/api/ai/memory", route => route.fulfill({ json: { enabled: true, items: [] } }));
  await page.route("**/api/ai/memory/suggestions?*", route => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/ai/nova/routines", route => {
    const request = route.request();
    if (request.method() === "POST") {
      calls.push({ method: "POST", path: "/api/ai/nova/routines", body: request.postDataJSON() });
      const created = { ...brief, ...request.postDataJSON(), id: "r2", last_run_at: null };
      routines = [...routines, created];
      return route.fulfill({ status: 201, json: created });
    }
    return route.fulfill({ json: { settings, memory_enabled: true, talk_room: false, timezone: "Europe/Berlin", max_routines: 20, routines, runs } });
  });
  await page.route("**/api/ai/nova/routines/*", route => {
    const request = route.request();
    calls.push({ method: request.method(), path: new URL(request.url()).pathname, body: request.postDataJSON?.() ?? null });
    if (request.method() === "PATCH") {
      routines = routines.map(r => (r.id === "r1" ? { ...r, ...request.postDataJSON() } : r));
      return route.fulfill({ json: routines[0] });
    }
    if (request.method() === "DELETE") { routines = routines.filter(r => r.id !== "r1"); return route.fulfill({ status: 204, body: "" }); }
    return route.fallback();
  });
  await page.route("**/api/ai/nova/routines/*/run", route => {
    calls.push({ method: "POST", path: new URL(route.request().url()).pathname, body: null });
    return route.fulfill({ status: 202, json: { queued: true } });
  });
  await page.route("**/api/ai/nova/data-sources", route => route.fulfill({ json: { cloud_provider: false, sources: [
    { kind: "caldav", label: "Nextcloud calendar", host: "cloud.example", calendars: ["personal"], task_lists: ["tasks"], entities: [], allow_cloud: false,
      secret_present: true, offered: true, tools: ["calendar_events", "calendar_tasks"] },
    { kind: "homeassistant", label: "Home Assistant", host: "ha.example", calendars: [], task_lists: [], entities: ["person.owner"], allow_cloud: false,
      secret_present: false, offered: true, tools: ["home_status", "home_history"] }] } }));
  await page.route("**/api/ai/nova/data-sources/test", route => route.fulfill({ json: { results: [
    { kind: "caldav", ok: true, error: null }, { kind: "homeassistant", ok: false, error: "The Home Assistant credential file is missing or unreadable." }] } }));
  await page.route("**/api/ai/nova/proactive", route => {
    settings = route.request().postDataJSON();
    calls.push({ method: "PUT", path: "/api/ai/nova/proactive", body: settings });
    return route.fulfill({ json: settings });
  });
  return calls;
}

async function openRoutines(page: Page) {
  await page.goto("/ai-agents/nova");
  await page.getByRole("tab", { name: "Routines" }).click();
}

test("proactive runs are off until the owner turns them on, with quiet hours and a daily limit", async ({ page }) => {
  const calls = await session(page);
  await openRoutines(page);
  await expect(page.getByText("cannot delegate to Ops Center")).toBeVisible();
  const routine = page.locator('[data-routine="Morning brief"]');
  await expect(routine).toContainText("Every day at 07:00");
  await expect(routine.getByRole("button", { name: "Run now" })).toBeDisabled();
  await expect(routine).toContainText("Next: —");

  await page.getByLabel("Allow proactive runs").check();
  await page.getByLabel("Quiet hours start").fill("23:00");
  await page.getByLabel("Messages per day").fill("2");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect.poll(() => calls.find(c => c.method === "PUT")?.body).toEqual({ enabled: true, quiet_start: "23:00", quiet_end: "07:00", max_per_day: 2 });
  await expect(routine.getByRole("button", { name: "Run now" })).toBeEnabled();

  await expect(page.locator('[data-run="run1"]')).toContainText("Not sent to Talk");
  await expect(page.locator('[data-run="run1"]')).toContainText("No private Talk room is routed to nova");
  await expect(page.locator('[data-run="run2"]')).toContainText("Skipped: quiet hours");
  await page.locator('[data-run="run1"] summary').click();
  await expect(page.locator('[data-run="run1"]')).toContainText("Shall I ask Ops Center to check the backups?");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test("routines are created from a template, edited, paused, run and deleted", async ({ page }) => {
  const calls = await session(page, true);
  await openRoutines(page);
  await page.getByRole("button", { name: "Add weekly summary" }).click();
  const form = page.locator("[data-routine-form]");
  await expect(form.getByLabel("Routine name")).toHaveValue("Weekly summary");
  await form.getByLabel("Day").selectOption("Sunday");
  await form.getByLabel("Channel").selectOption("talk");
  await expect(form.getByRole("alert")).toContainText("No private Talk room is routed to Nova");
  await form.getByRole("button", { name: "Create routine" }).click();
  await expect.poll(() => calls.find(c => c.method === "POST" && c.path === "/api/ai/nova/routines")?.body).toMatchObject(
    { name: "Weekly summary", schedule: "0 18 * * 0", channel: "talk", enabled: true });
  await expect(page.locator('[data-routine="Weekly summary"]')).toContainText("Sundays at 18:00");

  const routine = page.locator('[data-routine="Morning brief"]');
  await routine.getByRole("button", { name: "Edit" }).click();
  await form.getByLabel("Schedule").selectOption("weekdays");
  await form.getByLabel("Time").fill("06:30");
  await form.getByRole("button", { name: "Save routine" }).click();
  await expect.poll(() => calls.find(c => c.method === "PATCH")?.body).toMatchObject({ schedule: "30 6 * * 1-5" });
  await expect(routine).toContainText("Weekdays at 06:30");

  await routine.getByRole("button", { name: "Pause" }).click();
  await expect.poll(() => calls.filter(c => c.method === "PATCH").at(-1)?.body).toEqual({ enabled: false });
  await expect(routine).toContainText("paused");
  await routine.getByRole("button", { name: "Run now" }).click();
  await expect.poll(() => calls.some(c => c.path === "/api/ai/nova/routines/r1/run")).toBeTruthy();
  await expect(page.getByRole("status")).toContainText("Queued");

  page.once("dialog", dialog => void dialog.accept());
  await routine.getByRole("button", { name: "Delete" }).click();
  await expect(page.locator('[data-routine="Morning brief"]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test("data sources show what Nova can read and test the connection", async ({ page }) => {
  await session(page);
  await openRoutines(page);
  const calendar = page.locator('[data-source="caldav"]');
  const home = page.locator('[data-source="homeassistant"]');
  await expect(calendar).toContainText("Calendars: personal · Task lists: tasks");
  await expect(home).toContainText("credential missing");
  await expect(home).toContainText("Entities: person.owner");
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(calendar).toContainText("connected");
  await expect(home.getByRole("alert")).toContainText("credential file is missing");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});
