import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface SearchComboboxItem {
  id: string;
  label: string;
  sublabel?: string;
}

/**
 * Type-to-filter search box, not a fixed dropdown - meant for lists that
 * can grow past what's comfortable to scroll through in a plain <select>
 * (e.g. every server or every container in the homelab). Filters
 * client-side against an already-fetched item list; callers own fetching.
 */
export function SearchCombobox({
  items,
  selectedId,
  onSelect,
  placeholder,
}: {
  items: SearchComboboxItem[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  placeholder: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = items.find((i) => i.id === selectedId) ?? null;
  const matches = query.trim()
    ? items.filter(
        (i) =>
          i.label.toLowerCase().includes(query.trim().toLowerCase()) ||
          i.sublabel?.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : items;

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  if (selected && !open) {
    return (
      <div className="flex w-64 items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm">
        <span className="flex-1 truncate font-medium">{selected.label}</span>
        <button
          onClick={() => {
            onSelect(null);
            setQuery("");
          }}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative w-64">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        className="pl-8"
      />
      {open && matches.length > 0 && (
        <div className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-border bg-card shadow-md">
          {matches.slice(0, 50).map((item) => (
            <button
              key={item.id}
              onClick={() => {
                onSelect(item.id);
                setQuery("");
                setOpen(false);
              }}
              className={cn(
                "flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-accent",
                item.id === selectedId && "bg-accent",
              )}
            >
              <span className="font-medium">{item.label}</span>
              {item.sublabel && <span className="text-xs text-muted-foreground">{item.sublabel}</span>}
            </button>
          ))}
        </div>
      )}
      {open && query.trim() && matches.length === 0 && (
        <div className="absolute z-10 mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground shadow-md">
          No matches
        </div>
      )}
    </div>
  );
}
