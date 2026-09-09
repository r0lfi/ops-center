import { useState, type ReactNode } from "react";
import { Activity, Bot, ClipboardList, Container, FileSearch, GitBranch, MessageSquare, Network, PackageCheck, Pause, Play, ShieldCheck, Square, Terminal, Workflow } from "lucide-react";
import { Link } from "react-router-dom";

import { api, type AIAgent, type AIProvider, type AITask } from "@/lib/api";
import { STATE_COLOR, STATE_LABEL, type AgentVisual } from "@/lib/opsFloorTypes";

import { useAuth } from "@/lib/auth";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tux } from "./Tux";

interface OpsFloorAgentPanelProps {
  task: AITask | null;
  onStop: () => void;
  stopping: boolean;
  agent: AgentVisual | null;
  detail: AIAgent | null;
  providers: AIProvider[];
  pendingApprovals: number;
  onTogglePause: (agent: AIAgent) => void;
  pausing: boolean;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[70px_1fr] items-start gap-2">
      <div style={{ fontSize: 11, color: "#8799AD" }}>{label}</div>
      <div className="mt-0.5" style={{ fontSize: 13, color: "#D7E2ED" }}>
        {children}
      </div>
    </div>
  );
}

function StatusBadge({ state }: { state: AgentVisual["state"] }) {
  const color = STATE_COLOR[state];
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5"
      style={{ background: `${color}1F`, border: `1px solid ${color}73`, color, fontSize: 11, fontWeight: 600 }}
    >
      {STATE_LABEL[state]}
    </span>
  );
}

const IDENTITY: Record<string, { icon: typeof Bot; color: string; description: string; badges: string[] }> = {
  linux: { icon: Terminal, color: "#00D9FF", description: "Linux host operations, shell diagnostics and service health.", badges: ["Red Hat", "AlmaLinux", "Ubuntu", "systemctl", "shell", "SSH"] },
  container: { icon: Container, color: "#22E6A3", description: "Container lifecycle, Compose services and runtime health.", badges: ["Docker", "Podman", "Compose", "Kubernetes"] },
  monitoring: { icon: Activity, color: "#4DB2FF", description: "Metrics, alerts and time-series health across the fleet.", badges: ["Prometheus", "Grafana", "Alertmanager"] },
  network: { icon: Network, color: "#47E5FF", description: "Network topology, routes, interfaces and connectivity.", badges: ["DNS", "Firewall", "Routing", "Interfaces"] },
  security: { icon: ShieldCheck, color: "#FF4D67", description: "Vulnerability findings, hardening checks and audit posture.", badges: ["CVE", "Vulnerability scan", "Hardening", "Audit"] },
  patching: { icon: PackageCheck, color: "#FFC247", description: "Package updates, maintenance windows and reboot readiness.", badges: ["Updates", "Patching", "Reboot required"] },
  automation: { icon: Workflow, color: "#A873FF", description: "Playbooks, workflows and repeatable infrastructure jobs.", badges: ["Ansible", "Automation", "Jobs", "Pipelines"] },
  chat: { icon: MessageSquare, color: "#F05CFF", description: "Conversation intake, assistant replies and operator context.", badges: ["Message", "Assistant", "Conversation"] },
  general: { icon: FileSearch, color: "#FF7A1A", description: "Documentation, search and cross-system task summaries.", badges: ["Docs", "Search", "Tasks"] },
  coordinator: { icon: GitBranch, color: "#00D9FF", description: "Central orchestration, routing and specialist delegation.", badges: ["Routing", "Orchestration", "Task delegation"] },
};

function IdentityMark({ slug, color }: { slug: string; color: string }) {
  const item = IDENTITY[slug] ?? { icon: Bot, color, description: "AI operations specialist.", badges: [] };
  const Icon = item.icon;
  if (slug === "linux") return <div className="ops-agent-identity ops-agent-identity-linux"><Tux /><span>LINUX</span></div>;
  return <div className="ops-agent-identity" style={{ borderColor: `${item.color}66`, color: item.color, background: `${item.color}12` }}><Icon size={28} strokeWidth={1.7} /><span>{slug === "container" ? "DOCKER" : slug.toUpperCase()}</span></div>;
}

function ServiceBadges({ slug, color }: { slug: string; color: string }) {
  const item = IDENTITY[slug] ?? { badges: [] };
  return <div className="ops-service-badges">{item.badges.map((badge) => <span key={badge} style={{ borderColor: `${color}66`, color }}>{badge}</span>)}</div>;
}

function ActionButton({ tone, onClick, disabled, href, children }: { tone: "primary" | "secondary" | "danger"; onClick?: () => void; disabled?: boolean; href?: string; children: ReactNode }) {
  const styles = {
    primary: { background: "#10273A", border: "1px solid #00AEE8", color: "#74DCFF" },
    secondary: { background: "#111B29", border: "1px solid #294158", color: "#D5DFE8" },
    danger: { background: "rgba(255,77,103,0.10)", border: "1px solid #B83249", color: "#FF6378" },
  }[tone];
  const cls = "flex w-full items-center justify-center gap-1.5 rounded-md transition-opacity disabled:opacity-50";
  const style = { ...styles, height: 34, fontSize: 12, fontWeight: 600 };
  if (href) {
    return (
      <Link to={href} className={cls} style={style}>
        {children}
      </Link>
    );
  }
  return (
    <button type="button" className={cls} style={style} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

/**
 * The persistent right-docked "Agent Details" panel for the full-page Ops
 * Floor (see OpsFloor.tsx) - richer than the floating AgentPanel used on
 * the AI dashboard card, but built from the same real data: the live SSE
 * status (`agent`) joined with the agent's actual config row (`detail`).
 * Every field is either live data or omitted - no fabricated fields
 * (progress %, host, etc.) for data the backend doesn't actually track.
 */
export function OpsFloorAgentPanel({ task, onStop, stopping, agent, detail, providers, pendingApprovals, onTogglePause, pausing }: OpsFloorAgentPanelProps) {
  const { hasRole } = useAuth();
  const [taskOpen, setTaskOpen] = useState(false);
  const [inlineMessage, setInlineMessage] = useState("");
  const [inlineReply, setInlineReply] = useState<string | null>(null);
  const [inlineBusy, setInlineBusy] = useState(false);
  const cardStyle = { background: "#0B121C", border: "1px solid #1C2D40", borderRadius: 8 };

  if (!agent) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center" style={cardStyle}>
        <p style={{ fontSize: 15, fontWeight: 650, color: "#F3F7FB" }}>Agent Details</p>
        <p style={{ fontSize: 13, color: "#8799AD" }}>Click an agent on the floor to see its status, current task and tools.</p>
      </div>
    );
  }

  const providerName = detail?.provider_id ? providers.find((p) => p.id === detail.provider_id)?.display_name : null;
  const currentTask = task?.status === "cancelled" ? "Stop requested. Finishing the current step." : detail?.current_task ?? (agent.state !== "idle" ? agent.activity : null);
  const host = agent.target ?? detail?.allowed_hosts?.[0];
  const offline = agent.offline || detail?.enabled === false;
  const identity = IDENTITY[agent.slug] ?? IDENTITY.general;

  async function sendInlineMessage() {
    const message = inlineMessage.trim();
    if (!message || inlineBusy || offline || !agent) return;
    const selectedAgent = agent;
    setInlineMessage("");
    setInlineReply(null);
    setInlineBusy(true);
    try {
      const keyName = `ops_chat_conversation:${selectedAgent.slug}`;
      const conversationKey = localStorage.getItem(keyName) ?? `web:${selectedAgent.slug}:${crypto.randomUUID()}`;
      localStorage.setItem(keyName, conversationKey);
      const created = await api.ai.ask(message, selectedAgent.slug, conversationKey);
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const updated = await api.ai.tasks.get(created.id);
        if (["completed", "failed", "cancelled"].includes(updated.status)) {
          setInlineReply(updated.response_message || updated.error_message || "Task cancelled.");
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }
    } catch {
      setInlineReply("Could not reach this agent. Open chat for the full conversation.");
    } finally {
      setInlineBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden" style={cardStyle}>
      <div className="flex items-center justify-between gap-2 p-3.5" style={{ borderBottom: "1px solid #152536" }}>
        <p style={{ fontSize: 15, fontWeight: 650, color: "#F3F7FB" }}>Agent Details</p>
        {pendingApprovals > 0 && (
          <Link to="/ai-agents/approvals" style={{ fontSize: 11, fontWeight: 600, color: "#FFC247" }}>
            {pendingApprovals} pending
          </Link>
        )}
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3.5">
        <div className="flex items-center gap-2.5">
          <IdentityMark slug={agent.slug} color={identity.color} />
          <div className="min-w-0">
            <div className="truncate" style={{ fontSize: 14, fontWeight: 700, color: "#F3F7FB" }}>
              {agent.name}
            </div>
            {offline ? <span style={{color:"#586A7D",fontSize:11}}>Offline</span> : <StatusBadge state={agent.state} />}
          </div>
        </div>

        <p style={{fontSize:12,color:"#8799AD",lineHeight:1.6}}>{detail?.description ?? identity.description}</p>
        <ServiceBadges slug={agent.slug} color={identity.color} />

        <div className="ops-inline-chat">
          <label htmlFor="ops-inline-message">Message {agent.name}</label>
          <textarea id="ops-inline-message" value={inlineMessage} onChange={(event) => setInlineMessage(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendInlineMessage(); } }}
            placeholder={`Ask ${agent.name} to handle a small job…`} disabled={inlineBusy || offline} rows={2} />
          <div className="flex items-center justify-between gap-2">
            {inlineReply ? <p className="ops-inline-reply">{inlineReply}</p> : <span className="ops-inline-hint">Enter to send · Shift+Enter for a new line</span>}
            <button type="button" onClick={() => void sendInlineMessage()} disabled={inlineBusy || !inlineMessage.trim() || offline}>
              <MessageSquare className="h-3.5 w-3.5" /> {inlineBusy ? "Working…" : "Send"}
            </button>
          </div>
        </div>

        <div>
          <p style={{ fontSize:11,color:"#8799AD",marginBottom:6 }}>Current Task</p>
          <div style={{ background:"#090E17",border:"1px solid #1C2D40",borderRadius:7,padding:10 }}>
            <p style={{ fontSize:12,color:"#C4D0DD" }}>{offline ? "Agent offline" : currentTask ?? "Ready for the next task"}</p>
            {currentTask && !offline && <div role="progressbar" aria-label="Task in progress" className="ops-task-progress"><span /></div>}
          </div>
        </div>

        {detail?.error_message && (
          <div>
            <div style={{ fontSize: 11, color: "#FF4D67" }}>Error</div>
            <div className="mt-0.5" style={{ fontSize: 13, color: "#FF4D67" }}>
              {detail.error_message}
            </div>
          </div>
        )}

        <Field label="Model">{detail?.model ?? "Not configured"}</Field>
        <Field label="Provider">{providerName ?? "Not configured"}</Field>

        {host && <Field label="Host">{host}</Field>}

        {detail && detail.allowed_tools.length > 0 && (
          <div>
            <div style={{ fontSize: 11, color: "#8799AD" }}>Tools</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {detail.allowed_tools.map((tool) => (
                <span
                  key={tool}
                  className="rounded font-mono"
                  style={{ background: "#152235", border: "1px solid #284057", color: "#BED0E1", fontSize: 10, padding: "2px 6px", borderRadius: 5 }}
                >
                  {tool}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <Dialog open={taskOpen} onOpenChange={setTaskOpen}>
        <DialogContent><DialogHeader><DialogTitle>Current Task</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">{task?.status}</p>
          <p className="whitespace-pre-wrap text-sm">{task?.input_message}</p>
          {task?.response_message && <p className="max-h-80 overflow-auto whitespace-pre-wrap text-sm">{task.response_message}</p>}
        </DialogContent>
      </Dialog>
      <div className="grid grid-cols-3 gap-1.5 p-3.5" style={{ borderTop: "1px solid #152536" }}>
        <ActionButton tone="primary" href={`/ai-agents/chat?agent=${agent.slug}&from=ops-floor`}>
          <MessageSquare className="h-3.5 w-3.5" />
          Open chat
        </ActionButton>
        <ActionButton tone="secondary" onClick={() => setTaskOpen(true)} disabled={!task}>
          <ClipboardList className="h-3.5 w-3.5" />
          View task
        </ActionButton>
        <ActionButton tone="danger" onClick={onStop} disabled={!hasRole("operator") || stopping || !task || !["queued", "running"].includes(task.status)}>
          <Square className="h-3.5 w-3.5" /> Stop task
        </ActionButton>
        {detail && hasRole("admin") && <button className="col-span-3 pt-1 text-left text-[11px] text-[#8799AD] hover:text-[#C4D0DD]" disabled={pausing} onClick={() => onTogglePause(detail)}>
          {detail.enabled ? <Pause className="mr-1 inline h-3 w-3" /> : <Play className="mr-1 inline h-3 w-3" />}
          {detail.enabled ? "Pause agent" : "Resume agent"}
        </button>}
      </div>
    </div>
  );
}
