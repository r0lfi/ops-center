"""AI Traffic Monitor: merge a failed connection seen by both sources.

A connect that fails (refused, rejected, timed out, TLS) never gives the
worker its local port, so 0061 joined it only with another failed
observation. The capture's observation of the same SYN is not failed yet
when it arrives (the ICMP error or the conntrack expiry come later), so the
two stayed separate rows. Now an observation without a source port joins the
nearest observation of the same node and destination from the other source
within 10 s. Function change only; no table changes.

Revision ID: 0062
Revises: 0061
Create Date: 2026-11-14
"""
import importlib.util
from pathlib import Path

from alembic import op

revision = "0062"
down_revision = "0061"
branch_labels = None
depends_on = None

INGEST_FUNCTION = r"""
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
         -- A failed connect has no local port on the worker's side; the wire side has one.
         AND (e.src_port = r_src_port OR e.src_port IS NULL OR r_src_port IS NULL)
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


def _previous():
    spec = importlib.util.spec_from_file_location("m0061", Path(__file__).with_name("0061_ai_traffic_monitor.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.INGEST_FUNCTION


def upgrade() -> None:
    op.execute(INGEST_FUNCTION)


def downgrade() -> None:
    op.execute(_previous())
