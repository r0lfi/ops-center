import { useEffect, useState } from "react";
import { api, type Host, type TrafficSettingsConfig, type TrafficSourceConfig } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

const formats: [TrafficSourceConfig["kind"], string][] = [
  ["npm", "Nginx Proxy Manager access log"],
  ["caddy", "Caddy JSON access log"],
  ["ssh", "OpenSSH systemd journal"],
  ["auth_audit", "Application authentication JSONL"],
  ["wireguard", "WireGuard authenticated handshakes"],
];
const splitList = (value: string) => value.split(",").map(v => v.trim()).filter(Boolean);

/** Server choices reference managed hosts; this form never handles secret material. */
export function TrafficSettingsPanel() {
  const [config, setConfig] = useState<TrafficSettingsConfig | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [countries, setCountries] = useState("");
  const [trustedDns, setTrustedDns] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const [settings, servers] = await Promise.all([api.traffic.settings(), api.hosts.list()]);
      setConfig(settings);
      setHosts(servers);
      setCountries(settings.allowed_countries.join(", "));
      setTrustedDns(settings.trusted_dns.join(", "));
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load traffic settings"); }
  }
  useEffect(() => { void load(); }, []);

  function updateSource(index: number, patch: Partial<TrafficSourceConfig>) {
    setConfig(current => current && ({ ...current, sources: current.sources.map((s, i) => i === index ? { ...s, ...patch } : s) }));
    setNotice(null);
  }
  function addSource() {
    if (!config) return;
    let number = config.sources.length + 1;
    while (config.sources.some(s => s.id === `source-${number}`)) number++;
    const source: TrafficSourceConfig = {
      id: `source-${number}`, label: "New source", host_id: hosts[0]?.id ?? "", kind: "npm",
      enabled: true, use_sudo: true, log_path: "", domain: "", application: "generic",
      auth_domains: [], container: "", interface: "wg0", journal_unit: "sshd", ssh_failures: false,
    };
    setConfig({ ...config, sources: [...config.sources, source] });
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!config) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const saved = await api.traffic.updateSettings({ ...config, allowed_countries: splitList(countries), trusted_dns: splitList(trustedDns) });
      setConfig(saved);
      setNotice("Settings saved. Collectors reconcile within 10 seconds; a running read may take up to 30 seconds to finish.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save traffic settings"); }
    finally { setSaving(false); }
  }

  return <Card id="traffic-settings">
    <CardHeader><CardTitle>Traffic Map & authentication</CardTitle></CardHeader>
    <CardContent>
      {error && <p className="mb-4 text-sm text-red-400" role="alert">{error}</p>}
      {notice && <p className="mb-4 text-sm text-emerald-400" role="status">{notice}</p>}
      {!config ? <Button onClick={() => void load()}>Load traffic settings</Button> : <form onSubmit={save} className="space-y-5">
        <p className="text-sm text-muted-foreground">Register servers and complete SSH onboarding first. Each source uses that server’s managed credential and verified host key. Collection runs on the backend even when this page is closed.</p>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={config.enabled} onChange={e => setConfig({ ...config, enabled: e.target.checked })}/> Enable traffic collection and security analysis</label>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-1 text-sm"><span>Trusted countries for application/VPN logins</span><Input aria-label="Trusted countries for application/VPN logins" aria-describedby="traffic-countries-help" value={countries} onChange={e => setCountries(e.target.value)} placeholder="Comma-separated English country names"/><span id="traffic-countries-help" className="block text-xs text-muted-foreground">Empty means no country exemption. Country exemptions never apply to SSH.</span></label>
          <label className="space-y-1 text-sm"><span>Trusted dynamic DNS hostnames</span><Input aria-label="Trusted dynamic DNS hostnames" aria-describedby="traffic-dns-help" value={trustedDns} onChange={e => setTrustedDns(e.target.value)} placeholder="vpn.example.com"/><span id="traffic-dns-help" className="block text-xs text-muted-foreground">Only current public A/AAAA addresses are trusted. DNS failures remove the exemption.</span></label>
          <label className="space-y-1 text-sm"><span>History retention (days)</span><Input type="number" min={1} max={365} required value={config.retention_days} onChange={e => setConfig({ ...config, retention_days: Number(e.target.value) })}/></label>
          <label className="space-y-1 text-sm"><span>Maximum saved observations</span><Input type="number" min={1000} max={5000000} required value={config.max_rows} onChange={e => setConfig({ ...config, max_rows: Number(e.target.value) })}/></label>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={config.notify_authentication} onChange={e => setConfig({ ...config, notify_authentication: e.target.checked })}/> Send authentication alerts to configured administrator Talk rooms</label>
        <p className="text-xs text-muted-foreground">Talk delivery requires a configured Talk integration and administrator room bindings. A successful login outside trusted origins has high priority. HTTP 200 alone is not proof of a login.</p>
        {config.sources.map((source, index) => <fieldset key={index} className="space-y-3 rounded-lg border border-border p-4">
          <legend className="px-2 text-sm font-medium">{source.label || `Source ${index + 1}`}</legend>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-sm"><span>Source ID</span><Input aria-label="Source ID" aria-describedby={`traffic-source-${index}-id-help`} required pattern="[a-z](?:[a-z0-9_]|-){0,31}" maxLength={32} value={source.id} onChange={e => updateSource(index, { id: e.target.value })}/><span id={`traffic-source-${index}-id-help`} className="block text-xs text-muted-foreground">Stable history/filter identity; use a new ID when replacing a source.</span></label>
            <label className="space-y-1 text-sm"><span>Display name</span><Input required maxLength={80} value={source.label} onChange={e => updateSource(index, { label: e.target.value })}/></label>
            <label className="space-y-1 text-sm"><span>Registered server</span><Select required value={source.host_id} onChange={e => updateSource(index, { host_id: e.target.value })}><option value="">Select a server</option>{hosts.map(host => <option key={host.id} value={host.id}>{host.hostname}</option>)}</Select></label>
            <label className="space-y-1 text-sm"><span>Log format</span><Select value={source.kind} onChange={e => updateSource(index, { kind: e.target.value as TrafficSourceConfig["kind"], application: "generic", auth_domains: [] })}>{formats.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></label>
            {["npm", "caddy", "auth_audit"].includes(source.kind) && <label className="space-y-1 text-sm"><span>Absolute log path or glob</span><Input required value={source.log_path} onChange={e => updateSource(index, { log_path: e.target.value })} placeholder="/var/log/caddy/access.log"/></label>}
            {["ssh", "auth_audit", "wireguard"].includes(source.kind) && <label className="space-y-1 text-sm"><span>Service hostname</span><Input required={source.kind !== "ssh"} value={source.domain} onChange={e => updateSource(index, { domain: e.target.value })} placeholder="app.example.com"/></label>}
            {source.kind === "npm" && <>
              <label className="space-y-1 text-sm"><span>Verified authentication contract</span><Select value={source.application} onChange={e => updateSource(index, { application: e.target.value as TrafficSourceConfig["application"] })}><option value="generic">Generic HTTP (no login success inference)</option><option value="jellyfin">Jellyfin</option><option value="wg_easy">wg-easy session API</option></Select></label>
              {source.application !== "generic" && <label className="space-y-1 text-sm"><span>Authentication hostnames (comma-separated)</span><Input required value={source.auth_domains.join(",")} onChange={e => updateSource(index, { auth_domains: e.target.value.split(",") })} placeholder="media.example.com"/></label>}
            </>}
            {source.kind === "ssh" && <label className="space-y-1 text-sm"><span>Systemd journal unit</span><Input required value={source.journal_unit} onChange={e => updateSource(index, { journal_unit: e.target.value })} placeholder="sshd or ssh"/></label>}
            {source.kind === "wireguard" && <>
              <label className="space-y-1 text-sm"><span>Docker container (empty for host)</span><Input value={source.container} onChange={e => updateSource(index, { container: e.target.value })}/></label>
              <label className="space-y-1 text-sm"><span>WireGuard interface</span><Input required value={source.interface} onChange={e => updateSource(index, { interface: e.target.value })}/></label>
            </>}
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={source.enabled} onChange={e => updateSource(index, { enabled: e.target.checked })}/> Enabled</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={source.use_sudo} onChange={e => updateSource(index, { use_sudo: e.target.checked })}/> Run reader with non-interactive sudo</label>
            {source.kind === "ssh" && <label className="flex items-center gap-2"><input type="checkbox" checked={source.ssh_failures} onChange={e => updateSource(index, { ssh_failures: e.target.checked })}/> Include failed SSH authentication (may be noisy)</label>}
            <Button type="button" variant="outline" onClick={() => setConfig({ ...config, sources: config.sources.filter((_, i) => i !== index) })}>Remove source</Button>
          </div>
        </fieldset>)}
        <p className="text-xs text-muted-foreground">Set destination coordinates on each server’s details page. GeoIP requires a local MaxMind-compatible database. New sources start monitoring new activity; configuration changes do not replay historical login alerts.</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={!hosts.length || config.sources.length >= 32 || saving} onClick={addSource}>Add traffic source</Button>
          <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save traffic settings"}</Button>
          <Button type="button" variant="outline" disabled={saving} onClick={() => void load()}>Reload saved settings</Button>
        </div>
        {!hosts.length && <p className="text-sm text-muted-foreground">Add your first server under Servers before adding a source.</p>}
      </form>}
    </CardContent>
  </Card>;
}
