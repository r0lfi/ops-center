export interface PlaybookMetadata { title: string; category: string; description: string }

const GROUPS: [string, [string, string, string][]][] = [
  ["Host setup", [
    ["bootstrap", "Bootstrap host", "Prepare a managed host for Ops Center automation."],
    ["gather-facts", "Gather host facts", "Collect operating system, hardware and network facts."],
    ["install-node-exporter", "Install node exporter", "Install and configure Prometheus host metrics collection."],
    ["install-alloy", "Install Grafana Alloy", "Install and configure log shipping to Loki."],
  ]],
  ["Patching & maintenance", [
    ["patch-check", "Check available updates", "Scan for pending packages and security updates."],
    ["patch-security", "Install security updates", "Apply available security patches to managed hosts."],
    ["patch-all", "Install all updates", "Apply all pending package updates, with rolling host batches."],
    ["pihole-update", "Update Pi-hole", "Update the Pi-hole DNS application."],
    ["reboot-check", "Check reboot requirement", "Check whether a host needs a reboot."],
    ["reboot", "Reboot hosts", "Reboot managed hosts and check readiness afterwards."],
  ]],
  ["Health & diagnostics", [
    ["health-check", "Host health check", "Inspect host health and report diagnostic results."],
    ["service-check", "Check services", "Inspect the state of system services."],
    ["process-check", "Inspect processes", "Inspect processes and CPU or memory usage."],
    ["vulnerability-scan", "Collect package inventory", "Collect installed package versions for vulnerability analysis."],
  ]],
  ["Containers", [
    ["container-inventory", "Discover containers", "Collect Docker container inventory from a managed host."],
    ["container-control", "Control a container", "Start, stop or restart a selected container."],
    ["container-exec", "Execute in a container", "Run a command inside a selected container."],
    ["docker-inspect", "Inspect container", "Read detailed Docker container configuration."],
    ["docker-logs", "Read container logs", "Retrieve log output from a selected container."],
    ["docker-stats", "Container resource usage", "Collect CPU, memory and I/O statistics."],
    ["docker-events", "Docker events", "Read recent Docker daemon events."],
  ]],
  ["Images, networks & volumes", [
    ["docker-images", "List Docker images", "List local images, tags and sizes."],
    ["docker-pull-image", "Pull Docker image", "Download an image from a container registry."],
    ["docker-networks", "List Docker networks", "Inspect networks and connected containers."],
    ["docker-volumes", "List Docker volumes", "List persistent volumes on a Docker host."],
  ]],
  ["Stacks", [
    ["docker-stack-list", "List stacks", "List Docker Compose projects on a host."],
    ["docker-stack-get", "Read stack configuration", "Retrieve a stack's Compose configuration."],
    ["docker-stack-ps", "List stack containers", "Inspect containers belonging to a stack."],
    ["docker-stack-deploy", "Deploy stack", "Deploy a Docker Compose stack to a host."],
    ["docker-stack-remove", "Remove stack", "Remove a Docker Compose stack from a host."],
    ["docker-stack-action", "Control stack", "Start, stop, restart or pull a stack's services."],
    ["docker-discover-stacks", "Discover existing stacks", "Discover Compose projects for the stack inventory."],
  ]],
  ["Commands & services", [
    ["restart-service", "Restart system service", "Restart a selected system service."],
    ["run-shell-command", "Run shell command", "Execute a supplied shell command on a managed host."],
  ]],
];
const CATALOG: Record<string, PlaybookMetadata> = Object.fromEntries(GROUPS.flatMap(([category, entries]) => entries.map(([name, title, description]) => [`${name}.yml`, { title, category, description }])));
export function playbookMetadata(name: string): PlaybookMetadata {
  return CATALOG[name] ?? { title: name.replace(/\.ya?ml$/, "").replace(/[-_]/g, " "), category: "Other", description: "Registered automation playbook. Open the source to see its tasks and configuration." };
}
