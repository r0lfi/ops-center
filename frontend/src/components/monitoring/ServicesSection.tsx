import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { ServiceStatusGrid } from "@/components/monitoring/ServiceStatusGrid";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type ServiceStatus } from "@/lib/api";

const POLL_MS = 15000;

/**
 * Self-hosted apps outside Ops Center's own inventory (Jellyfin, Sonarr,
 * Home Assistant, ...) - up/down + latency via the blackbox_apps
 * Prometheus job (monitoring/prometheus/prometheus.yml), not full hosts.
 */
export function ServicesSection() {
  const [params] = useSearchParams();
  const auto = params.get("auto") !== "off";
  const [services, setServices] = useState<ServiceStatus[]>([]);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      if (document.hidden) return;
      try {
        const result = await api.metrics.services();
        if (!cancelled) {
          setServices(result.services);
          setAvailable(result.available);
        }
      } catch {
        if (!cancelled) setAvailable(false);
      }
    }
    poll();
    const interval = auto ? setInterval(poll, POLL_MS) : undefined;
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [auto]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Services</CardTitle>
      </CardHeader>
      <CardContent>
        {!available && <p className="text-sm text-status-warning">Prometheus is unreachable right now.</p>}
        <ServiceStatusGrid services={services} size="sm" />
      </CardContent>
    </Card>
  );
}
