export interface DocumentationSection {
  id: string;
  title: string;
  paragraphs: string[];
  columns?: string[];
  rows?: string[][];
  flow?: string[];
  sources: string[];
}

export const documentation: DocumentationSection[] = [
  { id: "platform", title: "Platform", paragraphs: ["Ops Center is a single React/TypeScript application with a FastAPI backend. PostgreSQL stores application state, Redis handles task queues/events, and Celery workers execute infrastructure jobs. Browser and optional PWA use the same API."], sources: ["frontend/package.json", "backend/app/main.py", "compose.yml", "docs/pwa.md"] },
  { id: "configuration", title: "Configure your environment", paragraphs: ["Register your servers and managed SSH credentials through Servers and Settings. Traffic Map sources, retention and authentication trust rules are editable under Settings. AI providers, agent tool permissions, host scopes and collaboration budgets have dedicated AI settings pages. No monitored hosts or trusted origins are enabled on a fresh installation."], sources: ["docs/traffic-map.md", "docs/integrations.md", "backend/app/schemas/traffic_settings.py"] },
  { id: "agents", title: "Agents and permissions", paragraphs: ["Agents share a typed runtime. A model can propose tool calls; backend code enforces permitted tools, host/environment scopes and approval rules. Prompts, fetched logs and prior conversations cannot grant permissions. Provider responses are evidence to review, not guaranteed operational facts."], sources: ["worker_ai/ai/runtime.py", "backend/app/core/action_policy.py", "worker_ai/ai/tools/exec_tools.py"] },
  { id: "approvals", title: "Administrative actions", paragraphs: ["Sensitive operations require a specific approved action. Talk supports approve/reject with the exact ACT request code and an active bound administrator account. A vague yes does not approve an action. Disk expansion uses one approval for its validated workflow, including capacity and identity checks; partial growth cannot be rolled back by shrinking."], sources: ["docs/disk-expansion.md", "backend/app/services/action_approval.py", "worker_ai/disk_ops.py"] },
  { id: "collaboration", title: "Collaboration and memory", paragraphs: ["Optional collaboration investigations are owner-private and disabled until configured. Typed budgets and limits bound agent work. Memory and conversation access remain bound to the owning user and approved Talk room; raw private collaboration input is omitted from the global audit log."], sources: ["docs/agent-collaboration.md", "docs/agent-memory.md", "worker_ai/ai/collaboration.py"] },
  { id: "monitoring", title: "Traffic and authentication", paragraphs: ["Configure each NPM, Caddy, application audit, SSH or WireGuard source against an onboarded server. Generic HTTP success does not prove login success. SSH country exemptions are never applied; only current trusted DNS addresses are exempt. Collector/DNS failures are visible and old observations are not represented as live."], sources: ["docs/traffic-map.md", "backend/app/services/traffic_auth.py", "backend/app/services/traffic_watch.py"] },
  { id: "deployment", title: "Installation and HA", paragraphs: ["Use the public installer for a single server or the optional HA generator and deployment guide. Keep credentials, inventories, logs and generated runtime configuration outside Git. HA nodes share database settings, while credential files and editable playbooks require secure synchronization. Monitoring stores are not automatically replicated."], sources: ["docs/ha.md", "docs/operations.md", "docs/security.md"] },
];
