import { formatDateTime, formatDayTime } from "@/lib/format";
import type { ActivityGroup, FloorAgent } from "@/lib/opsFloor/model";

import { AgentFigure } from "./AgentFigure";
import { StatusGlyph } from "./StatusGlyph";

/**
 * What really happened, newest first: events from the worker and saved task
 * results, one line per agent and task with how often each step happened.
 * Expanding a line lists every event. A click marks the agent on the floor;
 * the task button opens the task.
 */
export function ActivityLog({ groups, agents, onSelect, onOpenTask, selected, live = true }: {
  groups: ActivityGroup[];
  agents: FloorAgent[];
  onSelect: (slug: string) => void;
  onOpenTask?: (taskId: string) => void;
  selected?: string | null;
  live?: boolean;
}) {
  const name = new Map(agents.map((agent) => [agent.slug, agent.short]));
  return (
    <section aria-label="Activity" className="of-panel">
      <div className="of-panel-head">
        <h2>Activity</h2>
        <span>{live ? "Live. Newest first; repeated steps of one task are grouped." : "Live updates are paused; showing saved tasks."}</span>
      </div>
      {groups.length === 0 && <p className="of-empty">Nothing has happened yet.</p>}
      <ul className="of-log" aria-live="polite" aria-relevant="additions">
        {groups.map((group) => (
          <li key={group.id} data-hot={selected && (group.slug === selected || group.peer === selected) ? "" : undefined}>
            <div className="of-log-line">
              <button type="button" className="of-log-row" onClick={() => onSelect(group.slug)}>
                <time dateTime={new Date(group.ts).toISOString()} title={formatDateTime(group.ts)}>{formatDayTime(group.ts)}</time>
                <StatusGlyph status={group.kind} />
                <span className="of-log-who"><AgentFigure slug={group.slug} size={16} />{name.get(group.slug) ?? group.slug}</span>
                <span className="of-log-text">{group.text}{group.count > 1 && <span className="of-log-count" title={`${group.count} events`}>×{group.count}</span>}</span>
              </button>
              {group.taskId && onOpenTask && <button type="button" className="of-log-task" aria-label={`Open the task for: ${group.text}`} onClick={() => onOpenTask(group.taskId!)}>Task</button>}
            </div>
            {group.count > 1 && (
              <details className="of-log-more">
                <summary>{group.tally.map(([step, n]) => `${step} ×${n}`).join(" · ")}</summary>
                <ol>
                  {group.rows.map((row) => (
                    <li key={row.id}><time dateTime={new Date(row.ts).toISOString()}>{formatDayTime(row.ts)}</time><StatusGlyph status={row.kind} size={10} />
                      {!group.taskId && row.taskId && onOpenTask
                        ? <button type="button" className="of-log-sub" onClick={() => onOpenTask(row.taskId!)}>{row.text} · open task</button>
                        : <span>{row.text}</span>}</li>
                  ))}
                </ol>
              </details>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
