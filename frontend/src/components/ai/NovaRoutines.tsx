import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NovaDataSources } from "@/components/ai/NovaDataSources";
import { api, type NovaRoutine, type NovaRoutineRun, type NovaRoutines as RoutinesState, type ProactiveSettings, type RoutineInput } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

const POLL_MS = 15000;
const selectClass = "rounded-md border border-input bg-secondary px-3 py-2 text-sm";
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
type Mode = "daily" | "weekdays" | "weekly" | "custom";
interface Draft { id: string | null; name: string; mode: Mode; time: string; day: number; cron: string; instruction: string; channel: RoutineInput["channel"]; enabled: boolean }

const TEMPLATES: { label: string; draft: Omit<Draft, "id"> }[] = [
  { label: "Morning brief", draft: { name: "Morning brief", mode: "daily", time: "07:00", day: 1, cron: "", channel: "web", enabled: true,
    instruction: "Give me a short morning brief: what I am working on, open threads and plans from my notes and recent journal, and anything I asked you to remind me of." } },
  { label: "Weekly summary", draft: { name: "Weekly summary", mode: "weekly", time: "18:00", day: 0, cron: "", channel: "web", enabled: true,
    instruction: "Summarize my week from the journal: what we discussed, decisions, and open threads to pick up next week." } },
];

function cronFor(d: Draft): string {
  if (d.mode === "custom") return d.cron.trim();
  const [h, m] = d.time.split(":").map((v) => Number(v));
  return `${m} ${h} * * ${d.mode === "daily" ? "*" : d.mode === "weekdays" ? "1-5" : d.day}`;
}

function parseCron(cron: string): Pick<Draft, "mode" | "time" | "day" | "cron"> {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/.exec(cron);
  if (!match) return { mode: "custom", time: "07:00", day: 1, cron };
  const time = `${match[2].padStart(2, "0")}:${match[1].padStart(2, "0")}`;
  if (match[3] === "*") return { mode: "daily", time, day: 1, cron };
  if (match[3] === "1-5") return { mode: "weekdays", time, day: 1, cron };
  return { mode: "weekly", time, day: Number(match[3]), cron };
}

export function describeSchedule(cron: string): string {
  const p = parseCron(cron);
  if (p.mode === "daily") return `Every day at ${p.time}`;
  if (p.mode === "weekdays") return `Weekdays at ${p.time}`;
  if (p.mode === "weekly") return `${DAYS[p.day]}s at ${p.time}`;
  return `Cron ${cron}`;
}

function when(iso: string | null) {
  return iso ? formatDateTime(iso) : "—";
}

function SettingsCard({ state, busy, onSave }: { state: RoutinesState; busy: boolean; onSave: (s: ProactiveSettings) => void }) {
  const [form, setForm] = useState(state.settings);
  useEffect(() => setForm(state.settings), [state.settings]);
  const changed = JSON.stringify(form) !== JSON.stringify(state.settings);
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Proactive runs</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Routines let Nova write to you on a schedule, for example a morning brief. Routine runs can read your notes and the web,
          but cannot delegate to Ops Center or change anything; Nova can only suggest what to ask for. Times use {state.timezone}.
        </p>
        {!state.memory_enabled && <p role="alert" className="text-status-warning">Memory is off, so Nova runs no routines.</p>}
        <label className="flex items-center gap-2 font-medium">
          <input type="checkbox" aria-label="Allow proactive runs" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          Allow Nova to run routines
        </label>
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1"><span className="block text-xs text-muted-foreground">Quiet hours from</span>
            <Input aria-label="Quiet hours start" type="time" className="w-32" value={form.quiet_start} onChange={(e) => setForm({ ...form, quiet_start: e.target.value })} /></label>
          <label className="space-y-1"><span className="block text-xs text-muted-foreground">to</span>
            <Input aria-label="Quiet hours end" type="time" className="w-32" value={form.quiet_end} onChange={(e) => setForm({ ...form, quiet_end: e.target.value })} /></label>
          <label className="space-y-1"><span className="block text-xs text-muted-foreground">Scheduled messages per day</span>
            <Input aria-label="Messages per day" type="number" min={1} max={20} className="w-24" value={form.max_per_day}
              onChange={(e) => setForm({ ...form, max_per_day: Number(e.target.value) })} /></label>
          <Button disabled={busy || !changed || !form.quiet_start || !form.quiet_end || !(form.max_per_day >= 1 && form.max_per_day <= 20)}
            onClick={() => onSave(form)}>Save settings</Button>
        </div>
        <p className="text-xs text-muted-foreground">Scheduled runs that fall in quiet hours or exceed the daily limit are skipped, not postponed. Run now ignores both.</p>
      </CardContent>
    </Card>
  );
}

function RoutineForm({ initial, talkRoom, busy, onSave, onCancel }: {
  initial: Draft; talkRoom: boolean; busy: boolean; onSave: (d: Draft) => void; onCancel: () => void;
}) {
  const [d, setD] = useState(initial);
  const set = (patch: Partial<Draft>) => setD({ ...d, ...patch });
  const valid = d.name.trim() && d.instruction.trim() && (d.mode === "custom" ? d.cron.trim() : d.time);
  return (
    <div className="min-w-0 space-y-3 rounded-md border border-border p-3" data-routine-form>
      <Input aria-label="Routine name" placeholder="Name" maxLength={100} value={d.name} onChange={(e) => set({ name: e.target.value })} />
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Schedule" className={selectClass} value={d.mode} onChange={(e) => set({ mode: e.target.value as Mode })}>
          <option value="daily">Every day</option>
          <option value="weekdays">Weekdays</option>
          <option value="weekly">Once a week</option>
          <option value="custom">Custom (cron)</option>
        </select>
        {d.mode === "weekly" && (
          <select aria-label="Day" className={selectClass} value={d.day} onChange={(e) => set({ day: Number(e.target.value) })}>
            {DAYS.map((name, i) => <option key={name} value={i}>{name}</option>)}
          </select>
        )}
        {d.mode === "custom"
          ? <Input aria-label="Cron schedule" className="w-48 font-mono" placeholder="0 7 * * *" value={d.cron} onChange={(e) => set({ cron: e.target.value })} />
          : <Input aria-label="Time" type="time" className="w-32" value={d.time} onChange={(e) => set({ time: e.target.value })} />}
      </div>
      <textarea aria-label="Instruction" className="min-h-24 w-full rounded-md border border-input bg-secondary p-2 text-sm" maxLength={2000}
        placeholder="What should Nova do?" value={d.instruction} onChange={(e) => set({ instruction: e.target.value })} />
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <select aria-label="Channel" className={selectClass} value={d.channel} onChange={(e) => set({ channel: e.target.value as Draft["channel"] })}>
          <option value="web">Ops Center only</option>
          <option value="talk">Talk and Ops Center</option>
        </select>
        <label className="flex items-center gap-2"><input type="checkbox" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} />Active</label>
      </div>
      {d.channel === "talk" && !talkRoom && (
        <p role="alert" className="text-xs text-status-warning">No private Talk room is routed to Nova for you yet. Runs are shown here until one is set up.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !valid} onClick={() => onSave(d)}>{d.id ? "Save routine" : "Create routine"}</Button>
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function RunRow({ run }: { run: NovaRoutineRun }) {
  const outcome = run.status === "skipped"
    ? <Badge variant="outline">Skipped: {run.reason}</Badge>
    : <Badge variant={run.task_status === "completed" ? "ok" : run.task_status === "failed" ? "critical" : run.task_status === "cancelled" ? "warning" : "outline"}>{run.task_status ?? "started"}</Badge>;
  return (
    <div className="min-w-0 space-y-1 border-b border-border py-2 text-sm last:border-0" data-run={run.id}>
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium [overflow-wrap:anywhere]">{run.routine_name}</span>
        <span className="text-muted-foreground">{when(run.due_at)}{run.manual ? " (run now)" : ""}</span>
        {outcome}
        {run.channel === "talk" && run.status === "started" && (
          run.delivered_at ? <Badge variant="ok">Sent to Talk</Badge> : run.delivery_error ? <Badge variant="warning">Not sent to Talk</Badge> : null
        )}
      </p>
      {run.delivery_error && <p className="text-xs text-muted-foreground">{run.delivery_error}</p>}
      {run.error && run.task_status !== "completed" && <p className="text-xs text-status-critical [overflow-wrap:anywhere]">{run.error}</p>}
      {run.response && (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">Message</summary>
          <p className="mt-1 whitespace-pre-wrap break-words rounded bg-accent/50 p-2">{run.response}</p>
        </details>
      )}
    </div>
  );
}

export function NovaRoutines() {
  const [state, setState] = useState<RoutinesState | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.ai.routines.list().then(setState).catch((err) => setMessage(String(err))), []);
  useEffect(() => { void load(); }, [load]);
  const active = state?.runs.some((r) => r.status === "started" && (r.task_status === "queued" || r.task_status === "running"));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  async function run(action: () => Promise<unknown>, done = "") {
    setBusy(true); setMessage("");
    try { await action(); setMessage(done); await load(); } catch (err) { setMessage(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  }
  const edit = (r: NovaRoutine) => setDraft({ id: r.id, name: r.name, ...parseCron(r.schedule), instruction: r.instruction, channel: r.channel, enabled: r.enabled });
  const save = (d: Draft) => run(async () => {
    const payload = { name: d.name.trim(), schedule: cronFor(d), instruction: d.instruction.trim(), channel: d.channel, enabled: d.enabled };
    if (d.id) await api.ai.routines.update(d.id, payload); else await api.ai.routines.create(payload);
    setDraft(null);
  }, "Routine saved.");

  if (!state) return <p className="text-sm text-muted-foreground">{message || "Loading…"}</p>;
  return (
    <div className="space-y-4">
      <SettingsCard state={state} busy={busy} onSave={(s) => void run(() => api.ai.routines.settings(s), "Settings saved.")} />
      <NovaDataSources />
      <Card>
        <CardHeader><CardTitle className="text-base">Routines</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          {state.routines.length === 0 && !draft && <p className="text-muted-foreground">No routines yet. Start from a template or create your own.</p>}
          {state.routines.map((r) => draft?.id === r.id ? (
            <RoutineForm key={r.id} initial={draft} talkRoom={state.talk_room} busy={busy} onSave={(d) => void save(d)} onCancel={() => setDraft(null)} />
          ) : (
            <div key={r.id} className={`min-w-0 space-y-1 rounded-md border border-border p-3 ${r.enabled ? "" : "opacity-60"}`} data-routine={r.name}>
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium [overflow-wrap:anywhere]">{r.name}</span>
                <Badge variant="outline">{describeSchedule(r.schedule)}</Badge>
                <Badge variant="outline">{r.channel === "talk" ? "Talk" : "Ops Center"}</Badge>
                {!r.enabled && <Badge variant="warning">paused</Badge>}
              </p>
              <p className="whitespace-pre-wrap break-words text-muted-foreground">{r.instruction}</p>
              <p className="text-xs text-muted-foreground">Next: {r.enabled && state.settings.enabled ? when(r.next_run_at) : "—"} · Last: {when(r.last_run_at)}</p>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => edit(r)}>Edit</Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => api.ai.routines.update(r.id, { enabled: !r.enabled }))}>{r.enabled ? "Pause" : "Resume"}</Button>
                <Button size="sm" variant="outline" disabled={busy || !state.settings.enabled || !state.memory_enabled}
                  onClick={() => void run(() => api.ai.routines.run(r.id), "Queued. The message appears under Recent runs.")}>Run now</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => {
                  if (window.confirm(`Delete the routine "${r.name}" and its run history?`)) await api.ai.routines.remove(r.id);
                })}>Delete</Button>
              </div>
            </div>
          ))}
          {draft && !draft.id && <RoutineForm initial={draft} talkRoom={state.talk_room} busy={busy} onSave={(d) => void save(d)} onCancel={() => setDraft(null)} />}
          {!draft && state.routines.length < state.max_routines && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setDraft({ id: null, name: "", mode: "daily", time: "07:00", day: 1, cron: "", instruction: "", channel: "web", enabled: true })}>New routine</Button>
              {TEMPLATES.map((t) => <Button key={t.label} size="sm" variant="outline" onClick={() => setDraft({ id: null, ...t.draft })}>Add {t.label.toLowerCase()}</Button>)}
            </div>
          )}
          {message && <p role="status" className="text-muted-foreground">{message}</p>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Recent runs</CardTitle></CardHeader>
        <CardContent>
          {state.runs.length === 0 ? <p className="text-sm text-muted-foreground">No runs yet.</p> : state.runs.map((r) => <RunRow key={r.id} run={r} />)}
        </CardContent>
      </Card>
    </div>
  );
}
