import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Download, Share } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";

import { HEALTH_COMPONENT_LABELS, type HealthResponse } from "@/lib/api";
import { AppleInstallHelp } from "./AppleInstallHelp";

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
interface InstallAction { run: () => void; manual: boolean }
const InstallContext = createContext<InstallAction | null>(null);

// One failed check proves little: a phone waking up has no network for a few
// seconds, and a failover or redeploy lasts about as long. Block the app only
// when a second check, a few seconds later, agrees.
const FAILURES_BEFORE_BLOCKING = 2;
const RETRY_DELAY_MS = 4000;
const HEALTH_POLL_MS = 30000;
const HEALTH_TIMEOUT_MS = 10000;
const RECOVERED_NOTICE_MS = 10000;

type Outage = { kind: "network" } | { kind: "backend"; status: number; failing: string[] };

function outageText(outage: Outage): { title: string; detail: string } {
  if (outage.kind === "network") {
    return { title: "Ops Center is currently offline", detail: "This device can't reach the server. Check your network or VPN connection." };
  }
  if (outage.failing.includes("database")) {
    return { title: "Ops Center can't reach its database", detail: "The server is running, but these parts are failing:" };
  }
  return { title: "Ops Center's backend is not responding", detail: `The web server answered with HTTP ${outage.status}, but the API behind it is unavailable.` };
}

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
  const [outage, setOutage] = useState<Outage | null>(null);
  const blocked = outage !== null;
  const [recovered, setRecovered] = useState(false);
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
    let failures = 0;
    let retry: number | undefined;
    let wasBlocked = false;
    let hideNotice: number | undefined;
    const healthy = () => {
      failures = 0;
      setOutage(null);
      if (wasBlocked) {
        wasBlocked = false;
        setRecovered(true);
        clearTimeout(hideNotice);
        hideNotice = window.setTimeout(() => setRecovered(false), RECOVERED_NOTICE_MS);
      }
    };
    const check = async (deliberate = false) => {
      // While a retry is pending, other requests failing at the same time are
      // the same evidence, not a second opinion. Only the retry may decide.
      if (controller || disposed || (retry !== undefined && !deliberate)) return;
      clearTimeout(retry);
      retry = undefined;
      const failed = (found: Outage) => {
        // Browsers suspend network access for a hidden tab or a backgrounded
        // PWA, so a failure seen while hidden says nothing about the backend.
        if (disposed || document.visibilityState !== "visible") return;
        failures += 1;
        if (failures >= FAILURES_BEFORE_BLOCKING) {
          wasBlocked = true;
          setRecovered(false);
          setOutage(found);
        }
        retry = window.setTimeout(() => { void check(true); }, RETRY_DELAY_MS);
      };
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), HEALTH_TIMEOUT_MS);
      setChecking(true);
      try {
        const response = await fetch("/api/health", { cache: "no-store", credentials: "same-origin", signal: controller.signal });
        const health: Partial<HealthResponse> | null = await response.json().catch(() => null);
        const components = health?.components ?? {};
        if (response.ok && (health?.status === "ok" || health?.status === "degraded") && components.database === "ok") {
          if (!disposed) healthy();
        } else {
          failed({ kind: "backend", status: response.status, failing: Object.keys(components).filter(name => components[name] !== "ok") });
        }
      } catch {
        failed({ kind: "network" });
      } finally {
        clearTimeout(timeout);
        controller = undefined;
        if (!disposed) setChecking(false);
      }
    };
    checkBackend.current = () => { void check(true); };
    const visible = () => { if (document.visibilityState === "visible") void check(); };
    const interval = window.setInterval(visible, HEALTH_POLL_MS);
    // The offline event and a failed request are hints, not proof: check first.
    const suspect = () => { void check(); };
    window.addEventListener("offline", suspect);
    window.addEventListener("online", visible);
    window.addEventListener("ops-backend-unavailable", suspect);
    document.addEventListener("visibilitychange", visible);
    void check();
    return () => {
      disposed = true;
      clearInterval(interval);
      clearTimeout(retry);
      clearTimeout(hideNotice);
      controller?.abort();
      window.removeEventListener("offline", suspect);
      window.removeEventListener("online", visible);
      window.removeEventListener("ops-backend-unavailable", suspect);
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
    {outage && <Dialog.Root open><Dialog.Portal>
      <Dialog.Content className="pwa-offline" role="alertdialog" onEscapeKeyDown={event => event.preventDefault()} onInteractOutside={event => event.preventDefault()}>
      <div className="max-w-lg space-y-4 text-center">
        <img src="/icons/icon-192.png" alt="" width="72" height="72" className="mx-auto" />
        <Dialog.Title asChild><h1 className="text-2xl font-semibold">{outageText(outage).title}</h1></Dialog.Title>
        <Dialog.Description asChild><p className="text-muted-foreground">{outageText(outage).detail}</p></Dialog.Description>
        {outage.kind === "backend" && outage.failing.length > 0 && <ul className="mx-auto w-fit space-y-1 text-left text-sm">
          {outage.failing.map(name => <li key={name} className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-status-critical" />{HEALTH_COMPONENT_LABELS[name] ?? name}
          </li>)}
        </ul>}
        <p className="text-sm text-muted-foreground">Live data is hidden so old values aren't mistaken for current ones. This page keeps retrying and comes back by itself.</p>
        <button type="button" className="rounded-lg border border-primary px-4 py-2 focus-visible:ring-2 focus-visible:ring-ring"
          disabled={checking} onClick={() => checkBackend.current()}>
          {checking ? "Checking connection…" : "Retry now"}
        </button>
      </div>
      </Dialog.Content>
    </Dialog.Portal></Dialog.Root>}
    {recovered && !blocked && !updateReady && <div className="pwa-update" role="status">
      <span>Connection restored. Reload if this page looks out of date.</span>
      <button type="button" onClick={() => window.location.reload()} className="shrink-0 rounded-md border border-primary px-3 py-2 focus-visible:ring-2 focus-visible:ring-ring">Reload</button>
    </div>}
    {updateReady && !blocked && <div className="pwa-update" role="status">
      <span>{updateError ? "Update could not activate. Try Reload again." : "New Ops Center version available."} Save your work before reloading.</span>
      <button type="button" onClick={reload} className="shrink-0 rounded-md border border-primary px-3 py-2 focus-visible:ring-2 focus-visible:ring-ring">Reload</button>
    </div>}
  </InstallContext.Provider>;
}
