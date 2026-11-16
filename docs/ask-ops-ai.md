# Ask Ops AI: floating assistant

The **Ask Ops AI** button at the bottom right opens a compact floating window over the current page. It does
not navigate away. The full page (`/ai-agents/chat`, also in the AI menu) is unchanged and shares the same
conversation logic: agent choice, saved history, conversation threads, approvals of agent actions, memory and
MCP all behave the same in both places.

| Mode | How |
|---|---|
| Floating | first click; drag it by its title bar (desktop) |
| Minimized | the – button or Escape. The conversation keeps running, and the button shows "minimized" |
| Large | ⤢ in the title bar |
| Pinned side panel | the panel button. The page content makes room instead of being covered. Undock to float again |
| Full page | ↗ opens `/ai-agents/chat` with the same agent and conversation |

On phones the assistant is a bottom sheet. Pinning needs a wider screen, so there it falls back to the large
sheet. The chosen layout, position and agent are stored in the browser (`ops_ask_dock`, UI state only). The
assistant never opens by itself after a reload. It is hidden on the full chat page and on the collaboration
board, which have their own conversation UI.

## Page context

A chip above the input shows what the question will carry, for example *Context: AI Traffic Monitor · 2 details*.
The chip's tooltip lists everything in it, and × sends the question without it. Context consists of:
* the page name and its route, including filter and time-window query parameters (parameters whose names look like credentials are removed);
* identifiers the page offers through `useAskOpsPageContext`. Today that is the Developer Agent's selected change and its status, the AI Traffic Monitor view, and the Live Map's selected connection or location and its filters.

Context never contains page data such as log lines or event contents. The agent reads data with its own tools,
under its own and the user's permissions. `/ai/ask` validates the context (at most 12 short items), refuses one
that looks like a credential, and appends it visibly to the question, so it stays in the saved history. The web
UI hides that block when it shows the question again.
