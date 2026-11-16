import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowRight, ChevronRight, GitBranch, MessageSquare } from "lucide-react";
import type { AIAgent, CollaborationDetail, CollaborationPost } from "@/lib/api";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AgentBadge, agentColor, agentLabel } from "./identity";
import { formatDateTime } from "@/lib/format";

type Point = { x: number; y: number };
type Connection = { from: string; to: string; post: CollaborationPost; question: CollaborationPost; kind: "question" | "answer"; count: number };
type Selection = { kind: "agent"; slug: string } | { kind: "exchange"; questionId: string } | null;
const CARD_HEIGHT = 132;
const LABELS: Record<string, string> = { question: "Question", answer: "Reply", evidence: "Finding", hypothesis: "Hypothesis", experience: "Experience", summary: "Summary", system: "Update" };
const label = (kind: string) => LABELS[kind] || kind.replaceAll("_", " ");
const brief = (content: string, maximum = 100) => {
  const text = content.replace(/\s+/g, " ").trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1).trimEnd()}…` : text;
};
const latest = (posts: CollaborationPost[]) => posts[posts.length - 1];

function graphLayout(slugs: string[], lead: string, questions: CollaborationPost[], width: number) {
  const columns = width >= 540 ? 3 : width >= 310 ? 2 : 1;
  const cardWidth = Math.max(112, Math.min(168, (width - 36 - 14 * (columns - 1)) / columns));
  const depths = new Map<string, number>([[lead, 0]]);
  const queue = [lead];
  while (queue.length) {
    const from = queue.shift()!;
    for (const question of questions.filter(post => post.agent === from && post.recipient)) {
      if (!depths.has(question.recipient!)) {
        depths.set(question.recipient!, (depths.get(from) || 0) + 1);
        queue.push(question.recipient!);
      }
    }
  }
  const groups = new Map<number, string[]>();
  for (const slug of slugs.filter(item => item !== lead)) {
    const depth = depths.get(slug) || 1;
    groups.set(depth, [...(groups.get(depth) || []), slug]);
  }
  const rows: string[][] = lead ? [[lead]] : [];
  for (const [, group] of [...groups.entries()].sort(([a], [b]) => a - b)) {
    for (let index = 0; index < group.length; index += columns) rows.push(group.slice(index, index + columns));
  }
  const height = Math.max(352, rows.length * 160 + 32);
  const positions: Record<string, Point> = {};
  rows.forEach((row, rowIndex) => {
    const occupied = row.length * cardWidth + (row.length - 1) * 18;
    const start = (width - occupied) / 2 + cardWidth / 2;
    row.forEach((slug, index) => { positions[slug] = { x: start + index * (cardWidth + 18), y: rows.length === 1 ? height / 2 : 86 + rowIndex * (height - 172) / (rows.length - 1) }; });
  });
  return { positions, cardWidth, height };
}

function connectionPath(from: Point, to: Point, cardWidth: number, kind: Connection["kind"]) {
  const offset = kind === "answer" ? 5 : -5;
  if (Math.abs(to.y - from.y) > CARD_HEIGHT / 2) {
    const direction = Math.sign(to.y - from.y);
    const x1 = from.x + offset, x2 = to.x + offset;
    const y1 = from.y + direction * (CARD_HEIGHT / 2 + 2);
    const y2 = to.y - direction * (CARD_HEIGHT / 2 + 9);
    const middle = (y1 + y2) / 2;
    return `M ${x1} ${y1} C ${x1} ${middle}, ${x2} ${middle}, ${x2} ${y2}`;
  }
  const direction = Math.sign(to.x - from.x) || 1;
  const x1 = from.x + direction * (cardWidth / 2 + 2), x2 = to.x - direction * (cardWidth / 2 + 9);
  const y1 = from.y + offset, y2 = to.y + offset;
  return `M ${x1} ${y1} C ${x1 + direction * 26} ${y1 - 38}, ${x2 - direction * 26} ${y2 - 38}, ${x2} ${y2}`;
}

function stateFor(slug: string, detail: CollaborationDetail, posts: CollaborationPost[], questions: CollaborationPost[], replies: Set<string>) {
  if (detail.board.status === "completed" && detail.task_status === "completed") return { text: "Completed", tone: "complete" };
  const open = ["queued", "running"].includes(detail.board.status) && ["queued", "running"].includes(detail.task_status);
  if (questions.some(post => post.agent === slug && !replies.has(post.id))) return { text: open ? "Waiting for reply" : "Question unanswered", tone: "waiting" };
  if (questions.some(post => post.recipient === slug && !replies.has(post.id))) return { text: open ? "Response requested" : "No reply recorded", tone: "waiting" };
  const last = latest(posts.filter(post => post.agent === slug));
  if (last?.kind === "answer") return { text: "Responded", tone: "complete" };
  if (last?.kind === "evidence") return { text: "Finding shared", tone: "complete" };
  if (last?.kind === "experience") return { text: "Experience shared", tone: "complete" };
  if (last?.kind === "hypothesis") return { text: "Hypothesis shared", tone: "neutral" };
  if (last?.kind === "summary") return { text: "Summary shared", tone: "complete" };
  if (last?.kind === "question" && replies.has(last.id)) return { text: "Answer received", tone: "complete" };
  if (detail.board.status === "failed" || detail.task_status === "failed") return { text: "Investigation failed", tone: "error" };
  if (detail.board.status === "stopped" || detail.task_status === "cancelled") return { text: "Investigation stopped", tone: "neutral" };
  return { text: detail.board.status === "queued" ? "Queued" : "No contribution yet", tone: "neutral" };
}

/** Board-scoped communication map. Global agent health is deliberately not used. */
export function AgentFloor({ detail, agents }: { detail: CollaborationDetail; agents: AIAgent[] }) {
  const mapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(580);
  const [selection, setSelection] = useState<Selection>(null);
  const [highlightUntil, setHighlightUntil] = useState<Record<string, number>>({});
  const [now, setNow] = useState(Date.now());
  const seen = useRef<{ taskId: string; ids: Set<string> } | null>(null);
  const markerId = useId().replace(/:/g, "");
  const live = detail.board.status === "running" && detail.task_status === "running";
  const posts = useMemo(() => [...detail.posts].sort((a, b) => a.sequence - b.sequence), [detail.posts]);
  const lead = detail.lead_agent || detail.board.participants[0] || posts[0]?.agent || "";
  const slugs = [...new Set([lead, ...detail.board.participants, ...posts.flatMap(post => [post.agent, ...(post.recipient ? [post.recipient] : [])])].filter(Boolean))];
  const questions = posts.filter(post => post.kind === "question" && post.recipient);
  const replies = new Set(posts.filter(post => post.kind === "answer" && post.reply_to_id).map(post => post.reply_to_id!));
  const { positions, cardWidth, height } = graphLayout(slugs, lead, questions, width);

  useEffect(() => {
    if (!mapRef.current) return;
    const observer = new ResizeObserver(entries => { const value = entries[0]?.contentRect.width; if (value) setWidth(value); });
    observer.observe(mapRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!seen.current || seen.current.taskId !== detail.board.task_id) {
      seen.current = { taskId: detail.board.task_id, ids: new Set(posts.map(post => post.id)) };
      setSelection(null); setHighlightUntil({}); return;
    }
    const timestamp = Date.now();
    const fresh = posts.filter(post => !seen.current!.ids.has(post.id) && timestamp - Date.parse(post.created_at) >= 0 && timestamp - Date.parse(post.created_at) < 15000);
    seen.current.ids = new Set(posts.map(post => post.id));
    if (!live) { setHighlightUntil({}); return; }
    if (fresh.length) setHighlightUntil(current => ({ ...current, ...Object.fromEntries(fresh.map(post => [post.id, timestamp + 5000])) }));
  }, [detail.board.task_id, posts, live]);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  const fresh = (post: CollaborationPost) => live && (highlightUntil[post.id] || 0) > now;

  const connections = new Map<string, Connection>();
  function addConnection(connection: Omit<Connection, "count">) {
    if (!positions[connection.from] || !positions[connection.to] || connection.from === connection.to) return;
    const key = `${connection.from}:${connection.to}:${connection.kind}`;
    connections.set(key, { ...connection, count: (connections.get(key)?.count || 0) + 1 });
  }
  for (const question of questions) {
    addConnection({ from: question.agent, to: question.recipient!, post: question, question, kind: "question" });
    for (const answer of posts.filter(post => post.kind === "answer" && post.reply_to_id === question.id)) {
      addConnection({ from: answer.agent, to: answer.recipient || question.agent, post: answer, question, kind: "answer" });
    }
  }
  const links = [...connections.values()];
  const lastExchange = [...links].sort((a, b) => b.post.sequence - a.post.sequence)[0];
  const selectedPosts = selection?.kind === "agent"
    ? posts.filter(post => post.agent === selection.slug || post.recipient === selection.slug)
    : selection?.kind === "exchange" ? posts.filter(post => post.id === selection.questionId || post.reply_to_id === selection.questionId) : [];

  return <section className="collab-floor" aria-label="Agent collaboration floor">
    <style>{floorStyles}</style>
    <div className="collab-floor-heading"><div><GitBranch size={14} aria-hidden="true" /><h2>Agent floor</h2><span>{slugs.length} participants</span></div><div className="collab-floor-legend"><span><i className="collab-floor-question-dot" />Question</span><span><i className="collab-floor-answer-dot" />Reply</span></div></div>
    <div ref={mapRef} className="collab-floor-map" style={{ height: slugs.length ? height : 220 }}>
      {slugs.length === 0 ? <p className="collab-floor-empty">Participants will appear when this investigation starts.</p> : <>
        <svg className="collab-floor-lines" width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} aria-label="Recorded question and reply connections">
          <defs>{(["question", "answer"] as const).map(kind => <marker key={kind} id={`${markerId}-${kind}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 1 1 L 9 5 L 1 9" fill="none" stroke={kind === "answer" ? "#4dcc9b" : "#40bad6"} strokeWidth="1.7" /></marker>)}</defs>
          {links.map(connection => {
            const path = connectionPath(positions[connection.from], positions[connection.to], cardWidth, connection.kind);
            const name = `${agentLabel(connection.from, agents)} to ${agentLabel(connection.to, agents)}: ${label(connection.kind)}${connection.count > 1 ? ` (${connection.count})` : ""}`;
            return <g key={`${connection.from}:${connection.to}:${connection.kind}`} className={`collab-floor-edge ${fresh(connection.post) ? "collab-floor-edge-fresh" : ""}`} role="button" tabIndex={0} aria-label={`View ${name}`} onClick={() => setSelection({ kind: "exchange", questionId: connection.question.id })} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelection({ kind: "exchange", questionId: connection.question.id }); } }}>
              <title>{name}</title><path d={path} fill="none" stroke="transparent" strokeWidth="15" className="collab-floor-edge-hit" />
              <path className="collab-floor-edge-line" d={path} fill="none" stroke={connection.kind === "answer" ? "#4dcc9b" : "#40bad6"} strokeOpacity={fresh(connection.post) ? 1 : .6} strokeWidth={fresh(connection.post) ? 2.4 : 1.4} strokeDasharray={connection.kind === "question" ? "4 4" : undefined} markerEnd={`url(#${markerId}-${connection.kind})`} />
            </g>;
          })}
        </svg>
        {slugs.map(slug => {
          const point = positions[slug];
          const activity = latest(posts.filter(post => post.agent === slug || (post.kind === "question" && post.recipient === slug)));
          const state = stateFor(slug, detail, posts, questions, replies);
          const activeHighlight = posts.some(post => (post.agent === slug || post.recipient === slug) && fresh(post));
          return <button type="button" key={slug} className={`collab-floor-agent ${slug === lead ? "collab-floor-lead" : ""} ${activeHighlight ? "collab-floor-agent-fresh" : ""}`} style={{ left: point.x, top: point.y, width: cardWidth, height: CARD_HEIGHT, borderTopColor: agentColor(slug) }} aria-label={`${agentLabel(slug, agents)}: ${state.text}. View contributions`} onClick={() => setSelection({ kind: "agent", slug })}>
            <div className="collab-floor-agent-identity"><AgentBadge slug={slug} size={30} /><div><strong title={agentLabel(slug, agents)}>{agentLabel(slug, agents)}</strong><span>{slug === lead ? "Lead agent" : "Specialist"}</span></div></div>
            <span className={`collab-floor-state collab-floor-state-${state.tone}`}><i />{state.text}</span>
            <p>{activity ? `${activity.agent !== slug ? "Asked: " : ""}${brief(activity.content, 82)}` : "Waiting for a recorded contribution."}</p>
            <span className="collab-floor-agent-more">View contributions<ChevronRight size={10} aria-hidden="true" /></span>
          </button>;
        })}
      </>}
    </div>
    {lastExchange ? <button type="button" className={`collab-floor-exchange ${fresh(lastExchange.post) ? "collab-floor-exchange-fresh" : ""}`} onClick={() => setSelection({ kind: "exchange", questionId: lastExchange.question.id })}>
      <MessageSquare size={15} aria-hidden="true" /><div><span className="collab-floor-exchange-label">Latest exchange · {label(lastExchange.kind)}</span><strong>{agentLabel(lastExchange.from, agents)}<ArrowRight size={11} aria-hidden="true" />{agentLabel(lastExchange.to, agents)}</strong><p>{brief(lastExchange.post.content, 160)}</p></div><span className="collab-floor-exchange-more">View full exchange<ChevronRight size={13} aria-hidden="true" /></span>
    </button> : <p className="collab-floor-empty-exchange">No questions between agents have been recorded yet.</p>}
    <p className="collab-floor-footnote">States reflect messages in this investigation. Completed work does not establish that an incident is resolved.</p>
    <Dialog open={selection !== null} onOpenChange={open => { if (!open) setSelection(null); }}><DialogContent className="w-[calc(100%-2rem)] max-w-2xl"><DialogHeader><DialogTitle>{selection?.kind === "agent" ? `${agentLabel(selection.slug, agents)} contributions` : "Agent exchange"}</DialogTitle><DialogDescription>Questions, findings and replies recorded in this investigation.</DialogDescription></DialogHeader><div className="space-y-4">
      {selectedPosts.map(post => <article key={post.id} className="rounded-lg border border-border p-4"><div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs"><strong>{agentLabel(post.agent, agents)}{post.recipient ? ` → ${agentLabel(post.recipient, agents)}` : ""} · {label(post.kind)}</strong><time className="text-muted-foreground" dateTime={post.created_at}>{formatDateTime(post.created_at)}</time></div><p className="whitespace-pre-wrap break-words text-sm">{post.content}</p></article>)}
      {!selectedPosts.length && <p className="text-sm text-muted-foreground">No contributions recorded yet.</p>}
    </div></DialogContent></Dialog>
  </section>;
}

const floorStyles = `
.collab-floor{min-width:0;overflow:hidden;border:1px solid #1d3042;border-radius:12px;background:#09131e;color:#dce8f3}
.collab-floor-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding:14px 16px;border-bottom:1px solid #192b3c;background:#0b1622}
.collab-floor-heading>div{display:flex;align-items:center;gap:8px;min-width:0}.collab-floor-heading h2{margin:0;font-size:13px;font-weight:650;letter-spacing:.01em}.collab-floor-heading>div>svg{color:#58bfd4}.collab-floor-heading>div>span{font-size:10px;color:#7e94a8}
.collab-floor-legend{display:flex;gap:12px!important}.collab-floor-legend span{display:flex;align-items:center;gap:5px}.collab-floor-legend i{width:5px;height:5px;border-radius:50%}.collab-floor-question-dot{background:#40bad6}.collab-floor-answer-dot{background:#4dcc9b}
.collab-floor-map{position:relative;isolation:isolate;min-width:0;background-color:#09131e;background-image:radial-gradient(circle,#233a4b 1px,transparent 1px),linear-gradient(180deg,#0b1d2b55,transparent 70%);background-size:22px 22px,100% 100%}
.collab-floor-lines{position:absolute;inset:0;overflow:visible;z-index:0}.collab-floor-edge{cursor:pointer;outline:none}.collab-floor-edge-hit{pointer-events:stroke}.collab-floor-edge:focus .collab-floor-edge-line,.collab-floor-edge:hover .collab-floor-edge-line{stroke-width:2.6;stroke-opacity:1}
.collab-floor-agent{position:absolute;z-index:1;transform:translate(-50%,-50%);display:flex;flex-direction:column;gap:7px;padding:12px 11px 9px;border:1px solid #263d50;border-top-width:2px;border-radius:9px;background:#0e1b28;text-align:left;box-shadow:0 6px 20px #0003;color:#dce8f3;cursor:pointer;overflow:hidden}
.collab-floor-agent:hover,.collab-floor-agent:focus-visible{outline:1px solid #66cee2;outline-offset:2px;background:#112232}.collab-floor-lead{background:#102231;border-color:#32566d;box-shadow:0 0 0 4px #17364a33,0 6px 20px #0003}
.collab-floor-agent-identity{display:flex;align-items:center;gap:8px;min-width:0}.collab-floor-agent-identity>div{min-width:0;flex:1}.collab-floor-agent-identity strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:650}.collab-floor-agent-identity span:not([role=img]){display:block;margin-top:2px;color:#7d94aa;font-size:9px;text-transform:uppercase;letter-spacing:.07em}
.collab-floor-state{display:flex;align-items:center;gap:5px;font-size:10px;font-weight:550;line-height:1.3;white-space:nowrap}.collab-floor-state i{width:4px;height:4px;flex-shrink:0;border-radius:50%;background:currentColor}.collab-floor-state-waiting{color:#e6be73}.collab-floor-state-complete{color:#76d6ac}.collab-floor-state-neutral{color:#9cb0c1}.collab-floor-state-error{color:#f58c97}
.collab-floor-agent>p{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere;margin:0;color:#a8bacb;font-size:10px;line-height:1.5;min-height:29px}.collab-floor-agent-more{display:flex;align-items:center;justify-content:space-between;gap:4px;color:#658ba5;font-size:9px;margin-top:auto}
.collab-floor-exchange{width:100%;display:flex;align-items:flex-start;gap:10px;padding:14px 16px;border-top:1px solid #1d3346;background:#0c1a27;text-align:left;color:#b9d0df;cursor:pointer}.collab-floor-exchange>svg{flex-shrink:0;margin-top:3px;color:#52b9d0}.collab-floor-exchange>div{min-width:0;flex:1}.collab-floor-exchange-label{font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:#7394aa}.collab-floor-exchange strong{display:flex;align-items:center;flex-wrap:wrap;gap:5px;margin:4px 0;font-size:11px;font-weight:550;color:#cce3ef}.collab-floor-exchange p{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere;margin:0;font-size:11px;line-height:1.55;color:#98aebe}.collab-floor-exchange-more{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:4px;max-width:85px;font-size:10px;color:#69c6dd;margin-top:4px}.collab-floor-exchange:hover,.collab-floor-exchange:focus-visible{background:#102332;outline:1px solid #66cee2;outline-offset:-2px}
.collab-floor-footnote{margin:0;padding:10px 16px;border-top:1px solid #182c3d;font-size:9px;line-height:1.5;color:#6f879d}.collab-floor-empty{position:absolute;inset:0;display:grid;place-items:center;padding:24px;color:#7892a7;text-align:center;font-size:12px}.collab-floor-empty-exchange{padding:14px 16px;margin:0;border-top:1px solid #1d3346;font-size:11px;color:#7892a7}
.collab-floor-agent-fresh{animation:collab-floor-arrival 1.7s ease-in-out 2}.collab-floor-edge-fresh .collab-floor-edge-line{animation:collab-floor-communication 1.3s linear 3}.collab-floor-exchange-fresh{border-top-color:#3b879f}
@keyframes collab-floor-arrival{0%,100%{box-shadow:0 0 0 1px #3bbbd744}50%{box-shadow:0 0 0 4px #3bbbd71a,0 0 16px #32a3c025}}
@keyframes collab-floor-communication{from{stroke-dashoffset:16}to{stroke-dashoffset:0}}
@media(prefers-reduced-motion:reduce){.collab-floor-agent-fresh,.collab-floor-edge-fresh .collab-floor-edge-line{animation:none!important}}
@media(max-width:400px){.collab-floor-heading{padding:12px}.collab-floor-heading>div>span{font-size:9px}.collab-floor-exchange{padding:12px}.collab-floor-exchange-more{max-width:55px;font-size:9px}}
`;
