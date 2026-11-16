import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface OverflowItem {
  label: string;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

/** Keeps rare or risky actions one step away from the everyday buttons. */
export function OverflowMenu({ label, items }: { label: string; items: OverflowItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const menuItems = () => [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    menuItems()[0]?.focus();
    function outside(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function keys(event: KeyboardEvent) {
      const all = menuItems();
      const index = all.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape") { event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
      else if (event.key === "Tab") setOpen(false);
      else if (event.key === "ArrowDown" && all.length) { event.preventDefault(); all[(index + 1) % all.length].focus(); }
      else if (event.key === "ArrowUp" && all.length) { event.preventDefault(); all[(index - 1 + all.length) % all.length].focus(); }
    }
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", keys);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", keys);
    };
  }, [open]);

  return (
    <div ref={root} className="relative inline-block">
      <Button ref={trigger} type="button" variant="outline" size="icon" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </Button>
      {open && (
        <div role="menu" aria-label={label} className="absolute right-0 z-20 mt-1 min-w-40 rounded-md border border-border bg-card p-1 shadow-lg">
          {items.map((item) => (
            <button key={item.label} type="button" role="menuitem" disabled={item.disabled}
              onClick={() => { setOpen(false); item.onSelect(); }}
              className={cn("block min-h-9 w-full rounded px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:opacity-50", item.destructive && "text-status-critical")}>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
