import { LayoutGrid } from "lucide-react";
import { Link, useLocation } from "react-router-dom";

import { TrafficMap } from "@/components/traffic/TrafficMap";
import { Button } from "@/components/ui/button";

export default function TrafficMapPage() {
  const { search } = useLocation();
  return (
    <div className="space-y-4">
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Traffic Map</h1>
          <p className="text-sm text-muted-foreground">
            External web traffic and authenticated VPN handshakes. Explore saved observations across your services.
          </p>
        </div>
        <Link to={{ pathname: "/traffic-map/wallboard", search }}>
          <Button variant="outline">
            <LayoutGrid className="mr-1.5 h-4 w-4" />
            Open Wallboard
          </Button>
        </Link>
      </div>
      <TrafficMap />
    </div>
  );
}
