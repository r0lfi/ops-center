import type { Page } from "@playwright/test";

const now = new Date().toISOString();

export function alert(name: string, severity: string, labels: Record<string, string> = {}, startsAt = now) {
  return {
    fingerprint: `${name}-${severity}-${JSON.stringify(labels)}`,
    labels: { alertname: name, severity, ...labels },
    annotations: { summary: `${name} summary`, description: "" },
    status: { state: "active" }, startsAt, endsAt: now, generatorURL: "",
  };
}

export function host(hostname: string, extra: Record<string, unknown> = {}) {
  return {
    id: `id-${hostname}`, hostname, ip_address: "198.51.100.11", environment: "test", criticality: "medium", tags: [],
    reboot_required: false, last_seen: now, operating_system: "Test Linux", os_version: "1",
    onboarding_steps: [{ step: "verify_network", status: "ok", detail: "" }, { step: "verify_ssh", status: "ok", detail: "" }],
    ...extra,
  };
}

export function container(name: string, status: string, health: string | null, extra: Record<string, unknown> = {}) {
  return { id: `c-${name}`, hostname: "alpha", name, image: "registry.example/some/very/long/image-name:1.2.3", status, health, restart_count: 0, last_seen: now, ...extra };
}

/** Signs in with the fixture token and answers the listed API paths. Everything else keeps the fixture's empty list. */
export async function signIn(page: Page, routes: Record<string, unknown> = {}) {
  await page.addInitScript(() => (document.cookie = "ops_refresh=" + "pwa-test-only" + "; path=/"));
  for (const [path, body] of Object.entries(routes)) {
    await page.route(`**${path}`, (route) => route.fulfill({ json: body }));
  }
}
