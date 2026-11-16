import { useEffect, useState } from "react";
import { useReauth } from "@/components/ReauthDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, type AIWeeklyBudget } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
export function WeeklyBudgetCard() {
  const [budget, setBudget] = useState<AIWeeklyBudget | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const { hasRole } = useAuth();
  const withReauth = useReauth();
  const draft = Number(editing);
  const draftValid = editing !== null && editing.trim() !== "" && Number.isFinite(draft) && draft >= 1 && draft <= 1000;

  async function saveLimit() {
    if (!draftValid) return;
    setSaving(true); setSaveError("");
    try { setBudget(await withReauth(() => api.ai.setBudgetLimit(Math.round(draft * 100) / 100))); setEditing(null); }
    catch (e) { setSaveError(e instanceof Error ? e.message : "Could not save the limit"); }
    finally { setSaving(false); }
  }

  useEffect(() => {
    let live = true, pending = false;
    async function refresh() {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try { const value = await api.ai.budget(); if (live) { setBudget(value); setError(""); } }
      catch { if (live) { setBudget(null); setError("Weekly budget status is unavailable. The server still enforces the spending limit."); } }
      finally { pending = false; }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    const onVisibility = () => { if (document.visibilityState !== "hidden") void refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { live = false; clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, []);
  return <Card><CardContent className="space-y-3 pt-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Weekly AI budget</h2>
      {budget && hasRole("admin") && editing === null && <Button size="sm" variant="outline" onClick={() => { setEditing(String(budget.limit_usd)); setSaveError(""); }}>Change limit</Button>}
    </div>
    {budget && editing !== null && <form className="flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); void saveLimit(); }}>
      <label className="space-y-1 text-xs text-muted-foreground">Weekly limit (USD)
        <Input aria-label="Weekly limit (USD)" type="number" inputMode="decimal" min={1} max={1000} step={1} value={editing} autoFocus
          onChange={e => setEditing(e.target.value)} className="w-32" />
      </label>
      <Button size="sm" type="submit" disabled={saving || !draftValid}>Save</Button>
      <Button size="sm" type="button" variant="ghost" disabled={saving} onClick={() => setEditing(null)}>Cancel</Button>
      <p className="w-full text-xs text-muted-foreground">Between $1 and $1,000. Applies to the next paid model call, needs your password, and the warning moves to 80% of the new limit.</p>
      {saveError && <p role="alert" className="w-full text-xs text-destructive">{saveError}</p>}
    </form>}
    {error && <p role="status" className="text-sm text-amber-400">{error}</p>}
    {!budget && !error && <p className="text-sm text-muted-foreground">Loading shared spending…</p>}
    {budget && <>
      <p className="text-sm text-muted-foreground">{money(budget.limit_usd)} per week, shared by all agents, conversations and automatic incident investigations.</p>
      <dl className="grid grid-cols-2 gap-3 text-sm lg:grid-cols-4">
        {[["Reported usage estimate", money(budget.billed_usd)], ["Reserved", money(budget.reserved_usd)], ["Remaining", money(budget.remaining_usd)], ["Weekly limit", money(budget.limit_usd)]].map(([name, value]) => <div key={name} className="rounded-md bg-secondary p-3"><dt className="text-xs text-muted-foreground">{name}</dt><dd className="mt-1 font-semibold">{value}</dd></div>)}
      </dl>
      <progress className="h-2 w-full" aria-label="Weekly AI budget committed" max={budget.limit_usd || 1} value={Math.min(budget.billed_usd + budget.reserved_usd, budget.limit_usd)}/>
      {(budget.pricing_unknown ?? 0) > 0 ? <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">AI spending is paused because some model usage has no verified price. An administrator must resolve the pricing before new model calls can start.</p> : budget.exhausted ? <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">Weekly AI budget exhausted. New model calls are paused until the budget resets.</p> : budget.warning && <p role="alert" className="rounded-md border border-amber-400/40 p-3 text-sm text-amber-400">Weekly AI budget is running low. {money(budget.remaining_usd)} remains, including current reservations.</p>}
      <p className="text-xs text-muted-foreground">Warning at {money(budget.warning_usd)} used or reserved. Resets {new Date(budget.reset_at).toLocaleString("en-GB", { timeZone: "UTC", timeZoneName: "short" })} (Monday UTC).</p>
      <p className="text-xs text-muted-foreground">Reported usage is priced from provider token counts. Reservations cover work in progress and uncertain outcomes; these amounts are not a provider invoice.</p>
    </>}
  </CardContent></Card>;
}
