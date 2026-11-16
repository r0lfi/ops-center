import { useEffect, useMemo, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Search } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { api } from "@/lib/api";
import { buildGroups, loadRecent, rememberRecent, type PaletteItem } from "@/lib/commandPalette";
import { cn } from "@/lib/utils";

import { NAV_PAGES } from "./Sidebar";

const DATA_TTL_MS = 60000;
const CVE_QUERY = /(cve[-\s]?\d|^\d{4}-\d)/i;

function path(...parts: string[]) {
  return parts.map(encodeURIComponent).join("/");
}

/** Everything searchable except CVEs, which are too many to load and are asked for by query. */
async function loadItems(): Promise<PaletteItem[]> {
  const [hosts, containers, alerts, playbooks] = await Promise.allSettled([
    api.hosts.list(), api.containers.list(), api.alerts.list(), api.ansible.list(),
  ]);
  const items: PaletteItem[] = [];
  if (hosts.status === "fulfilled") for (const host of hosts.value) {
    items.push({ id: `server:${host.id}`, kind: "server", label: host.hostname, hint: host.ip_address, to: `/servers/${host.id}` });
  }
  if (containers.status === "fulfilled") for (const c of containers.value) {
    items.push({ id: `container:${c.hostname}/${c.name}`, kind: "container", label: c.name, hint: c.hostname, keywords: c.image, to: `/containers/${path(c.hostname, c.name)}` });
  }
  if (alerts.status === "fulfilled") for (const a of alerts.value.alerts.filter((alert) => alert.status.state === "active")) {
    const host = a.labels.hostname ?? a.labels.instance ?? "";
    const params = new URLSearchParams({ alert: a.labels.alertname, ...(host ? { host } : {}) });
    items.push({ id: `alert:${a.labels.alertname}/${host}`, kind: "alert", label: a.labels.alertname, hint: host, keywords: a.annotations.summary, to: `/alerts?${params}` });
  }
  if (playbooks.status === "fulfilled") for (const name of playbooks.value) {
    items.push({ id: `playbook:${name}`, kind: "playbook", label: name, to: `/automation/playbooks?playbook=${encodeURIComponent(name)}` });
  }
  return items;
}

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<PaletteItem[]>([]);
  const [cves, setCves] = useState<PaletteItem[]>([]);
  const [recent, setRecent] = useState<PaletteItem[]>([]);
  const [active, setActive] = useState(0);
  const loadedAt = useRef(0);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    setRecent(loadRecent());
    if (Date.now() - loadedAt.current < DATA_TTL_MS) return;
    loadedAt.current = Date.now();
    void loadItems().then(setItems);
  }, [open]);

  useEffect(() => {
    const term = query.trim();
    if (!open || !CVE_QUERY.test(term)) { setCves([]); return; }
    let live = true;
    const timer = setTimeout(() => {
      api.security.vulnerabilities({ search: term.replace(/\s+/g, "-"), limit: 6 }).then((rows) => {
        if (live) setCves(rows.map((v) => ({ id: `cve:${v.cve_id}`, kind: "cve", label: v.cve_id, hint: v.severity, keywords: term, to: `/vulnerabilities?cve=${encodeURIComponent(v.cve_id)}` })));
      }).catch(() => { if (live) setCves([]); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [query, open]);

  const groups = useMemo(() => buildGroups([...NAV_PAGES, ...items, ...cves], recent, query), [items, cves, recent, query]);
  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const current = Math.min(active, Math.max(flat.length - 1, 0));

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [current, flat]);

  function choose(item: PaletteItem) {
    rememberRecent(item);
    onOpenChange(false);
    navigate(item.to);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown" && flat.length) { event.preventDefault(); setActive((current + 1) % flat.length); }
    else if (event.key === "ArrowUp" && flat.length) { event.preventDefault(); setActive((current - 1 + flat.length) % flat.length); }
    else if (event.key === "Home" && event.ctrlKey) { event.preventDefault(); setActive(0); }
    else if (event.key === "End" && event.ctrlKey) { event.preventDefault(); setActive(flat.length - 1); }
    else if (event.key === "Enter" && flat[current]) { event.preventDefault(); choose(flat[current]); }
  }

  let index = -1;
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-background/80 backdrop-blur-sm" />
        <DialogPrimitive.Content aria-describedby={undefined} onKeyDown={onKeyDown}
          className="fixed left-1/2 top-[10vh] z-[60] flex max-h-[75dvh] w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
          <DialogPrimitive.Title className="sr-only">Search Ops Center</DialogPrimitive.Title>
          <div className="flex items-center gap-3 border-b border-border px-4">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input autoFocus type="text" role="combobox" aria-expanded="true" aria-controls="palette-results" aria-autocomplete="list" aria-label="Search pages, servers, containers, alerts, CVEs and playbooks"
              aria-activedescendant={flat[current] ? `palette-${current}` : undefined} value={query} onChange={(event) => setQuery(event.target.value)}
              placeholder="Search pages, servers, containers, alerts, CVEs, playbooks…" className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
          </div>
          <div ref={list} id="palette-results" role="listbox" aria-label="Results" className="ops-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
            {groups.map((group) => (
              <div key={group.title} role="group" aria-label={group.title} className="mb-1">
                <div aria-hidden="true" className="px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{group.title}</div>
                {group.items.map((item) => {
                  index += 1;
                  const position = index;
                  return (
                    <button key={item.id} id={`palette-${position}`} type="button" role="option" tabIndex={-1} aria-selected={position === current} data-active={position === current}
                      onMouseMove={() => setActive(position)} onClick={() => choose(item)}
                      className={cn("flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm", position === current ? "bg-accent text-foreground" : "text-muted-foreground")}>
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.hint && <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">{item.hint}</span>}
                    </button>
                  );
                })}
              </div>
            ))}
            {!flat.length && <p role="status" className="px-2 py-8 text-center text-sm text-muted-foreground">No results. Try another search term.</p>}
          </div>
          <div aria-hidden="true" className="hidden gap-4 border-t border-border px-4 py-2 text-[11px] text-muted-foreground sm:flex">
            <span>↑↓ move</span><span>Enter open</span><span>Esc close</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
