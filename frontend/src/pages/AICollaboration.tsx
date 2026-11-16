import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowUpRight, Plus, Settings2, PanelLeft, Square, Network, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AgentFloor } from "@/components/collaboration/AgentFloor";
import { BudgetWidget, EvidencePanel, InvestigationState, InvestigationTimeline, ResolutionPanel, SharedExperiencePanel } from "@/components/collaboration/InvestigationPanels";
import { InvestigationHeader, InvestigationProgress, InvestigationSidebar } from "@/components/collaboration/InvestigationNavigation";
import { NewInvestigationDialog } from "@/components/collaboration/NewInvestigationDialog";
import { useCollaborationWorkspace } from "@/components/collaboration/useCollaborationWorkspace";
import { isActive } from "@/components/collaboration/workspace";
import "@/components/collaboration/workspace.css";
import { formatNumber } from "@/lib/format";

const tabs = ["Overview", "Timeline", "Evidence", "Shared experience"] as const;
type Tab = typeof tabs[number];
export default function AICollaboration() {
  return <CollaborationWorkspace />;
}
function CollaborationWorkspace() {
  const [params, setParams] = useSearchParams();
  const selected = params.get("board") || "";
  const [offset, setOffset] = useState(0), [query, setQuery] = useState(""), [refresh, setRefresh] = useState(0);
  const [tab, setTab] = useState<Tab>("Overview"), [newOpen, setNewOpen] = useState(false), [listOpen, setListOpen] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const data = useCollaborationWorkspace(selected, offset, query, refresh, tab === "Shared experience");
  const { settings, agents, boards, detail, experiences } = data;
  function select(id: string) {
    setParams(current => { const next = new URLSearchParams(current); next.set("board", id); return next; });
    setListOpen(false); setTab("Overview"); setError(""); setNotice("");
  }
  useEffect(() => { setTab("Overview"); }, [selected]);
  useEffect(() => {
    if (!selected && boards.length) setParams(current => {
      if (current.get("board")) return current;
      const next = new URLSearchParams(current); next.set("board", boards[0].board.task_id); return next;
    }, { replace: true });
  }, [selected, boards, setParams]);
  const canStart = !!settings?.policy.enabled && agents.some(agent => agent.enabled && settings.policy.agents[agent.slug]?.read);
  const openNew = () => { setListOpen(false); setError(""); setNewOpen(true); };
  async function start(message: string, lead: string) {
    setBusy(true); setError(""); setNotice("");
    try { const result = await api.ai.collaboration.start(message, lead); select(result.task_id); setOffset(0); setRefresh(value => value + 1); setNotice("Investigation queued. Agent contributions will appear here."); return true; }
    catch (reason) { setError(String(reason)); return false; }
    finally { setBusy(false); }
  }
  async function stop() {
    setBusy(true); setError("");
    try { await api.ai.collaboration.stop(selected); setRefresh(value => value + 1); setNotice("Stop requested. In-flight work may finish; no further work will start."); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  const sidebar = <InvestigationSidebar boards={boards} agents={agents} selected={selected} onSelect={select} onNew={openNew} offset={offset} onOffset={setOffset} error={data.listError} canStart={canStart && !busy}/>;
  return <section className="collaboration-workspace" aria-label="Agent collaboration workspace">
    <header className="flex flex-wrap items-center gap-4 rounded-t-xl border border-white/[0.07] bg-[#10151e] px-4 py-4 sm:px-5">
      <Link to="/ai-agents" className="flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><ArrowLeft className="h-3 w-3" aria-hidden="true" />AI overview</Link>
      {detail ? <InvestigationHeader detail={detail} agents={agents} updatedAt={data.updatedAt} /> : <div className="flex-1"><p className="mb-1 text-[10px] uppercase tracking-[0.2em] text-cyan-400">Ops Center / Agent operations</p><h1 className="text-xl font-semibold">Collaboration workspace</h1><p className="mt-1 text-xs text-muted-foreground">One investigation. A team of specialists.</p></div>}
      <div className="flex items-center gap-1.5">
        <Button className="collaboration-list-toggle" size="sm" variant="outline" aria-label="Browse investigations" onClick={() => setListOpen(true)}><PanelLeft className="h-4 w-4" /><span className="hidden sm:inline">Investigations</span></Button>
        <Button size="sm" variant="outline" disabled={!canStart || busy} onClick={openNew} aria-label="New investigation"><Plus className="h-4 w-4" /><span className="hidden sm:inline">New</span></Button>
        <Button asChild size="sm" variant="ghost"><Link to="/settings?tab=collaboration" aria-label="Collaboration settings"><Settings2 className="h-4 w-4" /></Link></Button>
      </div>
    </header>
    {data.configError && <p role="alert" className="border-x border-white/5 bg-red-500/5 px-4 py-3 text-sm text-red-400">Collaboration settings unavailable: {data.configError}</p>}
    {settings && !settings.policy.enabled && <p role="status" className="border-x border-white/5 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">Collaboration is disabled. Existing investigations remain available. Enable it in Settings to start a new investigation.</p>}
    {error && !newOpen && <p role="alert" className="border-x border-white/5 px-4 py-3 text-sm text-red-400">{error}</p>}
    {notice && <p role="status" className="border-x border-white/5 bg-cyan-500/5 px-4 py-2 text-xs text-cyan-200">{notice}</p>}
    <div className="collaboration-columns">
      <aside className="collaboration-investigations">{sidebar}</aside>
      <div className="collaboration-center min-w-0">
        {data.detailError ? <div role="alert" className="m-5 space-y-3 rounded-lg bg-red-400/5 p-5 text-sm text-red-400"><p>Investigation unavailable: {data.detailError}</p><Button variant="outline" onClick={() => setRefresh(value => value + 1)}><RefreshCw className="h-3.5 w-3.5" />Retry</Button></div> : !detail ? <div className="flex min-h-[460px] flex-col items-center justify-center gap-4 p-8 text-center"><Network className="h-10 w-10 text-cyan-400/60" /><h2 className="text-lg font-medium">{selected ? "Loading investigation…" : "Bring the specialists together"}</h2><p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{selected ? "Retrieving the investigation and its recorded activity." : "Start with a problem. Follow agent questions, findings and the final conclusion in one workspace."}</p>{!selected && <Button disabled={!canStart} onClick={openNew}><Plus className="h-4 w-4" />New investigation</Button>}</div> : <>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] px-3 pt-2">
            <div role="tablist" aria-label="Investigation views" className="flex min-w-0 flex-wrap gap-1">{tabs.map(value => <button key={value} id={"tab-" + value.replaceAll(" ", "-")} type="button" role="tab" aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} aria-controls="investigation-view" onKeyDown={event => { const index = tabs.indexOf(value); const target = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null; if (target !== null) { event.preventDefault(); setTab(tabs[target]); document.getElementById("tab-" + tabs[target].replaceAll(" ", "-"))?.focus(); } }} onClick={() => setTab(value)} className={"border-b-2 px-2.5 py-3 text-xs transition-colors " + (tab === value ? "border-cyan-400 text-cyan-300" : "border-transparent text-muted-foreground hover:text-slate-100")}>{value}</button>)}</div>
            {isActive(detail) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void stop()} className="mb-1 text-[11px] text-muted-foreground"><Square className="h-3 w-3" />Stop investigation</Button>}
          </div>
          <div id="investigation-view" role="tabpanel" aria-labelledby={"tab-" + tab.replaceAll(" ", "-")} className="min-w-0 space-y-4 p-3 sm:p-4">
            {tab === "Overview" && <>
              <AgentFloor detail={detail} agents={agents} />
              <InvestigationProgress detail={detail} />
              {detail.board.stop_reason && <p role="status" className="rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-xs text-amber-200">{detail.board.stop_reason}</p>}
              <ResolutionPanel detail={detail} agents={agents} />
              <div className="flex items-center justify-between"><h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Activity</h2><button className="flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-200" onClick={() => setTab("Timeline")}>Full timeline<ArrowUpRight className="h-3 w-3" /></button></div>
              <InvestigationTimeline detail={detail} agents={agents} compact />
            </>}
            {tab === "Timeline" && <InvestigationTimeline detail={detail} agents={agents} />}
            {tab === "Evidence" && <EvidencePanel detail={detail} agents={agents} />}
            {tab === "Shared experience" && <SharedExperiencePanel experiences={experiences} query={query} onQueryChange={setQuery} error={data.experienceError} agents={agents} />}
            <details className="rounded-lg border border-white/5 p-3 text-xs text-muted-foreground"><summary className="cursor-pointer">Investigation details &amp; run safety</summary><div className="mt-3 space-y-3">
              <p className="font-mono text-[10px] break-all">{detail.board.task_id}</p>
              <h3 className="font-medium text-slate-300">Original problem</h3><p className="whitespace-pre-wrap break-words">{detail.question}</p>
              <dl className="grid grid-cols-2 gap-3"><div><dt>Safety token allowance</dt><dd>{formatNumber(detail.board.charged_tokens)} / {formatNumber(detail.board.policy.max_tokens)}</dd></div><div><dt>Reported token usage</dt><dd>{formatNumber(detail.board.actual_tokens)}</dd></div><div><dt>Model calls</dt><dd>{detail.board.model_calls} / {detail.board.policy.max_model_calls}</dd></div><div><dt>Board / task status</dt><dd>{detail.board.status} / {detail.task_status}</dd></div></dl>
              <p>Agent observations and hypotheses do not authorize operational changes.</p>
            </div></details>
          </div>
        </>}
      </div>
      <aside className="collaboration-state min-w-0 space-y-4 p-4"><BudgetWidget />{detail && <InvestigationState detail={detail} agents={agents} />}</aside>
    </div>
    <Dialog open={listOpen} onOpenChange={setListOpen}><DialogContent className="max-w-sm p-0"><DialogHeader className="px-4 pt-5"><DialogTitle>Investigations</DialogTitle><DialogDescription>Select an investigation or start a new one.</DialogDescription></DialogHeader>{sidebar}</DialogContent></Dialog>
    <NewInvestigationDialog open={newOpen} onOpenChange={setNewOpen} agents={agents} settings={settings} busy={busy} onStart={start} error={error} />
  </section>;
}
