import { useEffect, useState } from "react";
import { Camera as CameraIcon, Maximize2, MonitorPlay, X } from "lucide-react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, getToken, type CameraStatus } from "@/lib/api";

export function cameraStreamUrl(name: string): string {
  // MJPEG multipart response - a plain <img> renders each frame as it
  // arrives, no player library needed. Token has to ride along as a query
  // param since an <img> can't send a header (same pattern as
  // lib/opsFloorEvents.ts's EventSource stream).
  return `/api/cameras/${name}/stream.mjpeg?token=${encodeURIComponent(getToken() ?? "")}`;
}

// Matches worker/scheduled_tasks.py's _FAILURE_THRESHOLD - only used here
// to color the badge before a camera has actually reached the watchdog's
// own kick threshold (a couple of failed checks isn't "critical" yet).
const FAILURE_THRESHOLD = 3;

const RESULT_LABEL: Record<string, string> = {
  kicked: "Kicked off WiFi",
  not_found: "Down, but not a known WiFi client (can't kick)",
  error: "Kick attempt failed (see worker logs)",
};

function formatRelative(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function EnlargedCameraDialog({ camera, onClose }: { camera: CameraStatus; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
      onClick={onClose}
    >
      <div className="relative max-h-full max-w-full" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={onClose}
          className="absolute -top-10 right-0 flex items-center gap-1 rounded-md px-2 py-1 text-sm text-white/80 hover:text-white"
        >
          <X className="h-4 w-4" />
          Close
        </button>
        <img
          src={cameraStreamUrl(camera.name)}
          alt={`${camera.name} live view`}
          className="max-h-[90vh] max-w-[90vw] rounded-md"
        />
      </div>
    </div>
  );
}

function CameraCard({ camera, onEnlarge }: { camera: CameraStatus; onEnlarge: (camera: CameraStatus) => void }) {
  const variant = camera.reachable ? "ok" : camera.consecutive_fails >= FAILURE_THRESHOLD ? "critical" : "warning";
  const canShowStream = camera.has_stream && camera.reachable;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            {camera.name}
            {camera.kind === "ring" && <Badge variant="unknown">ring</Badge>}
          </span>
          <Badge variant={variant}>{camera.reachable ? "reachable" : "unreachable"}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {canShowStream && (
          <button
            type="button"
            onClick={() => onEnlarge(camera)}
            className="group relative block w-full overflow-hidden rounded-md border border-border"
          >
            <img src={cameraStreamUrl(camera.name)} alt={`${camera.name} live view`} className="w-full" />
            <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-opacity group-hover:bg-black/30 group-hover:opacity-100">
              <Maximize2 className="h-6 w-6 text-white" />
            </span>
          </button>
        )}
        <div className="flex justify-between">
          <span className="text-muted-foreground">IP</span>
          <span className="font-mono">{camera.ip}</span>
        </div>
        {camera.kind === "tapo" && !camera.reachable && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Consecutive failed checks</span>
            <span>{camera.consecutive_fails}</span>
          </div>
        )}
        {camera.cooldown_remaining_seconds !== null && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Watchdog cooldown</span>
            <span>{Math.ceil(camera.cooldown_remaining_seconds / 60)}m remaining</span>
          </div>
        )}
        {camera.last_kick_at && (
          <div className="border-t border-border pt-2">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Last watchdog action
            </p>
            <div className="flex justify-between text-xs">
              <span>{RESULT_LABEL[camera.last_kick_result ?? ""] ?? camera.last_kick_result}</span>
              <span className="text-muted-foreground">{formatRelative(camera.last_kick_at)}</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Cameras() {
  const [cameras, setCameras] = useState<CameraStatus[] | null>(null);
  const [enlarged, setEnlarged] = useState<CameraStatus | null>(null);

  useEffect(() => {
    function refresh() {
      api.cameras.status().then(setCameras).catch(() => setCameras(null));
    }
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <CameraIcon className="h-5 w-5" />
            Cameras
          </h1>
          <p className="text-sm text-muted-foreground">
            Live reachability + the background watchdog's state for the 4 Tapo cameras (RTSP probe
            every 60s, auto-kick off WiFi via UniFi after {FAILURE_THRESHOLD} consecutive failures),
            plus the Ring doorbell's live view. Click a camera's image to enlarge it.
          </p>
        </div>
        <Link
          to="/cameras/wallboard"
          className="flex shrink-0 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <MonitorPlay className="h-4 w-4" />
          Fullscreen wallboard
        </Link>
      </div>

      {!cameras && <p className="text-sm text-status-warning">Camera status is unavailable right now.</p>}

      {cameras && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {cameras.map((camera) => (
            <CameraCard key={camera.name} camera={camera} onEnlarge={setEnlarged} />
          ))}
        </div>
      )}

      {enlarged && <EnlargedCameraDialog camera={enlarged} onClose={() => setEnlarged(null)} />}
    </div>
  );
}
