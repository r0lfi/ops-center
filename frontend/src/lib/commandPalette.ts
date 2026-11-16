export type PaletteKind = "page" | "server" | "container" | "alert" | "cve" | "playbook";

export interface PaletteItem {
  id: string;
  kind: PaletteKind;
  label: string;
  hint?: string;
  /** Where the item leads. The palette only ever navigates. */
  to: string;
  /** Extra words to match that are not shown. */
  keywords?: string;
}

export interface PaletteGroup {
  title: string;
  items: PaletteItem[];
}

const RECENT_KEY = "ops-palette-recent";
const MAX_RECENT = 8;
const MAX_PER_GROUP = 6;

const GROUP_TITLES: [PaletteKind, string][] = [
  ["page", "Pages"], ["server", "Servers"], ["container", "Containers"],
  ["alert", "Alerts"], ["cve", "CVEs"], ["playbook", "Playbooks"],
];

export function matches(item: PaletteItem, query: string) {
  const text = `${item.label} ${item.hint ?? ""} ${item.keywords ?? ""}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => text.includes(word));
}

/** Recent picks come first, and each item appears once. */
export function buildGroups(items: PaletteItem[], recent: PaletteItem[], query: string): PaletteGroup[] {
  const wanted = (item: PaletteItem) => matches(item, query);
  const recentHits = recent.filter(wanted);
  const taken = new Set(recentHits.map((item) => item.id));
  const groups: PaletteGroup[] = recentHits.length ? [{ title: "Recent", items: recentHits }] : [];
  if (!query.trim()) return [...groups, ...pagesOnly(items, taken)];
  for (const [kind, title] of GROUP_TITLES) {
    const hits = items.filter((item) => item.kind === kind && !taken.has(item.id) && wanted(item)).slice(0, MAX_PER_GROUP);
    if (hits.length) groups.push({ title, items: hits });
  }
  return groups;
}

function pagesOnly(items: PaletteItem[], taken: Set<string>): PaletteGroup[] {
  const pages = items.filter((item) => item.kind === "page" && !taken.has(item.id));
  return pages.length ? [{ title: "Pages", items: pages }] : [];
}

export function loadRecent(): PaletteItem[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is PaletteItem => !!v && typeof v.id === "string" && typeof v.to === "string" && typeof v.label === "string") : [];
  } catch { return []; }
}

export function rememberRecent(item: PaletteItem) {
  const next = [item, ...loadRecent().filter((other) => other.id !== item.id)].slice(0, MAX_RECENT);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* Storage can be unavailable. */ }
}
