// Render the real production frontend using a closed, synthetic data fixture.
// Run from frontend after npm ci, npm run build and Playwright installation.
// This script never loads an .env file, contacts an API backend or executes work.
import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(frontend, "dist");
const output = resolve(frontend, "../docs/images/features");
const healthPlaybook = await readFile(resolve(frontend, "../ansible/playbooks/health-check.yml"), "utf8");
const hostLocations = [[50.1, 8.7], [40.7, -74], [1.35, 103.8]];
const now = Date.parse("2026-01-15T12:00:00Z") / 1000;
const iso = (seconds = 0) => new Date((now - seconds) * 1000).toISOString();
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hosts = ["edge-demo", "app-demo", "db-demo"].map((hostname, i) => ({
  id: id(i + 1), hostname, fqdn: `${hostname}.example.com`, ip_address: `192.0.2.${10 + i}`,
  monitoring_ip_address: null, ssh_port: 22, ssh_user: "ops-demo", credential_id: id(20),
  operating_system: "AlmaLinux", os_version: "9", environment: "demo", location: "Example site",
  latitude: hostLocations[i][0], longitude: hostLocations[i][1], group_ids: [id(10)], criticality: "medium",
  description: "Synthetic documentation host", auto_patch: false, security_patch_policy: "manual",
  reboot_policy: "manual", patch_window: null, monitoring_enabled: true, log_collection_enabled: true,
  is_docker_host: i < 2, ssh_host_fingerprint: "synthetic-fingerprint", reboot_required: false,
  date_added: iso(86400), last_seen: iso(5), last_ansible_run: iso(600), tags: ["example"],
  onboarding_steps: ["verify_network", "verify_ssh", "gather_facts", "install_node_exporter", "install_alloy"].map(step => ({step, status: "ok", detail: "Example check passed", started_at: iso(600), finished_at: iso(590)})),
}));
const groups = [{id: id(10), name: "Demo application fleet", description: "Example security patch window", cron_expression: "0 3 * * 0", patch_type: "security", batch_size: 1, schedule_enabled: false, last_triggered_at: null, hosts: hosts.map(({id, hostname}) => ({id, hostname}))}];
const metrics = {available: true};
for (const [metric, base] of [["cpu", 24], ["memory", 48], ["disk", 39], ["network_rx", 50000], ["network_tx", 28000]]) {
  metrics[metric] = hosts.map((h, i) => ({instance: h.hostname, points: Array.from({length: 30}, (_, j) => [now - (29-j)*60, Math.round(base * (1 + i*.2 + Math.sin(j*.65+i)*.14))])}));
}
const containers = ["gateway", "web", "worker", "cache", "metrics", "logs"].map((name, i) => ({id: id(30+i), hostname: hosts[i%2].hostname, name: `demo-${name}`, image: `example/${name}:demo`, status: "running", health: "healthy", restart_count: 0, last_seen: iso(4), vulnerability_count: 0, critical_vulnerability_count: 0}));
const source = (name, label, kind, n) => ({id: name, label, host_id: hosts[n].id, kind, enabled: true, use_sudo: false, log_path: "/var/log/nginx-proxy-manager/proxy-host-*_access.log", domain: "app.example.com", application: "generic", auth_domains: [], container: "", interface: "wg0", journal_unit: "sshd", ssh_failures: false});
const sources = [source("web-access", "Web access", "npm", 0), source("app-audit", "App authentication", "auth_audit", 1), source("vpn", "VPN handshakes", "wireguard", 2)];
const trafficSettings = {revision: 1, enabled: true, sources: [sources[0]], allowed_countries: [], trusted_dns: [], retention_days: 30, max_rows: 500000, notify_authentication: false};
const locations = [["Germany", "Berlin",52.5,13.4],["Netherlands","Amsterdam",52.4,4.9],["United States","Chicago",41.9,-87.6],["Brazil","Sao Paulo",-23.5,-46.6],["Japan","Tokyo",35.7,139.7],["India","Mumbai",19.1,72.9],["Australia","Sydney",-33.9,151.2]];
const events = Array.from({length: 28}, (_, i) => {
  const [country,city,lat,lon] = locations[i%locations.length];
  return {id: String(i+1),ts: now-i*19,ip:`198.51.100.${20+i}`,country,city,lat,lon,domain:i%3===2?"vpn.example.com":"app.example.com",source:sources[i%3].id,kind:i%3===2?"wireguard":"http",status:i%3===2?null:i%6===0?401:200,suspicious:i%6===0,signal:i%6===0?"auth_failure":null};
});
const history = {enabled:true,now,events,destinations:Object.fromEntries(sources.map((s,i)=>[s.id,{lat:hostLocations[i][0],lon:hostLocations[i][1],city:"Example site",label:["Demo edge","Demo app","Demo VPN"][i]}])),stats:{total:18420,http:17860,handshakes:560,clients:248,countries:7,errors:96},countries:locations.map(([name],i)=>({name,count:[5400,4600,3000,2200,1600,1000,620][i]})),timeline:Array.from({length:24},(_,i)=>({ts:now-(23-i)*3600,count:400+Math.round(260*(1+Math.sin(i*.58)))+i*10})),sources:sources.map(s=>({name:s.id,label:s.label,kind:s.kind,last_success:now-3,error:null,files:2})),retention_days:30,max_rows:500000,oldest:now-86400,offset:0,limit:100,domains:{"app.example.com":17860,"vpn.example.com":560}};
const securityAlerts = [{id:1,rule:"untrusted_login",title:"Successful application login outside trusted origins",severity:"high",domain:"app.example.com",ip:"198.51.100.24",count:1,created_at:now-120,last_seen:now-80,evidence:{country:"Japan",note:"Synthetic example: verify the matching application authentication event."},reviewed_at:null,reviewed_by:null,notified_at:now-60}];
const authentication = ["login_success","login_failure","vpn_handshake"].map((outcome,i)=>({id:i+1,ts:now-80-i*20,ip:`198.51.100.${24+i}`,domain:i===2?"vpn.example.com":"app.example.com",country:["Japan","Germany","Netherlands"][i],status:i===2?null:i===1?401:200,outcome,origin_reason:null,kind:i===2?"wireguard":"auth"}));
const trafficSecurity = {now,total:1,unreviewed:1,last_success:now-2,error:null,started_at:now-86400,baseline_ready:true,notification_error:null,talk_enabled:true,auth_total:3,auth_offset:0,auth_started_at:now-86400,auth_policy:{countries:[],dns_names:[],addresses:[],checked_at:now-10,error:null},authentication,alerts:securityAlerts,logins:[]};
const providers = [{id:id(40),slug:"demo-local",kind:"ollama",display_name:"Example local provider",base_url:"https://models.example.com",default_model:"example-model",has_key:false,enabled:true,updated_at:iso()}];
const agents = ["coordinator","linux","network","monitoring","security","automation"].map((slug,i)=>({id:id(50+i),slug,name:["Coordinator","Linux Ops","Network","Monitoring","Security","Automation"][i],description:["Coordinate a bounded investigation","Inspect hosts and storage","Check service connectivity","Review metrics and alerts","Inspect security evidence","Prepare approved operations"][i],responsibility:slug,status:i===1?"investigating":"idle",current_task:i===1?"Reviewing synthetic filesystem metrics":null,error_message:null,provider_id:id(40),model:"example-model",system_prompt:"Use evidence and respect configured permissions.",allowed_tools:["get_server_metrics","get_host_status"],allowed_hosts:["app-demo"],allowed_environments:["demo"],autonomy_level:1,max_tool_calls:8,max_execution_seconds:90,enabled:true,last_activity_at:iso(30),updated_at:iso()}));
const permissions = Object.fromEntries(agents.slice(0,3).map(a=>[a.slug,{read:true,post:true,ask:true,respond:true,peers:agents.slice(0,3).filter(b=>a.slug!==b.slug).map(b=>b.slug),tools:["get_server_metrics"]}]));
const policy = {enabled:true,max_active_investigations:2,max_tokens:50000,max_daily_tokens:250000,max_output_tokens:2048,max_model_calls:12,max_messages:20,max_help_requests:6,max_depth:2,max_participants:3,max_seconds:180,max_post_chars:2000,rules:["Use only the selected diagnostic tools.","Cite evidence and preserve uncertainty."],agents:permissions};
const board = {task_id:id(70),status:"completed",stop_reason:null,participants:["coordinator","linux","network"],charged_tokens:8420,actual_tokens:5140,model_calls:5,message_count:3,created_at:iso(600),expires_at:iso(-300),policy};
const question = "Why is the example application slower than usual?";
const boardDetail = {board,question,task_status:"completed",posts:[{id:id(71),sequence:1,agent:"coordinator",recipient:"linux",kind:"question",content:"Check CPU, memory and filesystem capacity on app-demo.",created_at:iso(580)},{id:id(72),sequence:2,agent:"linux",recipient:null,kind:"answer",content:"Example metrics: CPU 29%, memory 54%, filesystem 62%. No sustained resource pressure appears in this sample.",created_at:iso(560)},{id:id(73),sequence:3,agent:"network",recipient:null,kind:"answer",content:"Example probe latency increased from 42 ms to 180 ms. Investigate the upstream service before proposing an operational change.",created_at:iso(530)}]};
const vulnerability = {id:id(80),cve_id:"DEMO-ADVISORY-001",package_name:"example-package",severity:"HIGH",cvss_score:7.5,fixed_version:"2.1.1",fix_available:true,source:"Example scanner",cisa_kev:false,epss_score:null,first_seen:iso(86400),last_seen:iso(300),affected_hosts:[{id:hosts[1].id,hostname:"app-demo",installed_version:"2.1.0"}],affected_containers:[],priority_level:"high",priority_score:75};
const summary = {total_vulnerabilities:1,critical:0,high:1,kev:0,fix_available:1,affected_hosts:1,affected_containers:0,new_critical_advisories:0,new_kev_entries:0,sources:[{name:"Example scanner",status:"ok",last_success_at:iso(300),last_error:null,records_last_run:1}]};
const patches = [{id:id(90),host_id:hosts[1].id,package_name:"example-package",installed_version:"2.1.0",fixed_version:"2.1.1",is_security:true,severity:"important",advisory_id:"DEMO-ADVISORY-001",cve_ids:[],repository:"example-updates"}];
const action = {id:id(100),request_code:"ACT-DEMO0001",agent_id:agents[1].id,task_id:id(70),host_id:hosts[1].id,action:"Expand /data on app-demo by 10 GiB",tool:"expand_disk",arguments:{disk_target_host:"app-demo",disk_mount:"/data",disk_add_gib:10,disk_execute:false},approval_level:2,risk:"high",reason:"Example preview: verified device identity and capacity. Awaiting explicit approval; nothing has run.",status:"pending",source:"web",requested_by:"demo-admin",approved_by:null,result:null,requested_at:iso(60),expires_at:iso(-840),approved_at:null,executed_at:null};
const job = {id:id(110),playbook:"health-check.yml",target_description:"Demo application fleet",status:"completed",requested_by:"demo-admin",created_at:iso(600),started_at:iso(590),finished_at:iso(560),changed_hosts:0,successful_hosts:3,failed_hosts:0,unreachable_hosts:0};
const fixtures = {
  "/api/health":{status:"ok",app:"Ops Center",components:{database:"ok",redis:"ok",loki:"ok",security_feeds:"ok"}},
  "/api/auth/me":{id:id(120),username:"demo-admin",role:"admin",is_active:true},
  "/api/hosts":hosts,"/api/host-groups":groups,"/api/credentials":[],"/api/users":[],"/api/audit":[],
  "/api/metrics/hosts":metrics,"/api/metrics/services":{available:true,services:["Example web","Example API","Example DNS","Example queue","Example storage","Example metrics"].map((service,i)=>({service,up:true,latency_ms:12+i*8}))},
  "/api/containers":containers,"/api/docker-hosts":hosts.slice(0,2).map(h=>({hostname:h.hostname,ip_address:h.ip_address,environment:"demo",container_count:3,running_count:3,stopped_count:0,unhealthy_count:0,last_seen:iso(4)})),
  "/api/automation/playbooks":["gather-facts.yml","health-check.yml","service-check.yml","patch-check.yml","patch-security.yml","reboot-check.yml","install-node-exporter.yml","disk-expand.yml"],
  "/api/ansible/playbooks":["health-check.yml"],"/api/ansible/playbooks/health-check.yml":{name:"health-check.yml",content:healthPlaybook},"/api/jobs":[job],"/api/patches":patches,"/api/patching/reports":[],
  "/api/alerts":{available:true,alerts:[]},"/api/security/summary":summary,"/api/security/vulnerabilities":[vulnerability],"/api/security/attention":[vulnerability],"/api/security/advisories":[],
  "/api/settings/traffic":trafficSettings,"/api/traffic/history":history,"/api/traffic/security":trafficSecurity,
  "/api/traffic/security/banner":{enabled:true,now,last_success:now-2,error:null,sources:history.sources,alerts:securityAlerts,observations:authentication},
  "/api/ai/providers":providers,"/api/ai/agents":agents,"/api/ai/findings":[],"/api/ai/actions":[action],"/api/ai/tasks":[],"/api/ai/usage":{days:7,points:[]},
  "/api/ai/collaboration/settings":{revision:1,policy,tools:["get_server_metrics","get_host_status"],daily_charged_tokens:8420},
  "/api/ai/collaboration/boards":[{board,question,task_status:"completed"}],
  [`/api/ai/collaboration/boards/${board.task_id}`]:boardDetail,
  "/api/cluster/status":{postgres:{scope:"demo-cluster",vip:"192.0.2.30",vip_holder:"app-demo",nodes:[{name:"app-demo",host:"192.0.2.11",reachable:true,role:"primary",state:"running",replication_state:null,timeline:3,replicas:[]},{name:"db-demo",host:"192.0.2.12",reachable:true,role:"replica",state:"running",replication_state:"streaming",timeline:3,replicas:[]}]},redis:{master_name:"demo-redis",nodes:[{host:"app-demo",reachable:true,role:"master",connected_slaves:1},{host:"db-demo",reachable:true,role:"slave",connected_slaves:0}],sentinels:["app-demo","db-demo","witness-demo"].map(host=>({host,reachable:true,master_host:"app-demo"}))}},
  "/api/vpn/peers":["Example laptop","Example tablet","Example gateway"].map((name,i)=>({id:id(130+i),name,address:`192.0.2.${70+i}`,enabled:true,latest_handshake_at:iso(25+i*5),transfer_rx:24000000+i*5000000,transfer_tx:12000000+i*3000000,note:"Synthetic documentation peer"})),
  "/api/logs":{available:true,lines:Array.from({length:12},(_,i)=>({timestamp:String((now-i*15)*1e9),labels:{host:hosts[i%3].hostname},line:["Example health probe completed successfully","Example service ready; configuration validated","Example metrics batch accepted; 24 samples"][i%3]}))},
};
const missing = new Set();
const mime = {".html":"text/html",".js":"application/javascript",".css":"text/css",".svg":"image/svg+xml",".png":"image/png",".webmanifest":"application/manifest+json"};
const server = http.createServer(async (req,res) => {
  const path = new URL(req.url,"http://localhost").pathname;
  const json = (data,status=200) => {res.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store"});res.end(JSON.stringify(data));};
  if(req.method!=="GET") return json({detail:"Documentation fixture is read-only"},405);
  if(path.startsWith("/api/")) {
    if(Object.hasOwn(fixtures,path)) return json(fixtures[path]);
    const patchHost=hosts.find(h=>path===`/api/hosts/${h.id}/patches`);
    if(patchHost) {const hostPatches=patches.filter(p=>p.host_id===patchHost.id);return json({id:id(140),host_id:patchHost.id,status:"completed",pending_count:hostPatches.length,pending_security_count:hostPatches.length,reboot_required:false,started_at:iso(600),completed_at:iso(590),created_at:iso(600),patches:hostPatches});}
    if(path.includes("/events")) {res.writeHead(200,{"Content-Type":"text/event-stream"});res.write(": synthetic fixture\n\n");return;}
    missing.add(path);return json({detail:"No synthetic fixture for this endpoint"},404);
  }
  try {
    let file=resolve(dist,"."+path);
    if(!file.startsWith(dist+"/")) file=resolve(dist,"index.html");
    let bytes;
    try {bytes=await readFile(file);} catch {if(extname(path)){res.writeHead(404);return res.end();}file=resolve(dist,"index.html");bytes=await readFile(file);}
    res.writeHead(200,{"Content-Type":mime[extname(file)]||"application/octet-stream","Cache-Control":"no-store"});res.end(bytes);
  } catch {res.writeHead(500);res.end();}
});
await new Promise(done=>server.listen(0,"127.0.0.1",done));
const origin=`http://127.0.0.1:${server.address().port}`;
const captures = [
  {name:"overview",path:"/",ready:"Overview"},
  {name:"servers",height:550,path:"/servers",ready:"Servers"},
  {name:"containers",path:"/containers",ready:"Containers"},
  {name:"automation",path:"/automation",ready:"Automation"},
  {name:"monitoring",path:"/monitoring",ready:"Monitoring"},
  {name:"security",height:650,path:"/vulnerabilities",ready:"Vulnerabilities"},
  {name:"patching",path:"/patching",ready:"Patching",after:async p=>p.getByRole("button",{name:"app-demo",exact:true}).click()},
  {name:"logs",height:720,path:"/logs",ready:"Logs"},
  {name:"cluster",path:"/cluster",ready:"Cluster"},
  {name:"agents",path:"/ai-agents/agents",ready:"Agents"},
  {name:"traffic-map",path:"/traffic-map/wallboard",ready:"Traffic Map Wallboard",height:1280},
  {name:"login-events",path:"/traffic-map",ready:"Traffic Map",height:1100,after:async p=>p.locator("#traffic-security").evaluate(el=>el.scrollIntoView({block:"start"}))},
  {name:"traffic-settings",path:"/settings",ready:"Settings",height:1050},
  {name:"collaboration",path:"/ai-agents/collaboration",ready:"Collaboration board",height:1240,after:async p=>{await p.getByRole("button",{name:new RegExp(question.replace("?","\\?"))}).click();await p.getByText("8,420 / 50,000").waitFor();}},
  {name:"collaboration-settings",path:"/ai-agents/collaboration/settings",ready:"Collaboration settings",height:1300},
  {name:"disk-expansion",height:750,path:"/ai-agents/approvals",ready:"Approvals"},
  {name:"vpn",height:750,path:"/vpn",ready:"VPN"},
  {name:"pwa-install",path:"/login",ready:"Ops Center",width:1024,height:1024,ipad:true,after:async p=>p.getByRole("button",{name:"Add to Home Screen",exact:true}).click()},
  {name:"pwa-offline",path:"/",ready:"Overview",width:1024,height:800,after:async p=>{await p.evaluate(()=>window.dispatchEvent(new Event("ops-backend-unavailable")));await p.getByRole("alertdialog").waitFor();}},
];
await mkdir(output,{recursive:true});
let browser;
const errors=[];
try {
  browser=await chromium.launch({headless:true});
  const selected = new Set(process.argv.slice(2));
  for (const name of selected) if (!captures.some(s => s.name === name)) throw new Error(`Unknown screenshot: ${name}`);
  for(const shot of captures.filter(s => !selected.size || selected.has(s.name))) {
    const context=await browser.newContext({viewport:{width:shot.width||1440,height:shot.height||1000},deviceScaleFactor:1,locale:"en-US",timezoneId:"UTC",colorScheme:"dark",reducedMotion:"reduce",serviceWorkers:"block",...(shot.ipad?{hasTouch:true,userAgent:"Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1"}:{})});
    // All application requests stay on the loopback fixture. Only generic world
    // basemap tiles may leave it; no example observations are sent to this host.
    await context.route("**/*",route=>{
      const u=new URL(route.request().url());
      if(u.origin===origin||/^https:\/\/tile\.openstreetmap\.org\/2\/[0-3]\/[0-3]\.png$/.test(u.href)) return route.continue();
      return route.abort();
    });
    await context.addInitScript(()=>{localStorage.setItem("ops_center_token","documentation-fixture-only");localStorage.setItem("ops_navigation_open","true");});
    const page=await context.newPage();
    page.on("pageerror",e=>errors.push(`${shot.name}: ${e.message}`));
    await page.clock.setFixedTime(new Date(now*1000));
    await page.goto(origin+shot.path,{waitUntil:"networkidle"});
    if(shot.ready) await page.getByRole("heading",{name:shot.ready,exact:true}).first().waitFor({timeout:10000});
    if(shot.after) await shot.after(page);
    await page.evaluate(()=>document.fonts.ready);
    // Recharts uses JavaScript animation; CSS reduced-motion alone does not settle it.
    await page.waitForTimeout(1800);
    // This capture-only label is not installed in the application.
    await page.evaluate(()=>{const label=document.createElement("div");label.textContent="DOCUMENTATION DEMO · SYNTHETIC EXAMPLE DATA";label.style.cssText="position:fixed;bottom:12px;left:16px;z-index:2147483647;padding:8px 12px;border:1px solid #315577;border-radius:7px;background:#07121fee;color:#bae6fd;font:600 10px system-ui;letter-spacing:1px;pointer-events:none";document.body.appendChild(label);});
    await page.screenshot({path:resolve(output,`${shot.name}.png`),animations:"disabled"});
    console.log(`Captured ${shot.name}`);
    await context.close();
  }
  if(missing.size) throw new Error(`Unmapped fixture endpoints: ${[...missing].join(", ")}`);
  if(errors.length) throw new Error(errors.join("\n"));
} finally {await browser?.close();server.closeAllConnections();await new Promise(done=>server.close(done));}
