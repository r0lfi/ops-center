import type { ServiceStatus } from "@/lib/api";

/**
 * State, not magnitude - status color + text label (never color alone),
 * per the dataviz skill's component conventions for status indicators.
 */
export function ServiceStatusGrid({
  services,
  size = "sm",
}: {
  services: ServiceStatus[];
  size?: "sm" | "lg";
}) {
  if (services.length === 0) {
    return <p className="text-sm text-muted-foreground">No services probed yet.</p>;
  }

  return (
    <div
      className={`grid grid-cols-2 gap-2 sm:grid-cols-3 ${size === "lg" ? "lg:grid-cols-4" : "lg:grid-cols-6"}`}
    >
      {services.map((s) => (
        <div
          key={s.service}
          className={`flex items-center justify-between rounded-md border border-border bg-card/50 ${
            size === "lg" ? "p-4" : "p-2.5"
          }`}
        >
          <div className="flex items-center gap-2">
            <span
              className={`inline-block rounded-full ${size === "lg" ? "h-2.5 w-2.5" : "h-2 w-2"} ${
                s.up ? "bg-status-ok" : "bg-status-critical"
              }`}
            />
            <span className={size === "lg" ? "text-base font-medium" : "text-xs font-medium"}>{s.service}</span>
          </div>
          <div className="text-right">
            <div
              className={`font-semibold ${size === "lg" ? "text-sm" : "text-[11px]"} ${
                s.up ? "text-status-ok" : "text-status-critical"
              }`}
            >
              {s.up ? "UP" : "DOWN"}
            </div>
            {s.up && s.latency_ms !== null && (
              <div className={`text-muted-foreground ${size === "lg" ? "text-xs" : "text-[10px]"}`}>
                {s.latency_ms}ms
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
