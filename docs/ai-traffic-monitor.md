# AI Traffic Monitor

AI Traffic Monitor records the network activity of Ops Center's AI layer:
the agents and sub-agents in the AI worker (`ops-ai-worker`), their model providers,
MCP calls and tools. It answers five questions: who communicated, where, what
they tried to do, what happened, and which agent was behind it.

It is **passive and read-only**. It adds no firewall rule, route, proxy, network
policy or DNS change, never intercepts or decrypts TLS, and never alters a
request. Section [What it does not change](#what-it-does-not-change) lists what
was checked.

## Architecture

```
ops-ai-worker ───────(httpx/httpx2 transport + getaddrinfo instrumentation,
   │                    OTel GenAI spans)──► ai_traffic_ingest() ──┐
   │                                                                ▼
   │  packets on the container bridges                   PostgreSQL: ai_traffic_events,
   ▼                                                      ai_trace_spans, ai_traffic_sources,
ai-traffic-collector (Rust, per node) ──POST /api/ai-traffic/ingest──► ops-api ──► UI
   conntrack NEW/DESTROY (netlink), header capture         ai_traffic_captures, ai_traffic_settings
```

Two sources:

| Source | Where | Gives | Cannot see |
|---|---|---|---|
| **AI worker instrumentation** (`worker_ai/ai/netlog.py`) | inside the AI worker container | agent, sub-agent, tool, MCP tool, provider, model, task/trace/span, method, path (no query), HTTP status, body bytes, TTFB, duration, exact local/remote socket, DNS lookups, failure class, AI access-control decisions | traffic not made through httpx/getaddrinfo (Postgres/Redis drivers) |
| **Passive collector** (`ai_traffic_collector/`, Rust) | one container per node, host network/PID namespace | every connection the kernel tracks for an AI container (conntrack), wire bytes (with `nf_conntrack_acct=1`), host PID and process, DNS queries/answers on the wire, TLS SNI/ALPN/version from the ClientHello, TCP RST, ICMP unreachable/admin-prohibited, local drops | encrypted content, which agent made a connection unless the worker reported it too |

Considered and not chosen: **Tetragon** (Kubernetes-oriented, heavy, overlaps
both sources), **Zeek** (a full IDS for a few connections per minute),
**Cilium Hubble** (no Cilium/Kubernetes here), **Langfuse** (needs its own
ClickHouse stack; used only as a reference for the trace view). OpenTelemetry
GenAI is used for its attribute names (`gen_ai.operation.name`,
`gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.*_tokens`,
`gen_ai.tool.name`, `gen_ai.agent.name`), without a Collector.

### Identification

AI traffic is identified by **process and container identity**, never by a list
of AI domains: everything the AI worker container does is in scope, including
ordinary websites, own servers and unknown APIs. The collector discovers the AI
containers (`AI_TRAFFIC_CONTAINERS`, a comma-separated name list, or label
`ops-center.ai-traffic=1`) through the Docker API every 30 s and follows their
addresses. The PID owning a socket is looked up in `/proc`.

### Correlation and de-duplication

A task's trace id is its task UUID. Every agent run (also delegated and parallel
ones), model call and tool call is a span; every network event carries the span
that caused it. `ai_traffic_ingest()` (migration 0061) merges observations of the
same connection from different sources into one row. Matching uses node, 5-tuple
and start time within 10 s, or the same name within 3 s for DNS. The more
specific failure wins, so an observed ICMP reject outranks the worker's timeout.
Every original observation is kept in `observations`/`obs_keys`.

## Outcome classes

| Outcome | Shown as | Evidence |
|---|---|---|
| `firewall_block` | Blocked | ICMP 3/9, 3/10, 3/13 or ICMPv6 1/1 (administratively prohibited) on the wire; or a SYN seen on the bridge that the kernel never confirmed, with no ICMP reply, no lost conntrack events and an off-bridge destination (inferred local netfilter DROP; the reason says "dropped on this host") |
| `dns_block` | Blocked | resolver answered 0.0.0.0/:: |
| `ai_access_control` | Blocked | Ops Center refused before sending: tool not allowed, host not in `allowed_hosts`, MCP without grant, MCP endpoint not LAN, collaboration policy, private-source isolation, budget stop. Rejected/expired approvals are listed from `ai_actions`. |
| `remote_reject` | Failed | HTTP 401/403/407/451 |
| `http_error` | Failed | other HTTP 4xx/5xx |
| `dns_error` | Failed | resolution failed, NXDOMAIN, SERVFAIL, REFUSED, no answer (an NXDOMAIN-mode blocklist looks the same) |
| `connect_error` | Failed | refused (RST), unreachable (non-prohibited ICMP), reset |
| `timeout` | Failed | no answer in time; **never** shown as a block |
| `tls_error` | Failed | handshake/certificate failure |
| `unknown` | Failed | the data cannot tell |

**Host firewall drop logs are not read** (for example firewalld with
`LogDenied=off`, or no host firewall at all), so no rule id is available.
The UI reports this under **Capture & Sources → Coverage** as *Not covered*.
It never presents zero blocks as confirmed. Enabling `LogDenied` would change
firewall configuration and is deliberately left as a separate decision.

## UI

Menu **AI Traffic Monitor** (`/ai-traffic`):

* **Overview**: active connections, connections in the last minute and hour, OK/failed/blocked,
  bytes, outcome over time, top agents, destinations and models, source status and coverage gaps.
* **Live Traffic**: table updated every 3 s with full-text search and filters on time, agent,
  model, tool, process, container, domain, IP, port, node, trace, status and type. Select a row
  for every field, the span chain and the original observations. Export filtered rows to CSV
  or JSON.
* **Blocked & Failed**: per-class counts, reason, evidence source and rule id (where one
  exists), and rejected or expired approvals.
* **Agent Trace**: timeline per task: request, agents, model calls (tokens), tools and their
  network events, and the final answer.
* **Live Map**: a dark world map of observed connections, updated every 5 s, with pause, zoom/pan, filters
  (agent, model, process, IP, domain, protocol, status, AI or system traffic) and history windows up to 30 days.
  See [Live Map](#live-map).
* **Network Flow**: interactive graph from agent or process, through tool or model, to
  destination. Select a line or node for details and its events. A table view is included.
* **Capture & Sources**: coverage list, per-source health, lost events (worker queue overflow
  or DB errors, collector buffer drops, conntrack ENOBUFS overruns, pcap kernel drops),
  retention, and PCAP capture.

Access uses the existing roles. Any signed-in user sees the overview and
coverage. **operator** is needed for events, traces, the flow graph and exports.
**admin** is needed for retention and PCAP.
The collector endpoints (`/api/ai-traffic/ingest`, `/api/ai-traffic/collector/*`)
accept only a per-node token, HMAC-SHA256 of the node name keyed with
`AI_TRAFFIC_INGEST_TOKEN`. A collector can write capture observations only for its
own node, and only with network fields. Agent, trace, tool and model come only from
the AI worker. CSV exports put a quote in front of cells that start with
`= + - @`, so a spreadsheet does not run them as formulas. These routes are excluded from MCP (`mcp_catalog.json`), so agents
cannot read or steer their own monitoring.

## Live Map

`GET /api/ai-traffic/map` (operator) groups events in SQL by who (agent and process), node, destination
IP and port, protocol and result. Thousands of identical connections, Celery to Redis for example, become one
group with a count, byte totals and first and last seen. At most 1,500 groups are returned, most recent first,
and the page says when the list was cut. Expanding a group loads its individual events through the existing
events API.

* **Where a destination appears**:
  * *External* (globally routable) addresses get an **approximate** location from the local DB-IP MMDB that Traffic Map already uses. No external lookup is made.
  * *Internal* (RFC 1918, ULA, CGNAT) and *local* (loopback, link-local) addresses are never placed on the world map. They appear in the **Internal & same-host traffic** topology, labelled with a service only as "usually Redis" for well-known ports.
  * *Unknown* destinations (refused before an address existed, or an unparsable address) and public addresses without a location are listed but not drawn.
* **AI or system**: the event's own attribution (agent, model, provider, tool, MCP tool) decides this, never the destination.
* **Direction**: outbound when the collector tied the initiating socket to an AI container or the worker made the call; otherwise inbound to an AI container.
* **Lines**: lines are drawn from AI nodes whose inventory host has a latitude and longitude. A line active in the last minute gets a calm dash animation, which is off with reduced motion.
* **Map data**: the outline is Natural Earth 110m (public domain), bundled at build time (`frontend/src/lib/worldMap.ts`). The page fetches no tiles and sends nothing to a third party.
* **Coverage**: gaps (missing collector, firewall logs) are shown above the map. An empty map means nothing was *observed*, not that nothing happened.

The endpoint is one SELECT. Like the rest of the monitor it changes no network, firewall or routing state.

## Privacy and secrets

Prompts and responses are never stored, only sizes and token counts. Headers,
cookies, `Authorization`, query strings and request bodies are not recorded.
Path segments that look like tokens are masked as `***`. The task text stays
in `ai_tasks` and the trace view does not show it. A PCAP has a 128-byte snaplen
(headers only), is limited to 300 s and 20 MB, can be downloaded by admins only,
and is deleted after `capture_retention_hours`.

## Performance

* Worker: recording is a `put_nowait` into a bounded queue (5000). One daemon
  thread per Celery process writes batches of up to 200 rows per second with a
  single `SELECT ai_traffic_ingest(...)`. A full queue or DB error drops the
  rows and counts them, and the heartbeat shows the count. The agent is never blocked.
* Collector: the kernel BPF filter passes only SYN/RST, DNS, TLS handshake records
  and ICMP errors of the AI container addresses. Conntrack events are filtered
  in user space by source address. The collector has `mem_limit: 128m` and `cpus: 0.5`,
  keeps at most 50 000 flows and buffers at most 20 000 events.
* Storage: `ai_traffic_events` with GIN full-text and trace/agent/time indexes.
  The hourly `prune_ai_traffic` job (ops-scheduler, minute 25) removes events
  and spans older than `retention_days` (default 30, configurable in the UI) in
  short batches, deletes expired PCAPs and forgets stale worker counters.

## Deployment

1. Generate the API secret once and put the same value in `.env` on every node:
   `AI_TRAFFIC_INGEST_TOKEN=$(openssl rand -hex 32)`. On each node, derive the
   collector's own token and set `AI_TRAFFIC_COLLECTOR_TOKEN` to it:
   `printf %s "$OPS_LOCAL_HOSTNAME" | openssl dgst -sha256 -hmac "$AI_TRAFFIC_INGEST_TOKEN" | awk '{print $NF}'`.
   Check that `OPS_LOCAL_HOSTNAME` is set per node, because it is the node name of
   both sources and is bound to the token.
2. Migrate (0061), rebuild and restart `ops-api`, `ops-ai-worker`, `ops-scheduler`
   (beat entry) and `ops-frontend`, then start the optional collector on each node:
   `docker compose --profile ai-traffic up -d ai-traffic-collector`. It observes
   containers labelled `ops-center.ai-traffic=1` (the AI worker in `compose.yml`).
3. Optional, approved separately: enable byte counters with
   `sysctl -w net.netfilter.nf_conntrack_acct=1`, made persistent in
   `/etc/sysctl.d/`. This only counts and changes no traffic. Without it, wire
   bytes show as "not measured" and the worker's HTTP body sizes are used.
4. Check **Capture & Sources**: every node reporting, conntrack listening, the
   bridges listed, no lost events.

Set `AI_TRAFFIC_APP=0` on the worker or `AI_TRAFFIC_CAPTURE=0` on the collector
to switch a source off. Coverage then shows it as missing.

## What it does not change

The collector container needs `NET_ADMIN` only to subscribe to conntrack
multicast groups. It sends no conntrack, nftables or iptables command, and the
code has no write path to netfilter. `NET_RAW` is used for an AF_PACKET capture
in non-promiscuous mode. To verify after a deployment, compare before and after:

```
nft list ruleset > /tmp/nft.before; iptables-save > /tmp/ipt.before; ip route > /tmp/route.before
sysctl -a 2>/dev/null | grep -E 'net\.(ipv4|netfilter|bridge)' > /tmp/sysctl.before
# ... deploy ...
# repeat into *.after and diff: the only expected difference is nf_conntrack_acct if step 3 was approved.
```

## Limits

* Content of HTTPS is never seen on the wire. Method, path and status exist only
  for requests the worker made itself.
* The SYN-without-conntrack inference assumes the SYN would have been confirmed
  by this host's netfilter. Destinations on the same Docker bridge are excluded,
  because bridged traffic may bypass netfilter, as are periods with lost conntrack events.
* DNS answered by Docker's embedded resolver for container names never leaves
  the container. Only the worker's own lookups record it.
* Long-lived connections report their bytes when they close (conntrack DESTROY).
* Pi-hole query logs and firewall drop logs are not integrated, and the UI shows them as gaps.
* External agents (for example opencode, Claude Code or Codex on an admin host)
  and other AI front ends are not covered by this version. Coverage was scoped to the Ops Center agents.
