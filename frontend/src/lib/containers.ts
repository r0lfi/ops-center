interface ContainerState {
  status: string;
  health?: string | null;
}

// Docker keeps the last health result after a container stops, so a stored
// "unhealthy" only describes a container that is still running.
export function isUnhealthy(container: ContainerState) {
  return container.status === "running" && container.health === "unhealthy";
}

export function isExited(container: ContainerState) {
  return container.status === "exited";
}

/** The health result that still applies, or null once the container is not running. */
export function currentHealth(container: ContainerState) {
  return container.status === "running" ? container.health ?? null : null;
}
