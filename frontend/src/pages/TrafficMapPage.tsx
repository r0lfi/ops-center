import { LayoutGrid } from "lucide-react";
import { Link, useLocation } from "react-router-dom";

import { PageHeader } from "@/components/layout/PageHeader";
import { TrafficMap } from "@/components/traffic/TrafficMap";
import { Button } from "@/components/ui/button";

export default function TrafficMapPage() {
  const { search } = useLocation();
  return (
    <div className="space-y-4">
      <PageHeader title="Traffic Map" description={<>External web traffic and authenticated VPN handshakes. Explore saved observations across your services.</>} actions={<><Link to={{ pathname: "/traffic-map/wallboard", search }}>
          <Button variant="outline">
            <LayoutGrid className="mr-1.5 h-4 w-4" />
            Open Wallboard
          </Button>
        </Link></>} />
      <TrafficMap />
    </div>
  );
}
