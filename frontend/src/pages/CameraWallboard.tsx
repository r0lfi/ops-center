import { useEffect, useState } from "react";
import { ShieldCheck, X } from "lucide-react";

import { cameraStreamUrl } from "@/pages/Cameras";
import { api, type CameraStatus } from "@/lib/api";

const POLL_MS = 10000;

/**
 * Chrome-free, no sidebar (see App.tsx) - meant to be opened fullscreen on
 * a wall-mounted/spare monitor for live camera monitoring, same pattern as
 * the existing server Wallboard. Grid of every camera with a live stream
 * by default; click one to focus on it full-size without leaving the page.
 */
export default function CameraWallboard() {
  const [cameras, setCameras] = useState<CameraStatus[]>([]);
  const [focused, setFocused] = useState<string | null>(null);
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const result = await api.cameras.status();
        if (!cancelled) setCameras(result);
      } catch {
        // ignore - transient, next poll retries
      }
    }

    poll();
    const interval = setInterval(poll, POLL_MS);
    const clock = setInterval(() => setNow(new Date()), 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      clearInterval(clock);
    };
  }, []);

  const streamable = cameras.filter((c) => c.has_stream && c.reachable);
  const focusedCamera = streamable.find((c) => c.name === focused) ?? null;

  return (
    <div className="min-h-screen space-y-6 bg-black p-6 text-white">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <ShieldCheck className="h-6 w-6 text-primary" />
          <h1 className="text-xl font-semibold tracking-wide">Camera Wallboard</h1>
          <span className="flex items-center gap-1.5 text-xs text-status-ok">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-ok" />
            live
          </span>
        </div>
        <span className="font-mono text-lg tabular-nums text-white/70">{now.toLocaleTimeString()}</span>
      </div>

      {streamable.length === 0 && (
        <p className="text-sm text-white/60">No cameras are currently reachable with a live stream.</p>
      )}

      {focusedCamera ? (
        <div>
          <div className="mb-4 flex items-center gap-3">
            <h2 className="text-2xl font-semibold">{focusedCamera.name}</h2>
            <button
              onClick={() => setFocused(null)}
              className="flex items-center gap-1 rounded-md border border-white/20 px-2 py-1 text-xs text-white/70 hover:bg-white/10 hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
              all cameras
            </button>
          </div>
          <img
            src={cameraStreamUrl(focusedCamera.name)}
            alt={`${focusedCamera.name} live view`}
            className="mx-auto max-h-[80vh] rounded-md"
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {streamable.map((camera) => (
            <button
              key={camera.name}
              onClick={() => setFocused(camera.name)}
              className="overflow-hidden rounded-lg border border-white/10 bg-white/5 text-left transition-colors hover:border-primary"
            >
              <img src={cameraStreamUrl(camera.name)} alt={`${camera.name} live view`} className="w-full" />
              <h3 className="px-3 py-2 text-sm font-medium">{camera.name}</h3>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
