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
const agentSpecs = [
  ["coordinator","Coordinator","Coordinate a bounded investigation","working","Planning the slow-application investigation"],
  ["linux","Linux Ops","Inspect hosts and storage","waiting","Reviewing synthetic filesystem metrics"],
  ["network","Network","Check service connectivity","investigating","Probing the example upstream API"],
  ["monitoring","Monitoring","Review metrics and alerts","working","Correlating latency with example alerts"],
  ["security","Security","Inspect security evidence","idle",null],
  ["automation","Automation","Prepare approved operations","idle",null],
  ["container","Containers","Inspect container workloads","idle",null],
  ["patching","Patching","Plan and verify updates","idle",null],
  ["general","General","Answer general operations questions","idle",null],
  ["chat","Chat","Hold the web chat conversation","idle",null],
];
const agents = [
  ...agentSpecs.map(([slug,name,description,status,current_task],i)=>({id:id(50+i),slug,name,description,responsibility:slug,status,current_task,error_message:null,provider_id:id(40),model:"example-model",system_prompt:"Use evidence and respect configured permissions.",allowed_tools:["get_server_metrics","get_host_status"],allowed_hosts:["app-demo"],allowed_environments:["demo"],autonomy_level:1,max_tool_calls:8,max_execution_seconds:300,enabled:true,runtime:"native",allowed_dispatch_targets:null,personal:false,last_activity_at:iso(30+i*40),updated_at:iso()})),
  {id:id(60),slug:"nova",name:"Nova",description:"Example personal assistant",responsibility:"personal",status:"idle",current_task:null,error_message:null,provider_id:id(40),model:"example-model",system_prompt:"Example personal agent.",allowed_tools:["recall_memory","remember_fact"],allowed_hosts:[],allowed_environments:[],autonomy_level:0,max_tool_calls:8,max_execution_seconds:300,enabled:true,runtime:"native",allowed_dispatch_targets:["coordinator"],personal:true,last_activity_at:iso(900),updated_at:iso()},
  ...[["ext-coordinator","External Coordinator","working","Reviewing an example change request"],["ext-coder","External Coder","working","Editing example code"],["ext-reader","External Reader","idle",null],["ext-reviewer","External Reviewer","idle",null]].map(([slug,name,status,current_task],i)=>({id:id(61+i),slug,name,description:"Runs outside Ops Center and reports its own state",responsibility:"external",status,current_task,error_message:null,provider_id:null,model:null,system_prompt:"",allowed_tools:[],allowed_hosts:[],allowed_environments:[],autonomy_level:0,max_tool_calls:0,max_execution_seconds:0,enabled:true,runtime:"external",allowed_dispatch_targets:[],personal:false,last_activity_at:iso(20+i*30),updated_at:iso()})),
];
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
const task = (n,agentIdx,input,status,response=null,ago=300) => ({id:id(n),agent_id:agents[agentIdx].id,requested_by:"demo-admin",source:"web",conversation_key:null,input_message:input,response_message:response,status,error_message:null,agents_used:[agents[agentIdx].slug],tools_used:[],data_sources:["prometheus"],confidence:status==="completed"?82:null,started_at:iso(ago),completed_at:status==="completed"?iso(ago-40):null,duration_ms:status==="completed"?40000:null,created_at:iso(ago)});
const tasks = [task(70,0,question,"running",null,240),task(74,3,"Summarise example alerts from the last hour","running",null,120),task(75,1,"Check free space on app-demo","completed","Example result: /data is 62% used; no action needed.",1800),task(76,7,"List pending security updates for the demo fleet","completed","Example result: one important update for example-package.",3600)];
const series = (base,host) => [{labels:{instance:host},points:Array.from({length:30},(_,j)=>[now-(29-j)*60,Math.round(base*(1+Math.sin(j*.5)*.12))])}];
const fleet = {hosts:hosts.map((h,i)=>({id:h.id,hostname:h.hostname,ip_address:h.ip_address,operating_system:"AlmaLinux",os_version:"9",monitoring_enabled:true,log_collection_enabled:true,is_docker_host:h.is_docker_host,container_inventory_at:iso(30),status:"ok",last_sample:now-5,metrics:{cpu:series(22+i*9,h.hostname),memory:series(45+i*7,h.hostname),disk:series(38+i*10,h.hostname),inodes:series(12,h.hostname),network_rx:series(52000,h.hostname),network_tx:series(26000,h.hostname),uptime:series(864000,h.hostname),last_sample:series(1,h.hostname)},alerts:[],services:[]})),containers:[],errors:{},container_errors:{},alerts_available:true};
const incident = (n,category,rule,resource,title,severity,status,obs,agoSeconds) => ({id:n,category,rule,resource,title,severity,status,source_state:status==="completed"?"resolved":"firing",details:{summary:"Synthetic documentation incident"},observations:obs,revision:1,created_at:iso(agoSeconds),last_seen:iso(60),completed_at:status==="completed"?iso(120):null,updated_by:status==="open"?null:"demo-admin",talk_policy:"single"});
const incidents = {total:4,offset:0,workflow_enabled:true,monitor:{checked_at:now-20,alertmanager:"ok",traffic:"ok"},items:[
  incident(104,"availability","ProbeFailed","https://api.example.com","Example API probe is failing","critical","open",14,900),
  incident(103,"disk","DiskAlmostFull","app-demo:/data","/data on app-demo is 91% full","warning","in_progress",6,5400),
  incident(102,"certificate","CertificateExpiring","app.example.com","Certificate for app.example.com expires in 9 days","warning","open",2,86400),
  incident(101,"cpu","HighCpuLoad","db-demo","High CPU load on db-demo","info","completed",3,172800)]};
const devChange = (n,title,stage,status,summary,files,added,removed,ago) => ({id:id(n),title,status,stage,summary,proposed_by:"Monitoring",developer_run:{id:id(n+50),status:stage==="working"?"running":"completed",outcome:null,requested_by:"demo-admin",created_at:iso(ago),started_at:iso(ago),completed_at:stage==="working"?null:iso(ago-600),duration_ms:stage==="working"?null:600000,tools_used:12,error:null},runs:1,files,added,removed,has_patch:stage!=="working",patch_sha256:stage==="working"?null:"0".repeat(64),approved_by:stage==="approved"?"demo-admin":null,approved_at:stage==="approved"?iso(ago-900):null,release_ref:null,branch:`tool-proposal/${id(n).slice(0,8)}`,created_at:iso(ago),updated_at:iso(60),started_at:iso(ago),finished_at:stage==="working"?null:iso(ago-600)});
const developer = {agent:{name:"Developer",status:"working",activity:"Writing tests for the example log search tool",enabled:true,configured:true},can_decide:true,counts:{working:1,ready_for_review:1,approved:1},items:[
  devChange(150,"Read-only log search for example services","working","in_development","Agents can only read logs through shell access; a read-only search tool removes approvals for plain reads.",3,140,4,1200),
  devChange(151,"TLS certificate check tool","ready_for_review","implemented","Report certificate expiry and SNI mismatches without running openssl by hand.",4,212,9,7200),
  devChange(152,"Disk growth forecast","approved","approved","Forecast when a filesystem fills up from Prometheus history.",3,96,2,86400)]};
const memories = {enabled:true,items:[
  ["work.on_call","Work","On call the first week of every month; prefers short summaries during that week."],
  ["home.lab","Home lab","Runs a small example lab with three hosts and a NAS."],
  ["preferences.language","Preferences","Prefers answers in English, bullet points first."],
  ["goals.learning","Goals","Learning Rust in the evenings this quarter."]].map(([key,category,content],i)=>({id:id(160+i),agent_id:i%2?agents[10].id:null,key,content,source_task_id:null,updated_at:iso(86400*(i+1)),category,kind:"fact",created_at:iso(86400*(i+3))}))};
const suggestions = {items:[{id:id(170),agent_id:agents[10].id,key:"routine.morning_run",content:"Goes for a run at 06:30 on weekdays.",source:"conversation",evidence_task_id:null,status:"pending",created_at:iso(3600),decided_at:null,category:"Routines",kind:"fact",target_memory_id:null,target:null}]};
const aiMapGroup = (n,agent,dst_host,dst_ip,port,scope,status,count,geo,service=null,provider=null,model=null) => ({key:`g${n}`,agent,process:"celery",node:"ops-host",container:"ops-ai-worker",model,provider,tool:null,mcp_tool:null,src_ip:"203.0.113.18",src_count:1,dst_ip,dst_port:port,dst_host,protocol:"tcp",kind:port===53?"dns":"tcp",status,outcomes:[status==="ok"?"ok":status==="blocked"?"firewall_block":"timeout"],reason:status==="blocked"?"Example: refused by the destination firewall":null,count,bytes_sent:count*1800,bytes_recv:count*9200,unmeasured:0,first_seen:iso(3600),last_seen:iso(20+n*7),last_id:n,scope,category:agent?"ai":"system",direction:"outbound",service,geo});
const aiTrafficMap = {since:iso(3600),generated_at:iso(),truncated:false,group_limit:1500,geoip:true,sites:{"ops-host":{lat:50.1,lon:8.7}},groups:[
  aiMapGroup(1,"coordinator","api.models.example.com","192.0.2.40",443,"external","ok",412,{lat:37.8,lon:-122.4,city:"San Francisco",country:"United States"},null,"example-cloud","example-model"),
  aiMapGroup(2,"network","api.example.com","192.0.2.41",443,"external","failed",9,{lat:52.4,lon:4.9,city:"Amsterdam",country:"Netherlands"}),
  aiMapGroup(3,"monitoring",null,"198.51.100.20",9090,"internal","ok",128,null,"Prometheus"),
  aiMapGroup(4,"linux",null,"198.51.100.11",22,"internal","ok",36,null,"SSH"),
  aiMapGroup(5,"security","feeds.example.org","192.0.2.42",443,"external","ok",18,{lat:48.9,lon:2.35,city:"Paris",country:"France"}),
  aiMapGroup(6,"general","unknown-tracker.example.net","192.0.2.43",443,"external","blocked",3,{lat:35.7,lon:139.7,city:"Tokyo",country:"Japan"}),
  aiMapGroup(7,null,null,"198.51.100.53",53,"internal","ok",640,null,"DNS")],
  countries:[{country:"United States",count:412,bytes:4e6,problems:0},{country:"France",count:18,bytes:2e5,problems:0},{country:"Netherlands",count:9,bytes:9e4,problems:9},{country:"Japan",count:3,bytes:1e4,problems:3}],
  coverage:[{node:"ops-host",area:"Passive network capture",status:"ok",detail:"Synthetic example"},{node:null,area:"Firewall drop logs (rule that blocked)",status:"missing",detail:"Not exported in this example"}]};
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
  "/api/ai/providers":providers,"/api/ai/agents":agents,"/api/ai/findings":[],"/api/ai/actions":[action],"/api/ai/tasks":tasks,"/api/ai/usage":{days:7,points:[]},
  "/api/ai/collaboration/settings":{revision:1,policy,tools:["get_server_metrics","get_host_status"],daily_charged_tokens:8420},
  "/api/ai/collaboration/boards":[{board,question,task_status:"completed"}],
  [`/api/ai/collaboration/boards/${board.task_id}`]:boardDetail,
  "/api/ai/collaboration/experiences":{memory_enabled:true,items:[]},
  "/api/cluster/status":{postgres:{scope:"demo-cluster",vip:"192.0.2.30",vip_holder:"app-demo",nodes:[{name:"app-demo",host:"192.0.2.11",reachable:true,role:"primary",state:"running",replication_state:null,timeline:3,replicas:[]},{name:"db-demo",host:"192.0.2.12",reachable:true,role:"replica",state:"running",replication_state:"streaming",timeline:3,replicas:[]}]},redis:{master_name:"demo-redis",nodes:[{host:"app-demo",reachable:true,role:"master",connected_slaves:1},{host:"db-demo",reachable:true,role:"slave",connected_slaves:0}],sentinels:["app-demo","db-demo","witness-demo"].map(host=>({host,reachable:true,master_host:"app-demo"}))}},
  "/api/vpn/peers":["Example laptop","Example tablet","Example gateway"].map((name,i)=>({id:id(130+i),name,address:`192.0.2.${70+i}`,enabled:true,latest_handshake_at:iso(25+i*5),transfer_rx:24000000+i*5000000,transfer_tx:12000000+i*3000000,note:"Synthetic documentation peer"})),
  "/api/cameras/status":[],"/api/monitoring/fleet":fleet,"/api/mcp/agent-access":{service_enabled:true,rows:[]},
  "/api/ai/proposals":[],"/api/incidents":incidents,"/api/ai/developer/overview":developer,
  "/api/ai/memory":memories,"/api/ai/memory/suggestions":suggestions,"/api/ai/memory/duplicates":{items:[]},
  "/api/ai/nova/routines":{settings:{enabled:true,quiet_start:"22:00",quiet_end:"07:00",max_per_day:3},memory_enabled:true,talk_room:false,timezone:"UTC",max_routines:20,routines:[{id:id(180),name:"Morning briefing",schedule:"0 7 * * 1-5",instruction:"Summarise today's calendar and open incidents in three bullets.",channel:"web",enabled:true,last_run_at:iso(18000),next_run_at:iso(-68400),created_at:iso(604800)}],runs:[]},
  "/api/ai/nova/sources":{cloud_provider:false,sources:[]},
  "/api/ai/imports":{memory_enabled:true,conversations:0,analyzed:0,pending_import_suggestions:0,max_upload_mb:200},
  "/api/ai/budget":{limit_usd:25,warning_usd:20,billed_usd:6.4,reserved_usd:0.3,remaining_usd:18.3,reset_at:iso(-259200),week_start:iso(345600),warning:false,exhausted:false},
  "/api/ai-traffic/map":aiTrafficMap,
  "/api/logs":{available:true,lines:Array.from({length:12},(_,i)=>({timestamp:String((now-i*15)*1e9),labels:{host:hosts[i%3].hostname},line:["Example health probe completed successfully","Example service ready; configuration validated","Example metrics batch accepted; 24 samples"][i%3]}))},
};
const missing = new Set();
const mime = {".html":"text/html",".js":"application/javascript",".css":"text/css",".svg":"image/svg+xml",".png":"image/png",".webmanifest":"application/manifest+json"};
const server = http.createServer(async (req,res) => {
  const path = new URL(req.url,"http://localhost").pathname;
  const json = (data,status=200) => {res.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store"});res.end(JSON.stringify(data));};
  // The only accepted write: session renewal hands out a placeholder access
  // token (the app keeps it in memory only). Nothing is stored or executed.
  if(req.method==="POST"&&path==="/api/auth/refresh") return json({access_token:"documentation-fixture-only",token_type:"bearer"});
  if(req.method!=="GET") return json({detail:"Documentation fixture is read-only"},405);
  if(path.startsWith("/api/")) {
    if(Object.hasOwn(fixtures,path)) return json(fixtures[path]);
    const patchHost=hosts.find(h=>path===`/api/hosts/${h.id}/patches`);
    if(patchHost) {const hostPatches=patches.filter(p=>p.host_id===patchHost.id);return json({id:id(140),host_id:patchHost.id,status:"completed",pending_count:hostPatches.length,pending_security_count:hostPatches.length,reboot_required:false,started_at:iso(600),completed_at:iso(590),created_at:iso(600),patches:hostPatches});}
    if(path.includes("/events")||path.endsWith("/stream")) {res.writeHead(200,{"Content-Type":"text/event-stream"});res.write(": synthetic fixture\n\n");return;}
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
  {name:"automation",path:"/automation",ready:"Run actions"},
  {name:"monitoring",path:"/monitoring",ready:"Monitoring"},
  {name:"security",height:650,path:"/vulnerabilities",ready:"Vulnerabilities"},
  {name:"patching",path:"/patching",ready:"Patching",after:async p=>p.getByRole("button",{name:"app-demo",exact:true}).click()},
  {name:"logs",height:720,path:"/logs",ready:"Logs"},
  {name:"cluster",path:"/cluster",ready:"Cluster"},
  {name:"agents",path:"/ai-agents/agents",ready:"Agents"},
  {name:"traffic-map",path:"/traffic-map/wallboard",ready:"Traffic Map Wallboard",height:1280},
  {name:"login-events",path:"/traffic-map",ready:"Traffic Map",height:1100,after:async p=>p.locator("#traffic-security").evaluate(el=>el.scrollIntoView({block:"start"}))},
  {name:"traffic-settings",path:"/settings?tab=traffic",ready:"Settings",height:1050},
  {name:"collaboration",path:"/ai-agents/collaboration",height:1240,after:async p=>{await p.getByText(question).first().waitFor();}},
  {name:"collaboration-settings",path:"/settings?tab=collaboration",ready:"Settings",height:1300},
  {name:"disk-expansion",height:1150,path:"/ai-agents/approvals",ready:"Approvals"},
  {name:"vpn",height:750,path:"/vpn",ready:"VPN"},
  {name:"ai-overview",path:"/ai-agents",ready:"AI overview",height:1100},
  {name:"ops-floor",path:"/ai-agents/ops-floor",ready:"Ops Floor",height:1300},
  {name:"ops-floor-3d",path:"/ai-agents/ops-floor",ready:"Ops Floor",height:1000,after:async p=>p.getByRole("button",{name:"3D Office",exact:true}).click()},
  {name:"ai-traffic",path:"/ai-traffic/map",ready:"AI Traffic Monitor",height:1000},
  {name:"incidents",path:"/incidents",ready:"Incidents",height:900},
  {name:"developer-agent",path:"/ai-agents/developer",ready:"Developer Agent",height:760,after:async p=>p.getByRole("button",{name:/^All/}).click()},
  {name:"personal-agent",path:"/ai-agents/nova",ready:"Personal agent (Nova)",height:1100},
  {name:"command-palette",path:"/",ready:"Overview",height:800,after:async p=>{await p.keyboard.press("Control+k");await p.getByRole("dialog").waitFor();await p.keyboard.type("agent");}},
  {name:"mobile",path:"/ai-agents/ops-floor",ready:"Ops Floor",width:390,height:844,mobile:true},
  {name:"pwa-install",path:"/login",ready:"Ops Center",width:1024,height:1024,ipad:true,after:async p=>p.getByRole("button",{name:"Add to Home Screen",exact:true}).click()},
  {name:"pwa-offline",path:"/",ready:"Overview",width:1024,height:800,after:async p=>{await p.route("**/api/health",r=>r.fulfill({status:503,body:""}));await p.evaluate(()=>window.dispatchEvent(new Event("ops-backend-unavailable")));await p.getByRole("alertdialog").waitFor();}},
];
await mkdir(output,{recursive:true});
let browser;
const errors=[];
try {
  browser=await chromium.launch({headless:true});
  const selected = new Set(process.argv.slice(2));
  for (const name of selected) if (!captures.some(s => s.name === name)) throw new Error(`Unknown screenshot: ${name}`);
  for(const shot of captures.filter(s => !selected.size || selected.has(s.name))) {
    const context=await browser.newContext({viewport:{width:shot.width||1440,height:shot.height||1000},deviceScaleFactor:1,locale:"en-US",timezoneId:"UTC",colorScheme:"dark",reducedMotion:"reduce",serviceWorkers:"block",...(shot.mobile?{isMobile:true,hasTouch:true,deviceScaleFactor:2}:{}),...(shot.ipad?{hasTouch:true,userAgent:"Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1"}:{})});
    // All application requests stay on the loopback fixture. Only generic world
    // basemap tiles may leave it; no example observations are sent to this host.
    await context.route("**/*",route=>{
      const u=new URL(route.request().url());
      if(u.origin===origin||/^https:\/\/tile\.openstreetmap\.org\/2\/[0-3]\/[0-3]\.png$/.test(u.href)) return route.continue();
      return route.abort();
    });
    await context.addInitScript(()=>{localStorage.setItem("ops_navigation_open","true");});
    const page=await context.newPage();
    page.on("pageerror",e=>errors.push(`${shot.name}: ${e.message}`));
    await page.clock.setFixedTime(new Date(now*1000));
    // Live views hold an event stream open, so the network never goes idle there.
    await page.goto(origin+shot.path,{waitUntil:"load"});
    await page.waitForLoadState("networkidle",{timeout:5000}).catch(()=>{});
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
