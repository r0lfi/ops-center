"""AI Traffic Monitor: passive record of AI network activity.

* ai_traffic_events: one row per observed connection, HTTP request, DNS
  lookup or access-control decision. Several sources can observe the same
  connection (the worker's HTTP instrumentation and the passive capture
  sidecar); ai_traffic_ingest() merges them into one row and keeps a
  reference to every original observation in `observations`.
* ai_trace_spans: task / agent / model call / tool call spans (OpenTelemetry
  GenAI attribute names), so network events can be followed back to the
  agent and tool that caused them.
* ai_traffic_sources: heartbeat and counters of every collector, so missing
  coverage and lost events are shown instead of an empty table.
* ai_traffic_captures: bounded, admin-requested header-only PCAP captures.
* ai_traffic_settings: retention.

Nothing here touches network configuration: this is storage only.

Revision ID: 0061
Revises: 0060
Create Date: 2026-11-14
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID

revision = "0061"
down_revision = "0060"
branch_labels = None
depends_on = None

# Most specific explanation wins when two observations disagree: a capture
# that saw an ICMP "administratively prohibited" beats the app's timeout.
INGEST_FUNCTION = r"""
CREATE OR REPLACE FUNCTION ai_traffic_outcome_rank(outcome text) RETURNS int
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE outcome
    WHEN 'firewall_block' THEN 10 WHEN 'dns_block' THEN 9 WHEN 'ai_access_control' THEN 8
    WHEN 'tls_error' THEN 7 WHEN 'dns_error' THEN 6 WHEN 'remote_reject' THEN 5
    WHEN 'http_error' THEN 4 WHEN 'connect_error' THEN 3 WHEN 'timeout' THEN 2
    WHEN 'unknown' THEN 1 ELSE 0 END
$$;

CREATE OR REPLACE FUNCTION ai_traffic_ingest(rows jsonb) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  r jsonb;
  obs text;
  hit bigint;
  merged int := 0;
  r_ts timestamptz;
  r_src_port int;
  r_ok boolean;
  observation jsonb;
BEGIN
  FOR r IN SELECT value FROM jsonb_array_elements(rows) LOOP
    IF r->>'type' = 'span' THEN
      INSERT INTO ai_trace_spans (span_id, trace_id, parent_span_id, task_id, kind, name, agent_slug, node,
                                  started_at, ended_at, duration_ms, status, attributes)
      VALUES (r->>'span_id', r->>'trace_id', r->>'parent_span_id', (r->>'task_id')::uuid, r->>'kind', r->>'name',
              r->>'agent_slug', r->>'node', to_timestamp((r->>'ts')::float8),
              to_timestamp((r->>'ended_at')::float8), (r->>'duration_ms')::int, r->>'status',
              coalesce(r->'attributes', '{}'::jsonb))
      ON CONFLICT (span_id) DO UPDATE SET ended_at = EXCLUDED.ended_at, duration_ms = EXCLUDED.duration_ms,
        status = EXCLUDED.status, attributes = ai_trace_spans.attributes || EXCLUDED.attributes;
      CONTINUE;
    END IF;

    obs := (r->>'source') || ':' || (r->>'obs_id');
    r_ts := to_timestamp((r->>'ts')::float8);
    r_src_port := (r->>'src_port')::int;
    r_ok := coalesce(r->>'outcome', 'ok') = 'ok';
    observation := jsonb_strip_nulls(jsonb_build_object('source', r->>'source', 'obs_id', r->>'obs_id',
      'ts', r->>'ts', 'outcome', r->>'outcome', 'reason', r->>'reason',
      'bytes_sent', r->'bytes_sent', 'bytes_recv', r->'bytes_recv'));
    -- One destination at a time, so the app and the capture never insert the same connection twice.
    PERFORM pg_advisory_xact_lock(hashtext(coalesce(r->>'node', '') || '|' || CASE WHEN r->>'kind' = 'dns'
      THEN 'dns|' || lower(coalesce(r->>'dst_host', ''))
      ELSE coalesce(r->>'dst_ip', r->>'dst_host', '') || '|' || coalesce(r->>'dst_port', '') END));

    -- A later report of an observation already stored (a long connection's periodic update).
    SELECT id INTO hit FROM ai_traffic_events WHERE obs_keys @> ARRAY[obs] LIMIT 1;

    -- The same connection seen by another source: same node and 5-tuple, start within 10 s.
    -- Without a source port (a failed connect) it only joins another failed observation.
    IF hit IS NULL AND r->>'dst_ip' IS NOT NULL AND r->>'kind' IN ('http', 'tcp', 'udp') THEN
      SELECT id INTO hit FROM ai_traffic_events e
       WHERE e.node = r->>'node' AND e.dst_ip = r->>'dst_ip' AND e.dst_port = (r->>'dst_port')::int
         AND e.kind IN ('http', 'tcp', 'udp')
         AND NOT (e.sources @> ARRAY[r->>'source'])
         AND e.ts BETWEEN r_ts - interval '10 seconds' AND r_ts + interval '10 seconds'
         AND (e.src_port = r_src_port
              OR ((e.src_port IS NULL OR r_src_port IS NULL) AND e.outcome <> 'ok' AND NOT r_ok))
       ORDER BY (e.src_port = r_src_port) DESC NULLS LAST, abs(extract(epoch FROM e.ts - r_ts))
       LIMIT 1;
    END IF;

    -- The same lookup seen in the worker (getaddrinfo) and on the wire: same node and name within 3 s.
    IF hit IS NULL AND r->>'kind' = 'dns' AND r->>'dst_host' IS NOT NULL THEN
      SELECT id INTO hit FROM ai_traffic_events e
       WHERE e.node = r->>'node' AND e.kind = 'dns' AND lower(e.dst_host) = lower(r->>'dst_host')
         AND NOT (e.sources @> ARRAY[r->>'source'])
         AND e.ts BETWEEN r_ts - interval '3 seconds' AND r_ts + interval '3 seconds'
       ORDER BY abs(extract(epoch FROM e.ts - r_ts))
       LIMIT 1;
    END IF;

    IF hit IS NULL THEN
      INSERT INTO ai_traffic_events (ts, ended_at, duration_ms, ttfb_ms, node, kind, sources, obs_keys, observations,
        trace_id, span_id, task_id, agent_slug, tool, provider, model, mcp_tool, container, pid, process,
        src_ip, src_port, dst_ip, dst_port, dst_host, protocol, method, path, status_code,
        bytes_sent, bytes_recv, outcome, reason, rule_id, detail)
      VALUES (r_ts, to_timestamp((r->>'ended_at')::float8), (r->>'duration_ms')::int, (r->>'ttfb_ms')::int,
        r->>'node', r->>'kind', ARRAY[r->>'source'], ARRAY[obs], jsonb_build_array(observation),
        r->>'trace_id', r->>'span_id', (r->>'task_id')::uuid, r->>'agent_slug', r->>'tool', r->>'provider',
        r->>'model', r->>'mcp_tool', r->>'container', (r->>'pid')::int, r->>'process',
        r->>'src_ip', r_src_port, r->>'dst_ip', (r->>'dst_port')::int, r->>'dst_host', r->>'protocol',
        r->>'method', r->>'path', (r->>'status_code')::int, (r->>'bytes_sent')::bigint, (r->>'bytes_recv')::bigint,
        coalesce(r->>'outcome', 'ok'), r->>'reason', r->>'rule_id', coalesce(r->'detail', '{}'::jsonb));
    ELSE
      merged := merged + 1;
      UPDATE ai_traffic_events e SET
        ended_at = greatest(e.ended_at, to_timestamp((r->>'ended_at')::float8)),
        duration_ms = greatest(e.duration_ms, (r->>'duration_ms')::int),
        ttfb_ms = coalesce(e.ttfb_ms, (r->>'ttfb_ms')::int),
        sources = CASE WHEN e.sources @> ARRAY[r->>'source'] THEN e.sources ELSE e.sources || (r->>'source') END,
        obs_keys = CASE WHEN e.obs_keys @> ARRAY[obs] THEN e.obs_keys ELSE e.obs_keys || obs END,
        observations = CASE WHEN e.obs_keys @> ARRAY[obs]
          THEN (SELECT coalesce(jsonb_agg(CASE WHEN o->>'obs_id' = r->>'obs_id' AND o->>'source' = r->>'source'
                                                THEN observation ELSE o END), '[]'::jsonb)
                  FROM jsonb_array_elements(e.observations) o)
          ELSE e.observations || jsonb_build_array(observation) END,
        -- Application context (agent, tool, model, HTTP) is only known to the app; keep what is there.
        trace_id = coalesce(e.trace_id, r->>'trace_id'), span_id = coalesce(e.span_id, r->>'span_id'),
        task_id = coalesce(e.task_id, (r->>'task_id')::uuid), agent_slug = coalesce(e.agent_slug, r->>'agent_slug'),
        tool = coalesce(e.tool, r->>'tool'), provider = coalesce(e.provider, r->>'provider'),
        model = coalesce(e.model, r->>'model'), mcp_tool = coalesce(e.mcp_tool, r->>'mcp_tool'),
        container = coalesce(e.container, r->>'container'),
        -- Host PID and process name come from the capture's /proc lookup.
        pid = CASE WHEN r->>'source' = 'capture' THEN coalesce((r->>'pid')::int, e.pid) ELSE coalesce(e.pid, (r->>'pid')::int) END,
        process = CASE WHEN r->>'source' = 'capture' THEN coalesce(r->>'process', e.process) ELSE coalesce(e.process, r->>'process') END,
        src_ip = coalesce(e.src_ip, r->>'src_ip'), src_port = coalesce(e.src_port, r_src_port),
        dst_ip = coalesce(e.dst_ip, r->>'dst_ip'), dst_port = coalesce(e.dst_port, (r->>'dst_port')::int),
        dst_host = CASE WHEN r->>'source' = 'app' THEN coalesce(r->>'dst_host', e.dst_host) ELSE coalesce(e.dst_host, r->>'dst_host') END,
        protocol = CASE WHEN r->>'source' = 'app' THEN coalesce(r->>'protocol', e.protocol) ELSE coalesce(e.protocol, r->>'protocol') END,
        kind = CASE WHEN r->>'kind' = 'http' THEN 'http' ELSE e.kind END,
        method = coalesce(e.method, r->>'method'), path = coalesce(e.path, r->>'path'),
        status_code = coalesce(e.status_code, (r->>'status_code')::int),
        -- Bytes on the wire (capture) are preferred over HTTP body sizes.
        bytes_sent = CASE WHEN r->>'source' = 'capture' THEN coalesce((r->>'bytes_sent')::bigint, e.bytes_sent) ELSE coalesce(e.bytes_sent, (r->>'bytes_sent')::bigint) END,
        bytes_recv = CASE WHEN r->>'source' = 'capture' THEN coalesce((r->>'bytes_recv')::bigint, e.bytes_recv) ELSE coalesce(e.bytes_recv, (r->>'bytes_recv')::bigint) END,
        outcome = CASE WHEN ai_traffic_outcome_rank(coalesce(r->>'outcome', 'ok')) > ai_traffic_outcome_rank(e.outcome)
                       THEN coalesce(r->>'outcome', 'ok') ELSE e.outcome END,
        reason = CASE WHEN ai_traffic_outcome_rank(coalesce(r->>'outcome', 'ok')) > ai_traffic_outcome_rank(e.outcome)
                      THEN coalesce(r->>'reason', e.reason) ELSE coalesce(e.reason, r->>'reason') END,
        rule_id = coalesce(e.rule_id, r->>'rule_id'),
        detail = e.detail || coalesce(r->'detail', '{}'::jsonb)
      WHERE e.id = hit;
    END IF;
  END LOOP;
  RETURN merged;
END
$$;
"""


def upgrade() -> None:
    op.create_table(
        "ai_traffic_events",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True)),
        sa.Column("duration_ms", sa.Integer),
        sa.Column("ttfb_ms", sa.Integer),
        sa.Column("node", sa.String(100)),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("sources", ARRAY(sa.Text), nullable=False),
        sa.Column("obs_keys", ARRAY(sa.Text), nullable=False),
        sa.Column("observations", JSONB, nullable=False, server_default="[]"),
        sa.Column("trace_id", sa.String(32)),
        sa.Column("span_id", sa.String(16)),
        sa.Column("task_id", UUID(as_uuid=True)),
        sa.Column("agent_slug", sa.String(50)),
        sa.Column("tool", sa.String(100)),
        sa.Column("provider", sa.String(40)),
        sa.Column("model", sa.String(200)),
        sa.Column("mcp_tool", sa.String(100)),
        sa.Column("container", sa.String(120)),
        sa.Column("pid", sa.Integer),
        sa.Column("process", sa.String(200)),
        sa.Column("src_ip", sa.String(45)),
        sa.Column("src_port", sa.Integer),
        sa.Column("dst_ip", sa.String(45)),
        sa.Column("dst_port", sa.Integer),
        sa.Column("dst_host", sa.String(253)),
        sa.Column("protocol", sa.String(20)),
        sa.Column("method", sa.String(12)),
        sa.Column("path", sa.String(500)),
        sa.Column("status_code", sa.Integer),
        sa.Column("bytes_sent", sa.BigInteger),
        sa.Column("bytes_recv", sa.BigInteger),
        sa.Column("outcome", sa.String(24), nullable=False, server_default="ok"),
        sa.Column("reason", sa.String(500)),
        sa.Column("rule_id", sa.String(120)),
        sa.Column("detail", JSONB, nullable=False, server_default="{}"),
    )
    op.execute(
        "ALTER TABLE ai_traffic_events ADD COLUMN search tsvector GENERATED ALWAYS AS (to_tsvector('simple', "
        "coalesce(agent_slug,'') || ' ' || coalesce(tool,'') || ' ' || coalesce(mcp_tool,'') || ' ' || coalesce(model,'') || ' ' || "
        "coalesce(provider,'') || ' ' || coalesce(dst_host,'') || ' ' || coalesce(dst_ip,'') || ' ' || coalesce(path,'') || ' ' || "
        "coalesce(reason,'') || ' ' || coalesce(process,'') || ' ' || coalesce(container,'') || ' ' || coalesce(protocol,'') || ' ' || "
        "coalesce(outcome,''))) STORED"
    )
    op.create_index("ix_ai_traffic_events_ts", "ai_traffic_events", ["ts"])
    op.create_index("ix_ai_traffic_events_outcome_ts", "ai_traffic_events", ["outcome", "ts"])
    op.create_index("ix_ai_traffic_events_agent_ts", "ai_traffic_events", ["agent_slug", "ts"])
    op.create_index("ix_ai_traffic_events_trace", "ai_traffic_events", ["trace_id"])
    op.create_index("ix_ai_traffic_events_task", "ai_traffic_events", ["task_id"])
    op.create_index("ix_ai_traffic_events_dst", "ai_traffic_events", ["node", "dst_ip", "dst_port", "ts"])
    op.create_index("ix_ai_traffic_events_obs", "ai_traffic_events", ["obs_keys"], postgresql_using="gin")
    op.create_index("ix_ai_traffic_events_search", "ai_traffic_events", ["search"], postgresql_using="gin")

    op.create_table(
        "ai_trace_spans",
        sa.Column("span_id", sa.String(16), primary_key=True),
        sa.Column("trace_id", sa.String(32), nullable=False, index=True),
        sa.Column("parent_span_id", sa.String(16)),
        sa.Column("task_id", UUID(as_uuid=True), index=True),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("agent_slug", sa.String(50)),
        sa.Column("node", sa.String(100)),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False, index=True),
        sa.Column("ended_at", sa.DateTime(timezone=True)),
        sa.Column("duration_ms", sa.Integer),
        sa.Column("status", sa.String(20)),
        sa.Column("attributes", JSONB, nullable=False, server_default="{}"),
    )
    op.create_table(
        "ai_traffic_sources",
        sa.Column("name", sa.String(120), primary_key=True),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("node", sa.String(100)),
        sa.Column("last_seen", sa.DateTime(timezone=True)),
        sa.Column("last_event_at", sa.DateTime(timezone=True)),
        sa.Column("stats", JSONB, nullable=False, server_default="{}"),
    )
    op.create_table(
        "ai_traffic_captures",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("node", sa.String(100), nullable=False),
        sa.Column("requested_by", sa.String(100), nullable=False),
        sa.Column("requested_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("seconds", sa.Integer, nullable=False),
        sa.Column("max_bytes", sa.Integer, nullable=False),
        sa.Column("filter", JSONB, nullable=False, server_default="{}"),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("packets", sa.Integer),
        sa.Column("size", sa.Integer),
        sa.Column("error", sa.String(300)),
        sa.Column("data", sa.LargeBinary),
        sa.Column("expires_at", sa.DateTime(timezone=True)),
    )
    op.create_table(
        "ai_traffic_settings",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("retention_days", sa.Integer, nullable=False, server_default="30"),
        sa.Column("capture_retention_hours", sa.Integer, nullable=False, server_default="24"),
        sa.Column("updated_by", sa.String(100)),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.execute("INSERT INTO ai_traffic_settings (id) VALUES (1)")
    op.execute(INGEST_FUNCTION)


def downgrade() -> None:
    op.execute("DROP FUNCTION IF EXISTS ai_traffic_ingest(jsonb)")
    op.execute("DROP FUNCTION IF EXISTS ai_traffic_outcome_rank(text)")
    for table in ("ai_traffic_settings", "ai_traffic_captures", "ai_traffic_sources", "ai_trace_spans", "ai_traffic_events"):
        op.drop_table(table)
