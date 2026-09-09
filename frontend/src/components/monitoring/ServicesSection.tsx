import { useEffect, useState } from "react";

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
  const [services, setServices] = useState<ServiceStatus[]>([]);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const result = await api.metrics.services();
        if (!cancelled) {
          setServices(result.services);
          setAvailable(result.available);
        }
      } catch {
        // ignore - transient, next poll retries
      }
    }
    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

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
