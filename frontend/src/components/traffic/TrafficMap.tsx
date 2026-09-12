import { useEffect, useMemo, useState } from "react";
import { Activity, ArrowDown, ArrowUp, Database, Globe2, Pause, Play, Radio, RefreshCw, Search, ShieldCheck, Wifi } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, PieChart, Pie, Cell } from "recharts";
import { useSearchParams } from "react-router-dom";
import { api, type TrafficHistory, type TrafficEvent } from "@/lib/api";
import { project } from "@/lib/mapProjection";
import "./traffic-map.css";
import { AuthenticationBanner } from "./AuthenticationBanner";
import { SecuritySignals } from "./SecuritySignals";

const COLORS = ["#38bdf8", "#fb7185", "#a78bfa"];
const number = (n: number) => new Intl.NumberFormat("en", { notation: n > 99999 ? "compact" : "standard" }).format(n);
const clock = (ts: number) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const date = (ts: number) => new Date(ts * 1000).toLocaleString();
const rangeOptions = [[1,"Last hour"],[24,"Last 24 hours"],[168,"Last 7 days"],[720,"Last 30 days"]] as const;

function ObservationsMap({data}: {data: TrafficHistory}) {
  const points = useMemo(() => {
    const groups = new Map<string, {event: TrafficEvent; count: number}>();
    for (const event of data.events) {
      if (event.lat == null || event.lon == null) continue;
      const key = [event.ip,event.source,event.kind].join("|");
      const point = groups.get(key);
      if (point) point.count++; else groups.set(key,{event,count:1});
    }
    return [...groups.values()].slice(0,100);
  }, [data.events]);
  return <div className="traffic-world">
    <svg viewBox="0 135 1024 590" role="img" aria-label="Geolocated traffic to configured servers">
      <defs><filter id="traffic-glow"><feGaussianBlur stdDeviation="2.5"/></filter>
        <radialGradient id="traffic-ocean"><stop stopColor="#142841"/><stop offset="1" stopColor="#07121f"/></radialGradient></defs>
      <rect x="0" y="135" width="1024" height="590" fill="url(#traffic-ocean)"/>
      <g className="traffic-tiles">{Array.from({length:16},(_,i)=><image key={i} href={"https://tile.openstreetmap.org/2/"+(i%4)+"/"+Math.floor(i/4)+".png"} x={(i%4)*256} y={Math.floor(i/4)*256} width="256" height="256"/>)}</g>
      <g opacity=".1" stroke="#78b5e0" strokeWidth=".6">{Array.from({length:12},(_,i)=><path key={i} d={"M "+i*93+" 135 V 725 M 0 "+(135+i*54)+" H 1024"}/>)}</g>
      {points.map(({event,count})=>{
        const from=project(event.lat!,event.lon!,2);const dest=data.destinations[event.source];
        const to=dest?project(dest.lat,dest.lon,2):null;
        const color=event.kind==="wireguard"?COLORS[2]:event.suspicious?COLORS[1]:COLORS[0];
        const key=event.ip+event.source+event.kind;
        return <g key={key}>
          <title>{event.ip+" · "+(event.country??"Location unavailable")+" · "+event.domain+" · "+count+" shown"}</title>
          {to&&<path d={"M "+from.x+" "+from.y+" Q "+((from.x+to.x)/2)+" "+(Math.min(from.y,to.y)-Math.min(100,Math.abs(to.x-from.x)/4+20))+" "+to.x+" "+to.y} fill="none" stroke={color} strokeWidth="1.4" opacity=".35"/>}
          <circle cx={from.x} cy={from.y} r={5+Math.min(7,Math.log2(count+1))} fill={color} opacity=".15"/>
          <circle cx={from.x} cy={from.y} r="3" fill={color}/>
        </g>;
      })}
      {Object.entries(data.destinations).map(([name,dest])=>{
        const p=project(dest.lat,dest.lon,2);
        return <g key={name}><title>{dest.label??name}</title>
          <circle cx={p.x} cy={p.y} r="11" fill="#fbbf24" opacity=".15"/>
          <circle cx={p.x} cy={p.y} r="4" fill="#fbbf24" stroke="#fff" strokeWidth="1"/>
          <text x={p.x+9} y={p.y-9} fill="#fef3c7" fontSize="13" fontWeight="600">{dest.label??name}</text>
        </g>;
      })}
    </svg>
    <div className="traffic-map-caption"><span><i style={{background:COLORS[0]}}/>HTTP / authentication</span><span><i style={{background:COLORS[1]}}/>Rejected / error</span><span><i style={{background:COLORS[2]}}/>VPN handshake</span></div>
    <a className="traffic-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a>
    {data.events.length===0&&<div className="traffic-map-empty">No observations in this view</div>}
  </div>;
}

export function TrafficMap() {
  const [params,setParams]=useSearchParams();
  const requestedHours=Number(params.get("hours")??24);const hours=[1,24,168,720].includes(requestedHours)?requestedHours:24;const requestedService=params.get("service")??"all";const service=/^[a-z][a-z0-9_-]{0,31}$/.test(requestedService)?requestedService:"all";const errors=params.get("errors")==="true";
  const [search,setSearch]=useState(params.get("search")??"");
  const [query,setQuery]=useState(search);
  const [data,setData]=useState<TrafficHistory|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [paused,setPaused]=useState(false);const [offset,setOffset]=useState(0);const [until,setUntil]=useState<number|undefined>();
  const [revision,setRevision]=useState(0);const [loading,setLoading]=useState(true);
  useEffect(()=>{const t=setTimeout(()=>setQuery(search),350);return()=>clearTimeout(t)},[search]);
  function filter(key:string,value:string) {
    const next=new URLSearchParams(params);next.set(key,value);setParams(next,{replace:true});
    setOffset(0);setUntil(undefined);setData(null);
  }
  useEffect(()=>{
    let cancelled=false;let timer:ReturnType<typeof setTimeout>;
    async function load() {
      setLoading(true);
      try {
        const result=await api.traffic.history({hours,service,errors,search:query,offset,until});
        if(!cancelled){setData(result);setError(null)}
      } catch(err){if(!cancelled)setError(err instanceof Error?err.message:"Traffic history is unavailable")}
      finally{if(!cancelled){setLoading(false);if(!paused)timer=setTimeout(load,5000)}}
    }
    void load();return()=>{cancelled=true;clearTimeout(timer)};
  },[hours,service,errors,query,offset,until,paused,revision]);
  const stats=data?.stats??{total:0,clients:0,countries:0,errors:0,handshakes:0,http:0,ssh:0};
  const parts=[{name:"Other observations",value:Math.max(0,stats.total-stats.handshakes-stats.errors)},{name:"Rejections / errors",value:stats.errors},{name:"VPN handshakes",value:stats.handshakes}];
  const healthy=data?.sources.filter(s=>!s.error&&s.last_success!=null&&data.now-s.last_success<60).length??0;
  const sourceCount=data?.sources.length??0;
  const allHealthy=sourceCount>0&&healthy===sourceCount;
  const serviceOptions=[["all","All services"],...(data?.sources??[]).map(s=>[s.name,s.label??s.name])];
  const metrics=[
    {label:"Observations",value:number(stats.total),icon:Activity,color:"#e2e8f0"},
    {label:"HTTP requests",value:number(stats.http??stats.total-stats.handshakes),icon:Globe2,color:COLORS[0]},
    {label:"VPN handshakes",value:number(stats.handshakes),icon:Wifi,color:COLORS[2]},
    {label:"External clients",value:number(stats.clients),icon:Radio,color:"#34d399"},
    {label:"Countries",value:number(stats.countries),icon:Globe2,color:"#fbbf24"},
    {label:"Rejections / errors",value:number(stats.errors),icon:ShieldCheck,color:COLORS[1]},
  ];
  function newer(){setOffset(Math.max(0,offset-100))}
  function older(){setPaused(true);setUntil(until??data?.now);setOffset(offset+100)}
  function resume(){setOffset(0);setUntil(undefined);setPaused(false);setRevision(r=>r+1)}
  return <div className="traffic-dashboard">
    <AuthenticationBanner/>
    <div className="traffic-toolbar">
      <div className="traffic-tabs" aria-label="Traffic service filter">{serviceOptions.map(([value,label])=><button key={value} aria-pressed={service===value} onClick={()=>filter("service",value)}>{label}</button>)}</div>
      <div className="traffic-actions">
        <label className="sr-only" htmlFor="traffic-range">Time period</label>
        <select id="traffic-range" value={hours} onChange={e=>filter("hours",e.target.value)}>{rangeOptions.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>
        <button onClick={()=>paused?resume():setPaused(true)} title={paused?"Resume live updates":"Pause view updates"}>{paused?<Play size={14}/>:<Pause size={14}/>} {paused?"Resume":"Pause"}</button>
        <button onClick={resume} aria-label="Refresh traffic history"><RefreshCw size={14} className={loading?"animate-spin":""}/></button>
      </div>
    </div>
    <div className="traffic-state">
      <span className={error?"traffic-error":paused?"traffic-muted":allHealthy?"traffic-healthy":"traffic-muted"}><i/>{error?"History unavailable":paused?"View paused":allHealthy?"Collectors live":data?.enabled===false?"Collection disabled":sourceCount===0?"No sources configured":"Connecting to sources"}</span>
      <span><Database size={12}/> Saved history · {data?.retention_days??30} days · up to {number(data?.max_rows??500000)} observations</span>
      {data&&<span>Updated {clock(data.now)}</span>}
    </div>
    {error&&<div className="traffic-alert" role="alert">{error}. Previously loaded history is still shown; retry with Refresh.</div>}
    {data&&(!data.enabled||!sourceCount)&&<div className="traffic-alert">Configure your servers and enable collection in <a href="/settings#traffic-settings">Settings → Traffic Map & authentication</a>. Saved history remains available.</div>}
    <div className="traffic-metrics">{metrics.map(m=><div key={m.label} className="traffic-metric"><div><span>{m.label}</span><m.icon size={14} color={m.color}/></div><strong style={{color:m.color}}>{loading&&!data?"—":m.value}</strong><small>{rangeOptions.find(r=>r[0]===hours)?.[1]??"Selected period"}</small></div>)}</div>
    <div className="traffic-main-grid">
      <section className="traffic-panel traffic-country-panel"><h2>Top countries <span>{stats.countries} observed</span></h2><div className="traffic-bars">{data?.countries.map((c,i)=><div key={c.name}><div><span>{c.name}</span><strong>{number(c.count)}</strong></div><div className="traffic-bar-track"><i style={{width:Math.max(2,c.count/(data.countries[0]?.count||1)*100)+"%",background:i===0?"#38bdf8":"#277897"}}/></div></div>)}{!data?.countries.length&&<p className="traffic-empty">No geolocated observations in this period.</p>}</div><p className="traffic-footnote">Locations are approximate. Unknown locations remain in the event list.</p></section>
      <section className="traffic-panel traffic-map-panel"><h2>External activity <span>Configured servers</span></h2>{data?<ObservationsMap data={data}/>:<div className="traffic-map-loading">Loading saved observations…</div>}<p className="traffic-footnote">Map shows the current event page. Counters cover the full selected period.</p></section>
      <section className="traffic-panel traffic-mix-panel"><h2>Observation mix</h2><div className="traffic-donut">{stats.total>0?<ResponsiveContainer width="100%" height={155}><PieChart><Pie data={parts.filter(p=>p.value>0)} dataKey="value" innerRadius={48} outerRadius={65} paddingAngle={3} stroke="none">{parts.filter(p=>p.value>0).map(p=><Cell key={p.name} fill={COLORS[parts.findIndex(x=>x.name===p.name)]}/>)}</Pie><Tooltip contentStyle={{background:"#0d1b2c",border:"1px solid #263b50",borderRadius:8,color:"#e2e8f0"}}/></PieChart></ResponsiveContainer>:<div className="traffic-empty-ring">No data</div>}</div><div className="traffic-mix-legend">{parts.map((p,i)=><div key={p.name}><i style={{background:COLORS[i]}}/><span>{p.name}</span><strong>{number(p.value)}</strong></div>)}</div></section>
    </div>
    <div className="traffic-secondary-grid">
      <section className="traffic-panel"><h2>Activity over time <span>All matching observations</span></h2><div className="traffic-timeline">{data&&data.timeline.length>0?<ResponsiveContainer width="100%" height="100%"><AreaChart data={data.timeline} margin={{top:10,right:15,left:0,bottom:0}}><defs><linearGradient id="traffic-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#38bdf8" stopOpacity={.35}/><stop offset="100%" stopColor="#38bdf8" stopOpacity={0}/></linearGradient></defs><CartesianGrid vertical={false} stroke="#233247" strokeDasharray="3 4"/><XAxis dataKey="ts" tickFormatter={v=>hours>24?new Date(v*1000).toLocaleDateString([],{month:"short",day:"numeric"}):new Date(v*1000).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})} axisLine={false} tickLine={false} minTickGap={60} tick={{fill:"#7893ad",fontSize:10}}/><Tooltip labelFormatter={v=>date(Number(v))} contentStyle={{background:"#0d1b2c",border:"1px solid #263b50",borderRadius:8}}/><Area type="monotone" dataKey="count" name="Observations" stroke="#38bdf8" strokeWidth={2} fill="url(#traffic-area)" isAnimationActive={false}/></AreaChart></ResponsiveContainer>:<div className="traffic-empty">Activity appears as observations are collected.</div>}</div></section>
      <section className="traffic-panel"><h2>Collection status <span>{healthy}/{sourceCount} current</span></h2><div className="traffic-source-list">{data?.sources.map(source=>{
        const ok=!source.error&&source.last_success!=null&&data!.now-source.last_success<60;
        return <div key={source.name}><i className={ok?"traffic-dot-ok":"traffic-dot-warn"}/><div><strong>{source.label??source.name}</strong><small>{source.error??source.warning??source.kind}</small></div><span>{ok?"Collecting":source.error?"Retrying":"Waiting"}</span></div>
      })}</div><p className="traffic-footnote">Collection continues while this page is closed or paused. VPN scans and failed UDP attempts are not available from WireGuard handshake data.</p></section>
    </div>
    <SecuritySignals service={service} hours={hours}/>
    <section className="traffic-panel traffic-events">
      <div className="traffic-table-toolbar"><h2>Event history <span>{number(stats.total)} matching</span></h2><div><label className="traffic-search"><Search size={14}/><input aria-label="Search traffic history" placeholder="Search IP, country or domain…" value={search} onChange={e=>{setSearch(e.target.value);setOffset(0);setUntil(undefined)}}/></label><label className="traffic-error-filter"><input type="checkbox" checked={errors} onChange={e=>filter("errors",String(e.target.checked))}/> Rejections / errors only</label></div></div>
      <div className="traffic-table-scroll"><table><thead><tr><th>Observed</th><th>Client</th><th>Location</th><th>Service</th><th>Observation</th><th>Result</th></tr></thead><tbody>{data?.events.map(e=><tr key={e.id}><td title={date(e.ts)}>{new Date(e.ts*1000).toLocaleDateString([],{month:"short",day:"numeric"})}<span>{clock(e.ts)}</span></td><td className="traffic-ip">{e.ip}</td><td>{e.country??"Unknown"}<span>{e.city??"Location unavailable"}</span></td><td>{e.domain}<span>{data.sources.find(s=>s.name===e.source)?.label??e.source}</span></td><td><span className={"traffic-kind "+(e.kind==="wireguard"?"traffic-vpn":"")}>{e.kind==="wireguard"?"VPN handshake":e.kind==="ssh"?"SSH authentication":e.signal?.startsWith("auth_")?"Login request":"HTTP request"}</span></td><td><span className={e.suspicious?"traffic-result-error":"traffic-result-ok"}>{e.kind==="wireguard"?"Authenticated":e.signal==="auth_success"?"Login accepted":e.signal==="auth_failure"?"Login rejected":e.signal==="auth_throttled"?"Rate limited":e.signal==="auth_attempt"?"Not authenticated":e.status}</span></td></tr>)}</tbody></table>{!data?.events.length&&<div className="traffic-table-empty">{loading?"Loading saved history…":"No observations match these filters. Collection is independent of this page."}</div>}</div>
      <div className="traffic-table-footer"><span>HTTP errors are diagnostic signals, not proof of an attack.</span><div><span>{stats.total?offset+1:0}–{offset+(data?.events.length??0)} of {number(stats.total)}</span><button disabled={offset===0} onClick={newer}><ArrowUp size={13}/> Newer</button><button disabled={!data||offset+data.events.length>=stats.total} onClick={older}><ArrowDown size={13}/> Older</button></div></div>
    </section>
  </div>;
}
