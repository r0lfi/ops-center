import {expect,test} from "@playwright/test";

test.use({serviceWorkers:"block"});
const hostA="11111111-1111-4111-8111-111111111111",hostB="22222222-2222-4222-8222-222222222222";
const containerA="33333333-3333-4333-8333-333333333333",containerB="44444444-4444-4444-8444-444444444444";
const now=Date.now()/1000;
const series=(value:number,labels:Record<string,string>={})=>[{labels,points:[[now-60,value],[now,value+1]]}];
const hosts=[hostA,hostB].map((id,i)=>({id,hostname:i?"beta":"alpha",ip_address:`10.100.0.${i+1}`,operating_system:"Test Linux",os_version:"1",
  monitoring_enabled:true,log_collection_enabled:!i,is_docker_host:true,container_inventory_at:new Date().toISOString(),
  status:i?"No data":"Monitored",last_sample:i?null:now,
  metrics:i?{}:{cpu:series(40),memory:series(60),disk:series(70,{mountpoint:"/data"}),uptime:series(2000),load1:series(1),
    last_sample:series(now),services:series(0,{unit:"app.service"}),service_sample:series(now,{unit:"app.service"})},
  alerts:i?null:[{name:"TestAlert",severity:"warning",summary:"Actual test source",starts_at:new Date().toISOString()}],
  services:[{id:"check",target:"app.service",check_type:"systemd_unit",enabled:true}]}));
const containers=[containerA,containerB].map((id,i)=>({id,host_id:i?hostB:hostA,hostname:i?"beta":"alpha",name:"same-name",runtime_id:String(i+1).repeat(64),image:"app:1",status:i?"exited":"running",health:null,restart_count:0,last_seen:new Date().toISOString(),metadata:{exit_code:0,memory_limit:null},metrics:i?{}:{cpu:series(210),memory:series(120000000)}}));
let logsUnavailable=false;
test.beforeEach(async({page})=>{
  logsUnavailable=false;
  await page.addInitScript(()=>(document.cookie = "ops_refresh=" + "pwa-test-only" + "; path=/"));
  await page.route("**/api/monitoring/fleet?*",r=>{
    const id=new URL(r.request().url()).searchParams.get("host_id");
    return r.fulfill({json:{hosts:hosts.filter(h=>!id||h.id===id),containers:containers.filter(c=>!id||c.host_id===id),errors:{},container_errors:{},alerts_available:true}});
  });
  await page.route("**/api/monitoring/containers/*",r=>{
    const path=new URL(r.request().url()).pathname;
    if(path.endsWith("/stats"))return r.fulfill({json:{CPUPerc:"211%",MemUsage:"120MB / 8GB"}});
    if(path.endsWith("/events"))return r.fulfill({json:{state:"available",events:[]}});
    return r.fulfill({json:containers.find(c=>path.endsWith(c.id))});
  });
  await page.route("**/api/metrics/services",r=>r.fulfill({json:{available:true,services:[]}}));
  await page.route("**/api/hosts",r=>r.fulfill({json:hosts}));
  await page.route("**/api/logs?*",r=>{
    const q=new URL(r.request().url()).searchParams;
    const state=logsUnavailable?"unavailable":q.get("host_id")===hostB?"not_configured":"available";
    return r.fulfill({json:{available:state!=="unavailable",state,message:state==="unavailable"?"Loki is unavailable":undefined,
      source:q.has("container_id")?"docker":"loki",next_cursor:q.has("cursor")?null:"older",
      lines:state!=="available"?[]:[{timestamp:String(BigInt(Math.floor(now))*1000000000n-(q.has("cursor")?60000000000n:0n)),
        labels:{host:q.get("host_id")===hostB?"beta":"alpha",unit:"app.service"},line:q.has("cursor")?"older message":"<img src=x onerror=alert(1)> is plain text"}],levels:[]}});
  });
});

test("host metrics → scoped host logs → containers → scoped container metrics/logs; URL keeps time",async({page})=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
 const requests:string[]=[];page.on("request",r=>{if(r.url().includes("/api/logs?"))requests.push(r.url());});
 await page.goto("/monitoring?minutes=360&auto=off");
 await expect(page.locator(`a[href*="/monitoring/hosts/${hostB}"]`).getByText("No data",{exact:true})).toBeVisible();
 await expect(page.getByText("min 40%",{exact:true})).toBeVisible();
 await page.locator(`a[href*="/monitoring/hosts/${hostA}"]`).focus();
 await page.keyboard.press("Enter");
 await page.getByRole("tab",{name:"Metrics",exact:true}).click();
 await expect(page.getByRole("heading",{name:"Load average · 1 minute",exact:true})).toBeVisible();
 await page.getByRole("tab",{name:"Logs",exact:true}).click();
 await expect(page.getByText("<img src=x onerror=alert(1)> is plain text",{exact:true})).toBeVisible();
 expect(await page.locator('img[src="x"]').count()).toBe(0);
 expect(new URL(requests[0]).searchParams.get("host_id")).toBe(hostA);
 await page.getByRole("button",{name:"Load older logs"}).click();await expect(page.getByText("older message",{exact:true})).toBeVisible();
 await page.getByRole("tab",{name:"Containers",exact:true}).click();
 await page.getByRole("link",{name:"same-name",exact:true}).click();
 await expect(page.getByText("Healthcheck: Not configured",{exact:true})).toBeVisible();
 await page.getByRole("tab",{name:"Metrics",exact:true}).click();
 await expect(page.getByRole("heading",{name:"CPU · 100% per core",exact:true})).toBeVisible();
 await expect(page.getByText("211%",{exact:true})).toBeVisible();
 await page.getByRole("tab",{name:"Logs",exact:true}).click();
 await expect(page.getByText("<img src=x onerror=alert(1)> is plain text",{exact:true})).toBeVisible();
 const q=new URL(requests[requests.length-1]).searchParams;
 expect(q.get("container_id")).toBe(containerA);expect(q.get("host_id")).toBe(hostA);expect(q.get("minutes")).toBe("360");
 await page.getByRole("link",{name:"Open in Logs",exact:true}).click();
 await expect(page.getByRole("heading",{name:"Logs",exact:true})).toBeVisible();
 expect(new URL(page.url()).searchParams.get("container_id")).toBe(containerA);
 expect(errors).toEqual([]);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test("fleet container filters do not mix same names; historical URL and unavailable logs preserve navigation",async({page})=>{
 await page.goto("/monitoring?minutes=1440&auto=off");await page.getByRole("tab",{name:"Containers",exact:true}).click();
 await expect(page.getByRole("link",{name:"same-name",exact:true})).toHaveCount(2);
 await page.getByRole("combobox",{name:"Filter host",exact:true}).selectOption(hostB);
 await expect(page.getByRole("link",{name:"same-name",exact:true})).toHaveCount(1);
 await page.getByRole("link",{name:"same-name",exact:true}).click();expect(page.url()).toContain(containerB);
 await page.getByRole("tab",{name:"Logs",exact:true}).click();
 await expect(page.getByText(/Log collection not configured/)).toBeVisible();
 await page.getByRole("tab",{name:"Metrics",exact:true}).click();
 await expect(page.getByText("No collected data in this time range. The collector may not provide this metric.").first()).toBeVisible();
 await page.goBack(); // browser URL navigation remains functional
 await page.goto(`/monitoring/hosts/${hostA}?minutes=1440&auto=off&tab=logs`);
 logsUnavailable=true;
 await page.getByRole("button",{name:"Refresh logs",exact:true}).click();
 await expect(page.getByRole("alert").filter({hasText:"Loki is unavailable"})).toBeVisible();
 await page.getByRole("tab",{name:"Containers",exact:true}).click();await expect(page.getByRole("link",{name:"same-name",exact:true})).toBeVisible();
 expect(new URL(page.url()).searchParams.get("minutes")).toBe("1440");
});

test("live logs stop polling when the tab is inactive",async({page})=>{
 await page.clock.install();let calls=0;page.on("request",r=>{if(r.url().includes("/api/logs?"))calls++;});
 await page.goto(`/monitoring/hosts/${hostA}?minutes=15&auto=off&tab=logs&log_live=1`);
 await expect(page.getByText("<img src=x onerror=alert(1)> is plain text",{exact:true})).toBeVisible();
 await page.clock.fastForward(10001);await expect.poll(()=>calls).toBeGreaterThan(1);
 await page.getByRole("tab",{name:"Overview",exact:true}).click();const stopped=calls;
 await page.clock.fastForward(30001);expect(calls).toBe(stopped);
});

test("one real sample shows its actual min/max without fabricating a graph",async({page})=>{
 await page.route("**/api/monitoring/fleet?*",r=>r.fulfill({json:{hosts:[{...hosts[0],metrics:{memory:[{labels:{},points:[[now,63]]}]}}],containers:[],errors:{},container_errors:{},alerts_available:true}}));
 await page.goto("/monitoring?minutes=15&auto=off");
 const host=page.locator(`a[href*="/monitoring/hosts/${hostA}"]`);
 await expect(host.getByText("Only one sample in this time range",{exact:true})).toBeVisible();
 await expect(host.getByText("min 63%",{exact:true})).toBeVisible();
 await expect(host.getByText("max 63%",{exact:true})).toBeVisible();
 expect(await host.locator('svg path.stroke-primary').count()).toBe(0);
});
