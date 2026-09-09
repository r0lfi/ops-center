import { LayoutGrid } from "lucide-react";
import { Link } from "react-router-dom";

import { TrafficMap } from "@/components/traffic/TrafficMap";
import { Button } from "@/components/ui/button";

export default function TrafficMapPage() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Traffic Map</h1>
          <p className="text-sm text-muted-foreground">
            Live requests hitting edge-host and home (Nginx Proxy Manager), geolocated from real access
            logs - external clients only, LAN traffic is filtered out.
          </p>
        </div>
        <Link to="/wallboard">
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
