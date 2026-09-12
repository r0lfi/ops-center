import { useEffect, useState } from "react";
import { ShieldAlert, Check, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";

export interface SecurityAlert {
  id:number; rule:string; title:string; severity:string; domain:string; ip:string;
  count:number; created_at:number; last_seen:number; evidence:Record<string,unknown>;
  reviewed_at:number|null; reviewed_by:string|null; notified_at:number|null;
}
export interface SecurityData {
  now:number; total:number; unreviewed:number; last_success:number|null; error:string|null;
  started_at:number|null; baseline_ready:boolean; notification_error:string|null; talk_enabled:boolean;
  auth_total:number; auth_offset:number; auth_started_at:number|null;
  auth_policy:{countries:string[];dns_names:string[];addresses:string[];checked_at:number|null;error:string|null};
  authentication:{id:number;ts:number;ip:string;domain:string;country:string|null;status:number|null;outcome:string;origin_reason:string|null}[];
  alerts:SecurityAlert[]; logins:{ts:number;ip:string;domain:string;country:string|null}[];
}
const outcomes:Record<string,string>={login_attempt:"Authentication not completed",login_success:"Login accepted",login_failure:"Login rejected",login_limited:"Rate limited",vpn_handshake:"Authenticated VPN handshake"};
const date=(ts:number)=>new Date(ts*1000).toLocaleString();
export function SecuritySignals({service,hours}:{service:string;hours:number}) {
  const [data,setData]=useState<SecurityData|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [authResult,setAuthResult]=useState("all");
  const [authOffset,setAuthOffset]=useState(0);
  const [revision,setRevision]=useState(0);
  const [pending,setPending]=useState<number|null>(null);
  useEffect(()=>{setAuthOffset(0)},[service,hours]);
  useEffect(()=>{
    let cancelled=false;let timer:ReturnType<typeof setTimeout>;
    async function load(){
      try{
        const result=await api.traffic.security(service,hours,authResult,authOffset);
        if(!cancelled){setData(result);setError(null)}
      }catch(e){if(!cancelled)setError(e instanceof Error?e.message:"Security analysis unavailable")}
      finally{if(!cancelled)timer=setTimeout(load,5000)}
    }
    void load();return()=>{cancelled=true;clearTimeout(timer)};
  },[service,hours,revision,authResult,authOffset]);
  async function review(id:number){
    setPending(id);
    try{await api.traffic.reviewSecurity(id);setRevision(v=>v+1)}
    catch(e){setError(e instanceof Error?e.message:"Could not mark as reviewed")}
    finally{setPending(null)}
  }
  const healthy=data?.last_success!=null&&!data.error&&Date.now()/1000-data.last_success<60;
  return <section id="traffic-security" className="traffic-panel traffic-security">
    <div className="traffic-security-heading"><h2><ShieldAlert size={17}/> Security signals <span>{data?.unreviewed??"—"} to review</span></h2><button aria-label="Refresh security signals" onClick={()=>setRevision(v=>v+1)}><RefreshCw size={14}/></button></div>
    <div className="traffic-security-status"><span className={healthy?"traffic-healthy":"traffic-error"}>{error?"View unavailable":healthy?"Detection running":"Detection unavailable / starting"}</span><span>{data?.baseline_ready?"Traffic baseline ready":"Learning traffic baseline (65 minutes)"}</span><span>{data?.talk_enabled?"Talk alerts enabled":"Talk alerts disabled"}</span></div>
    {(error||data?.error||data?.notification_error)&&<p className="traffic-alert" role="alert">{error||data?.error||data?.notification_error}</p>}
    <p className="traffic-footnote">Signals need investigation; they do not prove a break-in. New IPs may be mobile networks or travel. Analysis continues independently of the map pause button. Showing up to 100 signals for the selected service and period.</p>
    <div className="traffic-security-list">
      {data?.alerts.map(a=><article key={a.id} className={"traffic-security-item "+(a.reviewed_at?"is-reviewed":a.severity)}>
        <div className="traffic-security-item-top"><strong>{a.title}</strong><span className="traffic-security-badge">{a.reviewed_at?"Reviewed":a.severity==="high"?"High priority":"Review"}</span></div>
        <div className="traffic-security-details"><span>{a.domain}</span><span className="traffic-ip">{a.ip==="multiple"?"Multiple clients":a.ip}</span><span>{String(a.evidence.country??"")}</span><span>{a.count} observations</span><span>Last seen {date(a.last_seen)}</span></div>
        <p>{String(a.evidence.note??"Review the matching observations.")}</p>
        <div className="traffic-security-item-bottom"><small>{a.notified_at?"Sent to Talk "+date(a.notified_at):a.reviewed_at?"Reviewed before notification":"Talk notification pending"}{a.reviewed_by?" · Reviewed by "+a.reviewed_by:""}</small>{!a.reviewed_at&&<button disabled={pending===a.id} onClick={()=>void review(a.id)}><Check size={13}/>{pending===a.id?"Saving…":"Mark reviewed"}</button>}</div>
      </article>)}
      {data&&!data.alerts.length&&<p className="traffic-empty">No signals recorded for this selection. This is not a guarantee that every attack would be detected.</p>}
    </div>
    <details className="traffic-security-logins" open><summary>Authentication log · {data?.auth_total??0} observations</summary>
      <p className="traffic-footnote">Jellyfin and VPN admin responses, Example application admin audit, OpenSSH authentication, and authenticated WireGuard handshakes. Ordinary HTTP 200 responses are not logins. A rejected request may be a proxy denial or rate limit. Existing sessions, stolen tokens and direct/internal access are not covered.</p>
      {data?.auth_policy&&<p className="traffic-footnote">Allowed origins: {data.auth_policy.countries.join(", ")||"No countries configured"}. Dynamic DNS: {data.auth_policy.dns_names.join(", ")||"Not configured"}{data.auth_policy.addresses.length>0&&" → "+data.auth_policy.addresses.join(", ")}. {data.auth_policy.checked_at&&"Last checked "+date(data.auth_policy.checked_at)+". "}SSH trusts only current DNS addresses, regardless of country. Origin labels use the current policy; location does not identify the user.</p>}
      {data?.auth_policy?.error&&<p role="alert" className="traffic-alert">{data.auth_policy.error}. Unresolved addresses are not exempt from alerts.</p>}
      <label>Result <select aria-label="Authentication result" value={authResult} onChange={e=>{setAuthResult(e.target.value);setAuthOffset(0)}}><option value="all">All observations</option><option value="failed">Rejected / incomplete / rate limited</option><option value="success">Successful logins</option><option value="vpn">VPN handshakes</option></select></label>
      <div className="traffic-table-scroll"><table aria-label="Authentication log"><thead><tr><th>Observed</th><th>Result</th><th>Client</th><th>Country / origin</th><th>Service</th></tr></thead><tbody>{data?.authentication?.map(e=><tr key={e.id}><td>{date(e.ts)}</td><td>{outcomes[e.outcome]??e.outcome}{e.status!=null&&<span>HTTP {e.status}</span>}</td><td className="traffic-ip">{e.ip}</td><td>{e.country??"Unknown"}<span>{e.origin_reason??"Outside allowed origins"}</span></td><td>{e.domain}</td></tr>)}</tbody></table></div>
      {data&&!data.authentication?.length&&<p className="traffic-empty">No classified authentication observations in this selection.</p>}
      <div className="traffic-security-item-bottom"><button disabled={authOffset===0} onClick={()=>setAuthOffset(v=>Math.max(0,v-20))}>Previous log page</button><small>{data?.auth_total?Math.min(authOffset+1,data.auth_total):0}–{Math.min(authOffset+20,data?.auth_total??0)} of {data?.auth_total??0}</small><button disabled={authOffset+20>=(data?.auth_total??0)} onClick={()=>setAuthOffset(v=>v+20)}>Next log page</button></div>
      <p className="traffic-footnote">WireGuard does not provide a failed password-login log for tunnel packets. Handshakes include periodic rekeys, not just new connections. Failed and successful VPN web-admin logins are logged separately.</p>
    </details>
    <details className="traffic-security-rules"><summary>Detection rules and coverage</summary><ul>
      <li>Every classified rejected or rate-limited application login: warning, including allowed origins.</li>
      <li>Successful login outside allowed countries and current trusted DNS addresses: high priority, even for a previously seen IP. Unknown locations are not exempt. Rules begin at activation, without historical alert replay.</li>
      <li>SSH: only accepted logins are collected. Success outside the current trusted VPN DNS addresses is high priority, including other Norwegian addresses.</li>
      <li>Authenticated WireGuard handshakes outside allowed origins: high priority, grouped per endpoint for one hour to limit rekey noise.</li>
      <li>Authentication alerts go to Talk on the next delivery pass, high priority first (normally within 5–10 seconds of collection). Other traffic signals retain a one-minute digest. Repeated submissions can be grouped. A new application login after delivery creates a new pending alert.</li>
      <li>10 rejected or rate-limited login requests from one IP in 5 minutes.</li>
      <li>30 rejected login requests from at least 5 IPs in 5 minutes.</li>
      <li>Successful application login after 5 rejections from the same IP within 15 minutes: high priority.</li>
      <li>20 recognized sensitive-path probes in 5 minutes, or 100 HTTP errors with at least a 50% error rate.</li>
      <li>At least 300 requests in 5 minutes and over 5 times the preceding-hour baseline, after 65 minutes of observation.</li>
      <li>External proxy traffic, Example application admin audit, the VPS SSH journal and successful WireGuard handshakes. Failed VPN packets, host intrusions and token theft require additional telemetry. No automatic blocking.</li>
    </ul></details>
  </section>;
}
