import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Download, Share } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";

import { AppleInstallHelp } from "./AppleInstallHelp";

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
interface InstallAction { run: () => void; manual: boolean }
const InstallContext = createContext<InstallAction | null>(null);

export function InstallOpsCenter({ compact = true }: { compact?: boolean }) {
  const install = useContext(InstallContext);
  if (!install) return null;
  const label = install.manual ? "Add to Home Screen" : "Install Ops Center";
  const Icon = install.manual ? Share : Download;
  return <button type="button" onClick={install.run} title={label} aria-label={label} aria-haspopup={install.manual ? "dialog" : undefined}
    className="shrink-0 rounded-xl border border-border p-2 text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
    <Icon className={compact ? "h-4 w-4 sm:hidden" : "mr-2 inline h-4 w-4"} />
    <span className={compact ? "hidden sm:inline" : undefined}>{label}</span>
  </button>;
}

export function PwaProvider({ children }: { children: ReactNode }) {
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [standalone, setStandalone] = useState(() => window.matchMedia("(display-mode: standalone)").matches
    || !!(navigator as Navigator & { standalone?: boolean }).standalone);
  // iPadOS can identify itself as a Mac when requesting desktop websites.
  const [appleMobile] = useState(() => /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
  const [appleHelpOpen, setAppleHelpOpen] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [updateError, setUpdateError] = useState(false);
  const registration = useRef<ServiceWorkerRegistration>();
  const reloadRequested = useRef(false);
  const content = useRef<HTMLDivElement>(null);
  const [blocked, setBlocked] = useState(!navigator.onLine);
  const [reachable, setReachable] = useState(false);
  const [checking, setChecking] = useState(false);
  const checkBackend = useRef<() => void>(() => {});

  useEffect(() => {
    const display = window.matchMedia("(display-mode: standalone)");
    const changed = () => setStandalone(display.matches || !!(navigator as Navigator & { standalone?: boolean }).standalone);
    const offered = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPrompt); };
    const installed = () => { setInstallPrompt(null); setStandalone(true); };
    window.addEventListener("beforeinstallprompt", offered);
    window.addEventListener("appinstalled", installed);
    display.addEventListener("change", changed);
    return () => {
      window.removeEventListener("beforeinstallprompt", offered);
      window.removeEventListener("appinstalled", installed);
      display.removeEventListener("change", changed);
    };
  }, []);

  useEffect(() => {
    if (!import.meta.env.PROD || !window.isSecureContext || !("serviceWorker" in navigator)) return;
    let disposed = false;
    let watched: ServiceWorker | null = null;
    let current: ServiceWorkerRegistration | undefined;
    const stateChanged = () => {
      if (!disposed && current?.waiting && navigator.serviceWorker.controller) setUpdateReady(true);
    };
    const found = () => {
      watched?.removeEventListener("statechange", stateChanged);
      watched = current?.installing ?? null;
      watched?.addEventListener("statechange", stateChanged);
    };
    const changed = () => {
      if (reloadRequested.current) window.location.reload();
      else setUpdateReady(true); // Other open tabs keep their active sessions.
    };
    const check = () => {
      if (navigator.onLine && document.visibilityState === "visible") void current?.update().catch(() => {});
    };
    navigator.serviceWorker.addEventListener("controllerchange", changed);
    void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((reg) => {
        if (disposed) return;
        registration.current = current = reg;
        if (reg.waiting) setUpdateReady(true);
        reg.addEventListener("updatefound", found);
        found();
      }).catch(() => { /* Ordinary web access remains usable without a worker. */ });
    const interval = window.setInterval(check, 60 * 60 * 1000);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("online", check);
    return () => {
      disposed = true;
      clearInterval(interval);
      watched?.removeEventListener("statechange", stateChanged);
      current?.removeEventListener("updatefound", found);
      navigator.serviceWorker.removeEventListener("controllerchange", changed);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("online", check);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | undefined;
    const offline = () => { setBlocked(true); setReachable(false); };
    const check = async () => {
      if (controller || disposed) return;
      if (!navigator.onLine) { offline(); return; }
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 15000);
      setChecking(true);
      try {
        const response = await fetch("/api/health", { cache: "no-store", credentials: "same-origin", signal: controller.signal });
        const health = await response.json();
        if (!response.ok || !["ok", "degraded"].includes(health.status) || health.components?.database !== "ok") throw new Error("Backend unavailable");
        if (!disposed) setReachable(true);
      } catch {
        if (!disposed) offline();
      } finally {
        clearTimeout(timeout);
        controller = undefined;
        if (!disposed) setChecking(false);
      }
    };
    checkBackend.current = () => { void check(); };
    const visible = () => { if (document.visibilityState === "visible") void check(); };
    const interval = window.setInterval(visible, 30000);
    window.addEventListener("offline", offline);
    window.addEventListener("online", visible);
    window.addEventListener("ops-backend-unavailable", offline);
    document.addEventListener("visibilitychange", visible);
    void check();
    return () => {
      disposed = true;
      clearInterval(interval);
      controller?.abort();
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", visible);
      window.removeEventListener("ops-backend-unavailable", offline);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);

  useEffect(() => { if (content.current) content.current.inert = blocked; }, [blocked]);

  const install: InstallAction | null = standalone ? null : installPrompt ? {
    manual: false,
    run: () => { void installPrompt.prompt().then(() => installPrompt.userChoice).finally(() => setInstallPrompt(null)).catch(() => {}); },
  } : appleMobile && window.isSecureContext ? {
    manual: true,
    run: () => setAppleHelpOpen(true),
  } : null;
  const reload = () => {
    setUpdateError(false);
    const waiting = registration.current?.waiting;
    if (!waiting) { window.location.reload(); return; }
    reloadRequested.current = true;
    waiting.postMessage({ type: "SKIP_WAITING" });
    window.setTimeout(() => {
      if (reloadRequested.current) { reloadRequested.current = false; setUpdateError(true); }
    }, 10000);
  };

  return <InstallContext.Provider value={install}>
    <div ref={content} style={blocked ? { visibility: "hidden" } : undefined} aria-hidden={blocked || undefined}>{children}</div>
    <AppleInstallHelp open={appleHelpOpen && !standalone && !blocked} onOpenChange={setAppleHelpOpen} />
    {blocked && <Dialog.Root open><Dialog.Portal>
      <Dialog.Content className="pwa-offline" role="alertdialog" onEscapeKeyDown={event => event.preventDefault()} onInteractOutside={event => event.preventDefault()}>
      <div className="max-w-lg space-y-4 text-center">
        <img src="/icons/icon-192.png" alt="" width="72" height="72" className="mx-auto" />
        <Dialog.Title asChild><h1 className="text-2xl font-semibold">Ops Center is currently offline</h1></Dialog.Title>
        <Dialog.Description asChild><p className="text-muted-foreground">Live status and actions are unavailable. Previously loaded data is hidden until you reload with a working backend connection.</p></Dialog.Description>
        {reachable && <p>Backend connection restored. Reload to fetch current data.</p>}
        <button type="button" className="rounded-lg border border-primary px-4 py-2 focus-visible:ring-2 focus-visible:ring-ring"
          disabled={checking} onClick={() => reachable ? window.location.reload() : checkBackend.current()}>
          {checking ? "Checking connection…" : reachable ? "Reload Ops Center" : "Retry connection"}
        </button>
      </div>
      </Dialog.Content>
    </Dialog.Portal></Dialog.Root>}
    {updateReady && !blocked && <div className="pwa-update" role="status">
      <span>{updateError ? "Update could not activate. Try Reload again." : "New Ops Center version available."} Save your work before reloading.</span>
      <button type="button" onClick={reload} className="shrink-0 rounded-md border border-primary px-3 py-2 focus-visible:ring-2 focus-visible:ring-ring">Reload</button>
    </div>}
  </InstallContext.Provider>;
}
