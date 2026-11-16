# Ops Floor

`/ai-agents/ops-floor` shows who needs you, who is working and what is happening. It has two views of the same data: **2D Plan** and **3D Office**. The AI overview page uses the same data, figures and log, and a click there opens the agent on the floor (`?agent=<slug>`).

## Where things live

| What | File |
|---|---|
| Rooms and seats | `frontend/src/lib/opsFloor/config.ts` |
| Status, filters, counts, links, log | `frontend/src/lib/opsFloor/model.ts` |
| API and live stream | `frontend/src/lib/opsFloor/useOpsFloorData.ts` |
| Events published by the worker | `worker_ai/ai/agent_state.py` (`EVENTS`) |
| Agent portraits (same looks as the 3D figures) | `frontend/src/components/ops-floor/AgentFigure.tsx` |
| Task details | `frontend/src/components/ops-floor/TaskDialog.tsx` |
| Figures, props and the room | `frontend/src/components/ops-floor/office3d/geometry.ts` |

To move an agent, edit its seat in `config.ts` and in `tui/src/floor.rs` (`fixed_seat`), which draws the same plan in `opstui` (key `9`). An agent with no seat appears in a room called **Other** with a default figure, so nobody disappears.

## Status

Every view and count uses one status, chosen in this order:

| Status | When |
|---|---|
| Error | The agent reports `error` |
| Needs approval | The agent has a pending action, or the worker says it is waiting for approval |
| Paused | The agent is disabled |
| Working | `working`, `investigating`, or `waiting` on another agent |
| Idle | Anything else |

`waiting` alone does not mean approval, because an agent also waits on the specialists it delegates to.

## Events and motion

Besides its status, every live update says what just happened: `task_started`, `tool_started` (with the tool), `tool_finished`, `delegated` and `returned` (with the other agent), `approval_requested`, `action_started`, `action_finished`, `completed`, `stopped` or `error`. They are set in the worker where the thing happens and travel on the existing Redis/SSE stream; the browser never guesses them.

`motionOf` in `model.ts` turns them into one look per agent, used by both views:

| Look | From |
|---|---|
| Starting a task | `task_started` |
| Running a tool | `tool_started` |
| Thinking | `tool_finished`, until the next step |
| Delegating | `delegated`; the 3D figure stands and turns to the other agent |
| Reviewing results | `returned` |
| Completed | `completed`, for 5 seconds, then Idle |
| Working | working with no event to say more |

Workstation screens show the kind of work (terminal, code, security scan, dashboard, containers, patches) only while the agent works. They are synthetic patterns and never show real output.

Error text is redacted in the worker before it is stored or published: file paths and anything shaped like a credential are replaced. The full error stays on the task.

Animation stops with `prefers-reduced-motion` and pauses while the tab is hidden. A hidden tab does not poll; it refreshes when shown and after the stream reconnects.

## Links

A line is either a delegation the configuration allows (`allowed_dispatch_targets`, where null on the Coordinator means every enabled agent that is neither personal nor external) or one a running task has really made (`agents_used`). Lines are dim by default, blue and moving for active delegations, yellow for approval and red for error.

In 2D, the configured routes are drawn only for the selected agent, so the plan is not a web of lines. Work moving right now is drawn with an arrow and a moving packet: out on `delegated`, back on `returned`. A line made by a running task opens that task when clicked.

## Camera (3D)

Drag turns, Shift or right drag moves, the wheel zooms, double-click focuses an agent. **Follow selected** keeps the camera on the selected agent, **Focus approvals** moves it to an agent the moment it starts waiting for you. Both choices are remembered in the browser.

## Privacy

The page is shared. The activity log builds its history from tasks but never shows a task's text, since that text can be the words of someone's personal agent. Live activity comes from the stream, where the worker has already masked it.

## Approvals

**Approve** and **Reject** use the same API and role rule as the Approvals page (`lib/aiApprovals.ts`). The API enforces the rule; the page only decides what to offer.

## 3D performance

The office is CSS 3D, about 1,000 faces, with no WebGL. Geometry is built once and live updates only change attributes on each station. To lower the cost, reduce the boxes in `geometry.ts`.
