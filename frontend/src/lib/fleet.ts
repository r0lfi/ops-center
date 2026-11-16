import type { AlertmanagerAlert, Host } from "@/lib/api";

export type HostReachability = "online" | "offline" | "no-ssh";

/** Hostnames Prometheus cannot scrape right now, from active ServerDown alerts. */
export function downHostnames(alerts: AlertmanagerAlert[] | null | undefined): Set<string> {
  const names = (alerts ?? [])
    .filter((a) => a.labels.alertname === "ServerDown" && a.status.state === "active")
    .map((a) => a.labels.hostname ?? a.labels.instance);
  return new Set(names.filter((name): name is string => !!name));
}

/**
 * The onboarding checks run once, so alone they say nothing about the host
 * today. A firing ServerDown alert is the live signal and overrides them.
 */
export function hostReachability(host: Host, down: Set<string>): HostReachability {
  const network = host.onboarding_steps.find((s) => s.step === "verify_network");
  const ssh = host.onboarding_steps.find((s) => s.step === "verify_ssh");
  if (down.has(host.hostname) || network?.status !== "ok") return "offline";
  return ssh?.status === "ok" ? "online" : "no-ssh";
}

export function fleetCounts(hosts: Host[], alerts: AlertmanagerAlert[] | null | undefined) {
  const down = downHostnames(alerts);
  const counts = { total: hosts.length, online: 0, offline: 0, warning: 0, rebootRequired: 0 };
  for (const host of hosts) {
    const state = hostReachability(host, down);
    if (state === "offline") counts.offline += 1;
    else if (state === "no-ssh") counts.warning += 1;
    else counts.online += 1;
    if (host.reboot_required) counts.rebootRequired += 1;
  }
  return counts;
}
