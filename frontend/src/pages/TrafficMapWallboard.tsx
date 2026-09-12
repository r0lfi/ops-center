import { ArrowLeft, Radar } from "lucide-react";
import { Link, useLocation } from "react-router-dom";

import { TrafficMap } from "@/components/traffic/TrafficMap";
import { Button } from "@/components/ui/button";

export default function TrafficMapWallboard() {
  const { search } = useLocation();
  return (
    <main className="min-h-screen space-y-4 bg-background p-3 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Radar className="h-6 w-6 text-primary" />
          <h1 className="text-xl font-semibold">Traffic Map Wallboard</h1>
        </div>
        <Button variant="outline" asChild>
          <Link to={{ pathname: "/traffic-map", search }}>
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Back to Traffic Map
          </Link>
        </Button>
      </header>
      <TrafficMap />
    </main>
  );
}
