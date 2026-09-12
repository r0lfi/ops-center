import React from "react";
import {createRoot} from "react-dom/client";
import {BrowserRouter} from "react-router-dom";
import TrafficMapPage from "../src/pages/TrafficMapPage";
import {api,type TrafficEvent} from "../src/lib/api";
import "../src/index.css";
const now=Date.now()/1000;
const locations=[["Norway","Oslo",59.9,10.7],["Germany","Frankfurt",50.1,8.6],["United States","New York",40.7,-74],["Netherlands","Amsterdam",52.3,4.9],["United Kingdom","London",51.5,-.1],["Singapore","Singapore",1.3,103.8]] as const;
const rows:TrafficEvent[]=Array.from({length:145},(_,i)=>({id:String(i),ts:now-i*180,ip:"203.0.113."+((i%45)+1),lat:locations[i%6][2],lon:locations[i%6][3],country:locations[i%6][0],city:locations[i%6][1],kind:i%13===0?"wireguard":"http",domain:i%13===0?"vpn.example.com":i%3===0?"example.com":"media.example.com",status:i%13===0?null:i%7===0?403:200,source:i%3===0?"edge-host":"home",suspicious:i%13!==0&&i%7===0}));
api.traffic.history=async(p)=>{
 let events=rows.filter(r=>r.ts>now-p.hours*3600);
 if(p.service==="media")events=events.filter(r=>r.domain==="media.example.com");
 if(p.service==="vpn")events=events.filter(r=>r.kind==="wireguard");
 if(p.service==="vps")events=events.filter(r=>r.source==="edge-host");
 if(p.errors)events=events.filter(r=>r.suspicious);
 if(p.search)events=events.filter(r=>[r.ip,r.country,r.domain].join(" ").toLowerCase().includes(p.search.toLowerCase()));
 const countries=Object.entries(events.reduce((a,r)=>({...a,[r.country??"Unknown"]:(a[r.country??"Unknown"]??0)+1}),{} as Record<string,number>)).map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count);
 return {now:Date.now()/1000,events:events.slice(p.offset,p.offset+100),stats:{total:events.length,clients:new Set(events.map(r=>r.ip)).size,countries:countries.length,errors:events.filter(r=>r.suspicious).length,handshakes:events.filter(r=>r.kind==="wireguard").length},countries,domains:{},timeline:Array.from({length:36},(_,i)=>({ts:now-(35-i)*2400,count:events.filter(r=>Math.floor((now-r.ts)/2400)===35-i).length})),destinations:{home:{lat:59.9,lon:10.7,city:"Oslo",country:"Norway"},"edge-host":{lat:50.1,lon:8.6,city:"Frankfurt",country:"Germany"}},sources:["npm","wireguard","caddy"].map(name=>({name,last_success:Date.now()/1000,error:null,files:1})),retention_days:30,max_rows:500000,oldest:now-86400,offset:p.offset,limit:100};
};

let previewAlerts=[
 {id:1,rule:"success_after_failures",title:"Successful login after repeated rejections",severity:"high",domain:"media.example.com",ip:"203.0.113.21",count:12,created_at:now-80,last_seen:now-60,evidence:{note:"Synthetic scenario: successful authentication after repeated rejections. Same IP does not necessarily mean the same account."},reviewed_at:null as number|null,reviewed_by:null as string|null,notified_at:now-40},
 {id:2,rule:"new_vpn_endpoint",title:"New VPN endpoint",severity:"warning",domain:"vpn.example.com",ip:"203.0.113.44",count:1,created_at:now-300,last_seen:now-200,evidence:{note:"Synthetic scenario: a new endpoint can be a mobile network or travel. Investigate before taking action."},reviewed_at:null as number|null,reviewed_by:null as string|null,notified_at:now-180}
];
api.traffic.security=async(service)=>{
 const alerts=previewAlerts.filter(a=>service==="all"||(service==="media"&&a.domain==="media.example.com")||(service==="vpn"&&a.domain==="vpn.example.com"));
 return {now:Date.now()/1000,total:alerts.length,unreviewed:alerts.filter(a=>!a.reviewed_at).length,last_success:Date.now()/1000,error:null,started_at:now-7200,baseline_ready:true,notification_error:null,talk_enabled:true,alerts,logins:service==="vpn"||service==="vps"?[]:[{ts:now-60,ip:"203.0.113.21",domain:"media.example.com",country:"Norway"}]};
};
api.traffic.reviewSecurity=async(id)=>{previewAlerts=previewAlerts.map(a=>a.id===id?{...a,reviewed_at:Date.now()/1000,reviewed_by:"Preview admin"}:a);return {ok:true}};

createRoot(document.getElementById("root")!).render(<BrowserRouter><div style={{background:"#070f1d",minHeight:"100vh",padding:"24px",color:"#e2e8f0"}}><div style={{fontSize:10,color:"#fbbf24",marginBottom:12}}>LAYOUT PREVIEW · SYNTHETIC TEST DATA · NOT PRODUCTION TRAFFIC</div><TrafficMapPage/></div></BrowserRouter>);
