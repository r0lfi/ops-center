import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiGet, apiSend } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ToolPicker } from "./MCPAccess";

type Consent = { client_name: string; client_id: string; redirect_uri: string; resource: string;
  tools: { name: string; description: string; scope: string; minimum_role: string; method: string }[] };

export default function MCPConsent() {
  const [params] = useSearchParams();
  const requestId = params.get("request");
  const [data, setData] = useState<Consent | null>(null);
  const [tools, setTools] = useState<string[]>([]);
  const [days, setDays] = useState(1);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setData(null); setTools([]); setError("");
    if (!requestId) { setError("Missing authorization request."); return; }
    let active = true;
    void apiGet<Consent>("/api/mcp/consent/" + encodeURIComponent(requestId)).then(d => { if (active) setData(d); })
      .catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [requestId]);
  async function decide(approve: boolean) {
    setBusy(true); setError("");
    try {
      const result = await apiSend<{ redirect_url: string }>("/api/mcp/consent/" + encodeURIComponent(requestId ?? ""), "POST",
        { approve, allowed_tools: tools, days });
      window.location.assign(result.redirect_url);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }
  return <main className="mx-auto max-w-3xl space-y-5 p-6">
    <h1 className="text-2xl font-semibold">Authorize an MCP client</h1>
    <p className="text-muted-foreground">Grant access only to a client you intended to connect. Your Ops Center password is never shared with the client.</p>
    {error && <p role="alert" className="rounded border p-3">{error}</p>}
    {data && <>
      <div className="space-y-2 rounded-xl border p-4"><h2 className="text-xl font-medium">{data.client_name}</h2>
        <p className="break-all text-sm">Client ID: <code>{data.client_id}</code></p>
        <p className="break-all text-sm">Resource: {data.resource}</p>
        <p className="break-all text-sm">Return to: {data.redirect_uri}</p></div>
      <p>Select the tools this client may use as you. Your current role still applies. Every change requires a separate human approval in Ops Center.</p>
      <ToolPicker tools={data.tools} selected={tools} onChange={setTools} />
      <div className="text-sm"><label htmlFor="mcp-duration">Authorization duration</label>
        <select id="mcp-duration" className="ml-3 rounded border bg-background p-2" value={days} onChange={e => setDays(Number(e.target.value))}>
          <option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option>
        </select></div>
      <p className="text-sm text-muted-foreground">You can revoke access at any time in MCP access. Access tokens expire after 10 minutes; refresh requires this authorization to remain valid.</p>
      <div className="flex gap-3"><Button disabled={busy || !tools.length} onClick={() => void decide(true)}>Authorize selected tools</Button>
        <Button variant="outline" disabled={busy} onClick={() => void decide(false)}>Deny</Button></div>
    </>}
  </main>;
}
