// Captures actual MCP UI with synthetic data only. No production connection.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const output=resolve(process.env.MCP_SCREENSHOT_OUTPUT || "../docs/images");
await mkdir(output,{recursive:true});
const fixture=spawn(process.execPath,["tests/pwa-server.mjs"],{stdio:"ignore"});
for(let i=0;i<80;i++){
  try{if((await fetch("http://127.0.0.1:4175/api/health")).ok)break;}catch{}
  await new Promise(r=>setTimeout(r,100));
}
const browser=await chromium.launch({headless:true});
try{
 const context=await browser.newContext({viewport:{width:1440,height:1080},colorScheme:"dark",serviceWorkers:"block"});
 const page=await context.newPage();
 const user={id:"11111111-1111-4111-8111-111111111111",username:"demo-admin",role:"admin",is_active:true};
 const agent={id:"22222222-2222-4222-8222-222222222222",name:"Operations agent",enabled:true,allowed_tools:[]};
 const tools=[
  {name:"ops_list_hosts",description:"List managed hosts and their current inventory.",scope:"ops:hosts:read",minimum_role:"viewer",method:"GET"},
  {name:"ops_live_traffic",description:"Read live traffic observations and destinations.",scope:"ops:traffic:read",minimum_role:"viewer",method:"GET"},
  {name:"ops_restart_container",description:"Request a container restart. Requires human approval.",scope:"ops:containers:write",minimum_role:"admin",method:"POST"},
 ];
 const client={id:"demo-desktop-client",name:"Desktop assistant",enabled:true,redirect_uris:["https://assistant.example.com/oauth/callback"],
  allowed_tools:["ops_list_hosts","ops_live_traffic"],allowed_user_ids:[user.id],scopes:["ops:connect","ops:hosts:read","ops:traffic:read"]};
 const request={request_id:"33333333-3333-4333-8333-333333333333",tool:"ops_restart_container",status:"pending",argument_digest:"a".repeat(64),
  arguments:{path:{hostname:"web-01",name:"demo-web"},idempotency_key:"demo-restart-01"},result:null,expires_at:"2099-01-01T12:00:00Z"};
 await page.addInitScript(()=>{localStorage.setItem("ops_center_token","synthetic-gallery-only");localStorage.setItem("ops_navigation_open","false");});
 await page.route("**/api/**",async route=>{
  const path=new URL(route.request().url()).pathname;
  const data=path==="/api/auth/me"?user:path==="/api/health"?{status:"ok",components:{database:"ok"}}:
   path==="/api/users"?[user]:path==="/api/ai/agents"?[agent]:
   path==="/api/mcp/settings"?{enabled:true,revision:1,public_url:"https://ops.example.com/mcp",tools,scopes:client.scopes}:
   path==="/api/mcp/clients"?[client]:path==="/api/mcp/requests"?[request]:
   path.startsWith("/api/mcp/consent/")?{client_name:client.name,client_id:client.id,redirect_uri:client.redirect_uris[0],resource:"https://ops.example.com/mcp",tools}: [];
  await route.fulfill({json:data});
 });
 await page.goto("http://127.0.0.1:4175/mcp-access");
 await page.addStyleTag({content:".fixed.bottom-4.right-4 { visibility: hidden !important; }"});
 await page.getByRole("button",{name:"Desktop assistant",exact:true}).click();
 const section=name=>page.locator("section").filter({has:page.getByRole("heading",{name,exact:true})});
 await section("External clients").screenshot({path:resolve(output,"mcp-clients.png")});
 const agents=section("Ops Floor agent access");
 await agents.getByLabel("Agent",{exact:true}).selectOption(agent.id);
 await agents.getByLabel("Task owner",{exact:true}).selectOption(user.id);
 await agents.getByLabel(/ops_list_hosts/).check();
 await agents.getByLabel(/ops_live_traffic/).check();
 await agents.screenshot({path:resolve(output,"mcp-agents.png")});
 await section("Change requests").screenshot({path:resolve(output,"mcp-approvals.png")});
 await page.goto("http://127.0.0.1:4175/mcp/consent?request=demo-consent");
 await page.getByLabel(/ops_list_hosts/).check();
 await page.getByLabel(/ops_live_traffic/).check();
 await page.getByRole("main").screenshot({path:resolve(output,"mcp-consent.png")});
 console.log("Captured four synthetic MCP screenshots.");
}finally{await browser.close();fixture.kill("SIGTERM");}
