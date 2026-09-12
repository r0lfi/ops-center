import { useEffect, useState } from "react";
import { ShieldAlert, ChevronDown, ChevronUp } from "lucide-react";
import { api } from "@/lib/api";

export interface AuthenticationBannerData {
  enabled?:boolean;now:number;last_success:number|null;error:string|null;
  sources:{name:string;label?:string;last_success:number|null;error:string|null}[];
  alerts:{id:number;title:string;severity:string;domain:string;ip:string;last_seen:number;evidence:Record<string,unknown>;notified_at:number|null}[];
  observations:{id:number;ts:number;ip:string;country:string|null;domain:string;kind:string;outcome:string}[];
}
const labels:Record<string,string>={login_success:"Login accepted",login_failure:"Login rejected",login_limited:"Rate limited",login_attempt:"Authentication not completed"};
const date=(ts:number)=>new Date(ts*1000).toLocaleString();
export function AuthenticationBanner(){
  const [collapsed,setCollapsed]=useState(()=>{try{return localStorage.getItem("traffic-auth-collapsed")==="true"}catch{return false}});
  function toggle(){setCollapsed(value=>{try{localStorage.setItem("traffic-auth-collapsed",String(!value))}catch{/* Storage can be unavailable. */}return !value})}
  const [data,setData]=useState<AuthenticationBannerData|null>(null);
  const [error,setError]=useState<string|null>(null);
  useEffect(()=>{
    let cancelled=false;let timer:ReturnType<typeof setTimeout>;
    async function load(){
      try{const next=await api.traffic.authenticationBanner();if(!cancelled){setData(next);setError(null)}}
      catch(e){if(!cancelled)setError(e instanceof Error?e.message:"Authentication monitoring unavailable")}
      finally{if(!cancelled)timer=setTimeout(load,3000)}
    }
    void load();return()=>{cancelled=true;clearTimeout(timer)};
  },[]);
  const high=data?.alerts?.some(a=>a.severity==="high");
  const warning=data?.alerts?.length;
  const sources=data?.sources??[];
  const unavailable=error||data?.error||(data?.last_success&&Date.now()/1000-data.last_success>30?"Analysis is delayed":null);
  const sourceErrors=sources.filter(s=>s.error||!s.last_success||Date.now()/1000-s.last_success>60).map(s=>s.label??s.name);
  if (data?.enabled === false) return null;

  return <aside aria-label="Live authentication notices" className={"traffic-auth-banner "+(high?"high":warning?"warning":"")+(collapsed?" is-collapsed":"")}>
    <div className="traffic-auth-banner-title">
      <strong><ShieldAlert size={15}/><span>{high?"High priority authentication alert":warning?"Authentication alert":"Authentication"}</span>{warning?<span className="traffic-auth-count">{warning}</span>:null}</strong>
      <div className="traffic-auth-actions"><a href="?service=all#traffic-security">Security log</a><button type="button" onClick={toggle} aria-expanded={!collapsed} aria-controls="traffic-auth-details" aria-label={collapsed?"Expand authentication notices":"Minimize authentication notices"}>{collapsed?<ChevronDown size={16}/>:<ChevronUp size={16}/>}</button></div>
    </div>
    {(unavailable||sourceErrors.length>0)&&<p role="alert">{unavailable||"Some authentication sources are unavailable"}{sourceErrors.length>0&&" · "+sourceErrors.join(", ")}. Last received observations may be incomplete.</p>}
    <div id="traffic-auth-details" hidden={collapsed}>
      <div className="traffic-auth-rows" aria-live="polite">
        {data?.alerts?.slice(0,3).map(a=><div key={a.id} className="traffic-auth-notice"><strong>{a.title}</strong><span>{a.domain} · {a.ip} · {String(a.evidence.country??"Unknown")}</span><time title={date(a.last_seen)}>{new Date(a.last_seen*1000).toLocaleTimeString()}</time></div>)}
        {data?.observations?.slice(0,data?.alerts?.length?1:3).map(e=><div key={e.id} className="traffic-auth-observation"><strong>{labels[e.outcome]??e.outcome}</strong><span>{e.kind==="ssh"?"SSH · ":""}{e.domain} · {e.ip} · {e.country??"Unknown"}</span><time title={date(e.ts)}>{new Date(e.ts*1000).toLocaleTimeString()}</time></div>)}
      </div>
      {!data?.alerts?.length&&!data?.observations?.length&&<p>{data?"No recent authentication activity.":"Connecting to authentication monitoring…"}</p>}
      <small>All services · Live activity: 5 min · Unreviewed alerts: 24 h · Full history in security log</small>
    </div>
  </aside>;
}
