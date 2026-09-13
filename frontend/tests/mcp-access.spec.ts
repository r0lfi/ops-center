import { expect, test } from "@playwright/test";
test.use({ serviceWorkers: "block" });
const user = { id: "11111111-1111-4111-8111-111111111111", username: "demo-admin", role: "admin", is_active: true };
const tools = [
  { name: "ops_list_hosts", description: "List registered hosts.", scope: "ops:hosts:read", minimum_role: "viewer", method: "GET" },
  { name: "ops_restart_container", description: "Restart a container after human approval.", scope: "ops:containers:write", minimum_role: "admin", method: "POST" },
];
async function mock(page: import("@playwright/test").Page) {
  await page.addInitScript(() => localStorage.setItem("ops_center_token", "mcp-browser-test-only"));
  await page.route("**/api/auth/me", r => r.fulfill({ json: user }));
  await page.route("**/api/users", r => r.fulfill({ json: [user] }));
  await page.route("**/api/ai/agents", r => r.fulfill({ json: [{ id: "22222222-2222-4222-8222-222222222222", name: "Operations agent", enabled: true, allowed_tools: ["get_alerts"] }] }));
  await page.route("**/api/mcp/settings", r => r.fulfill({ json: { enabled: true, revision: 1, public_url: "https://ops.example.com/mcp", tools, scopes: ["ops:connect", ...tools.map(t => t.scope)] } }));
  for (const path of ["grants", "requests", "audit"]) await page.route("**/api/mcp/" + path, r => r.fulfill({ json: [] }));
}
test("register a client with explicit tools and users", async ({ page }) => {
  await mock(page);
  let saved: Record<string, unknown> | null = null;
  await page.route("**/api/mcp/clients", async r => {
    if (r.request().method() === "POST") { saved = r.request().postDataJSON(); return r.fulfill({ json: { ...saved, id: "synthetic-client-id" } }); }
    return r.fulfill({ json: [] });
  });
  await page.goto("/mcp-access");
  await page.getByLabel("Client name", { exact: true }).fill("Desktop assistant");
  await page.getByLabel("Exact redirect URIs, one per line").fill("http://127.0.0.1:43871/callback");
  await page.getByLabel("demo-admin (admin)", { exact: true }).check();
  const external = page.locator("section").filter({ has: page.getByRole("heading", { name: "External clients", exact: true }) });
  await external.getByLabel(/ops_list_hosts/).check();
  await external.getByRole("button", { name: "Save client", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Client saved");
  expect(saved).toMatchObject({ name: "Desktop assistant", allowed_tools: ["ops_list_hosts"], allowed_user_ids: [user.id], scopes: ["ops:connect", "ops:hosts:read"] });
  await expect(page.getByText("Client ID:")).toContainText("synthetic-client-id");
});
test("consent defaults to no tools and sends only the selected subset", async ({ page }) => {
  await mock(page);
  let decision: Record<string, unknown> | null = null;
  await page.route("**/api/mcp/consent/synthetic-request", async r => {
    if (r.request().method() === "POST") { decision = r.request().postDataJSON(); return r.fulfill({ status: 400, json: { detail: "Synthetic redirect stopped for test" } }); }
    return r.fulfill({ json: { client_name: "Desktop assistant", client_id: "synthetic-client-id", redirect_uri: "http://127.0.0.1:43871/callback", resource: "https://ops.example.com/mcp", tools } });
  });
  await page.goto("/mcp/consent?request=synthetic-request");
  await expect(page.getByRole("button", { name: "Authorize selected tools" })).toBeDisabled();
  await page.getByLabel(/ops_list_hosts/).check();
  await page.getByRole("button", { name: "Authorize selected tools" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Synthetic redirect stopped");
  expect(decision).toEqual({ approve: true, allowed_tools: ["ops_list_hosts"], days: 1 });
});
test("approval submits the displayed payload fingerprint", async ({ page }) => {
  await mock(page);
  await page.route("**/api/mcp/clients", r => r.fulfill({ json: [] }));
  const fingerprint = "a".repeat(64);
  const request = { request_id: "33333333-3333-4333-8333-333333333333", tool: "ops_restart_container", status: "pending", argument_digest: fingerprint,
    arguments: { path: { hostname: "demo-host", name: "demo-app" }, idempotency_key: "synthetic-change" }, result: null, expires_at: "2099-01-01T00:00:00Z" };
  await page.route("**/api/mcp/requests", r => r.fulfill({ json: [request] }));
  let body: Record<string, unknown> | null = null;
  await page.route("**/api/mcp/requests/*/decision", r => { body = r.request().postDataJSON(); return r.fulfill({ json: { status: "completed" } }); });
  await page.goto("/mcp-access");
  await expect(page.getByText('"hostname": "demo-host"', { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Approve exact request" }).click();
  await expect(page.getByRole("status")).toContainText("Decision recorded");
  expect(body).toEqual({ approve: true, argument_digest: fingerprint });
});
test("login preserves the OAuth consent request", async ({ page }) => {
  await page.route("**/api/auth/login", r => r.fulfill({ json: { access_token: "mcp-browser-test-only", token_type: "bearer" } }));
  await page.route("**/api/auth/me", r => r.fulfill({ json: user }));
  await page.route("**/api/mcp/consent/synthetic-request", r => r.fulfill({ json: { client_name: "Desktop assistant", client_id: "synthetic", redirect_uri: "http://127.0.0.1:43871/callback", resource: "https://ops.example.com/mcp", tools } }));
  await page.goto("/mcp/consent?request=synthetic-request");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Username", { exact: true }).fill("demo-admin");
  await page.getByLabel("Password", { exact: true }).fill("synthetic-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/mcp\/consent\?request=synthetic-request/);
  await expect(page.getByRole("heading", { name: "Desktop assistant", exact: true })).toBeVisible();
});

test("agent grant preserves native tools and binds one task owner", async ({ page }) => {
  await mock(page);
  await page.route("**/api/mcp/clients", r => r.fulfill({ json: [] }));
  let agentUpdate: Record<string, unknown> | null = null;
  let grant: Record<string, unknown> | null = null;
  await page.route("**/api/ai/agents/*", r => { agentUpdate=r.request().postDataJSON(); return r.fulfill({json:{}}); });
  await page.route("**/api/mcp/agent-grants", r => { grant=r.request().postDataJSON(); return r.fulfill({json:{}}); });
  await page.goto("/mcp-access");
  const section=page.locator("section").filter({has:page.getByRole("heading",{name:"Ops Floor agent access",exact:true})});
  await section.getByLabel("Agent",{exact:true}).selectOption("22222222-2222-4222-8222-222222222222");
  await section.getByLabel("Task owner",{exact:true}).selectOption(user.id);
  await section.getByLabel(/ops_list_hosts/).check();
  await section.getByRole("button",{name:"Enable tools and grant access"}).click();
  await expect(page.getByRole("status")).toContainText("Agent tools enabled and access granted");
  expect(agentUpdate).toEqual({allowed_tools:["get_alerts","ops_list_hosts"]});
  expect(grant).toMatchObject({agent_id:"22222222-2222-4222-8222-222222222222",user_id:user.id,allowed_tools:["ops_list_hosts"],days:1});
});
