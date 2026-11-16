import { useEffect, useState } from "react";

import { api } from "@/lib/api";

export interface NavCounts {
  alerts: number;
  criticalAlerts: number;
  approvals: number;
}

const POLL_MS = 30000;

/** Live numbers for the menu. A failed source keeps its last value; the menu never blocks on them. */
export function useNavCounts(): NavCounts {
  const [counts, setCounts] = useState<NavCounts>({ alerts: 0, criticalAlerts: 0, approvals: 0 });
  useEffect(() => {
    let live = true;
    function poll() {
      if (document.visibilityState === "hidden") return;
      api.alerts.list().then((result) => {
        if (!live || !result.available) return;
        const active = result.alerts.filter((a) => a.status.state === "active");
        setCounts((value) => ({ ...value, alerts: active.length, criticalAlerts: active.filter((a) => a.labels.severity === "critical").length }));
      }).catch(() => {});
      api.ai.actions.list("pending", 100).then((rows) => {
        if (live) setCounts((value) => ({ ...value, approvals: rows.length }));
      }).catch(() => {});
    }
    poll();
    const timer = setInterval(poll, POLL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => { live = false; clearInterval(timer); document.removeEventListener("visibilitychange", poll); };
  }, []);
  return counts;
}
