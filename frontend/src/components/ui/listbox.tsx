import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

export interface ListboxOption { value: string; label: string; description?: string | null }

/**
 * A small dark-theme dropdown for short fixed lists, used where a native
 * <select>'s option list cannot be styled consistently across browsers.
 * Keyboard: arrows, Home/End, Enter/Space to pick, Escape to close; it
 * opens upwards when there is no room below and stays on screen.
 */
export function Listbox({ value, options, onChange, label, className }: {
  value: string;
  options: ListboxOption[];
  onChange: (value: string) => void;
  label: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [up, setUp] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const current = options.find((option) => option.value === value);

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const box = button.current.getBoundingClientRect();
    setUp(window.innerHeight - box.bottom < 280 && box.top > window.innerHeight - box.bottom);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    const close = (event: PointerEvent) => {
      if (!list.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  useEffect(() => { list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active, open]);

  const show = () => { setActive(Math.max(0, options.findIndex((option) => option.value === value))); setOpen(true); };
  const pick = (index: number) => {
    const option = options[index];
    if (option) onChange(option.value);
    setOpen(false);
    button.current?.focus();
  };
  const onKey = (event: React.KeyboardEvent) => {
    const keys: Record<string, () => void> = {
      ArrowDown: () => setActive((i) => Math.min(options.length - 1, i + 1)),
      ArrowUp: () => setActive((i) => Math.max(0, i - 1)),
      Home: () => setActive(0),
      End: () => setActive(options.length - 1),
      Enter: () => pick(active),
      " ": () => pick(active),
      Escape: () => { setOpen(false); button.current?.focus(); },
      Tab: () => setOpen(false),
    };
    if (keys[event.key]) { if (event.key !== "Tab") event.preventDefault(); event.stopPropagation(); keys[event.key](); }
  };

  return (
    <div className={cn("relative min-w-0", className)}>
      <button ref={button} type="button" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={`${label}: ${current?.label ?? value}`}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(event) => { if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) { event.preventDefault(); show(); } }}
        className="flex w-full min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-left text-sm font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="truncate">{current?.label ?? value}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open && (
        <ul ref={list} id={id} role="listbox" tabIndex={-1} aria-label={label} aria-activedescendant={`${id}-${active}`} onKeyDown={onKey}
          className={cn("ops-scrollbar absolute left-0 z-50 max-h-[min(18rem,60vh)] w-64 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-xl shadow-black/50 focus:outline-none",
            up ? "bottom-full mb-1" : "top-full mt-1")}>
          {options.map((option, index) => {
            const selected = option.value === value;
            return (
              <li key={option.value} id={`${id}-${index}`} data-index={index} role="option" aria-selected={selected}
                onPointerMove={() => setActive(index)} onClick={() => pick(index)}
                className={cn("flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm",
                  selected ? "bg-primary/15 text-primary" : "text-foreground",
                  index === active && (selected ? "bg-primary/25" : "bg-accent"))}>
                <Check className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", selected ? "opacity-100" : "opacity-0")} aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block truncate">{option.label}</span>
                  {option.description && <span className="block truncate text-xs text-muted-foreground">{option.description}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
