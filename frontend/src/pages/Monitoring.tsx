import { ExternalLink, LayoutGrid } from "lucide-react";
import { Link } from "react-router-dom";

import { FleetMetricsGrid } from "@/components/monitoring/FleetMetricsGrid";
import { ServicesSection } from "@/components/monitoring/ServicesSection";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const DASHBOARDS = [
  { title: "Fleet Overview", uid: "ops-fleet-overview", slug: "fleet-overview" },
  { title: "Linux Host Overview", uid: "ops-linux-host-overview", slug: "linux-host-overview" },
  { title: "Filesystem", uid: "ops-filesystem", slug: "filesystem" },
  { title: "Network", uid: "ops-network", slug: "network" },
  { title: "Systemd Services", uid: "ops-systemd-services", slug: "systemd-services" },
  { title: "Blackbox Monitoring", uid: "ops-blackbox", slug: "blackbox-monitoring" },
  { title: "Containers", uid: "ops-containers", slug: "containers" },
];

export default function Monitoring() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Monitoring</h1>
        <Link to="/wallboard">
          <Button variant="outline">
            <LayoutGrid className="mr-1.5 h-4 w-4" />
            Open Wallboard
          </Button>
        </Link>
      </div>

      <ServicesSection />
      <FleetMetricsGrid />

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Grafana Dashboards
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {DASHBOARDS.map((d) => (
            <a
              key={d.uid}
              href={`/grafana/d/${d.uid}/${d.slug}`}
              target="_blank"
              rel="noreferrer"
            >
              <Card className="transition-colors hover:border-primary">
                <CardHeader className="flex-row items-center justify-between space-y-0">
                  <CardTitle>{d.title}</CardTitle>
                  <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">Open in Grafana</CardContent>
              </Card>
            </a>
          ))}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Patch and vulnerability data lives in the dedicated Patching/Vulnerabilities/Security
        Intelligence pages instead of Grafana - it's relational (advisories, CVE correlation), not
        time-series metrics.
      </p>
    </div>
  );
}
