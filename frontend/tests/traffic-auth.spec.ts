import { expect, test } from "@playwright/test";
test.use({ serviceWorkers: "block" });
test("authentication log distinguishes outcomes, filters pages and shows DNS failures", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ops_center_token", "pwa-test-only"));
  const errors:string[]=[]; page.on("pageerror", e=>errors.push(e.message));
  await page.route("**/api/traffic/history?*", route=>route.fulfill({json:{
    now:Date.now()/1000,stats:{total:0,clients:0,countries:0,errors:0,handshakes:0},
    events:[],countries:[],timeline:[],sources:[],destinations:{}
  }}));
  await page.route("**/api/traffic/security?*", route=>{
    const query=new URL(route.request().url()).searchParams;
    const result=query.get("auth_result"), offset=Number(query.get("auth_offset"));
    const outcome=result==="failed"?"login_failure":result==="vpn"?"vpn_handshake":"login_success";
    return route.fulfill({json:{
      now:Date.now()/1000,last_success:Date.now()/1000,total:0,unreviewed:0,
      baseline_ready:true,talk_enabled:true,alerts:[],logins:[],auth_total:21,auth_offset:offset,
      auth_policy:{countries:["Norway"],dns_names:["vpn.example"],addresses:[],checked_at:Date.now()/1000,error:"Could not resolve public addresses for vpn.example"},
      authentication:[{id:offset+1,ts:Date.now()/1000,ip:offset?"192.0.2.22":"192.0.2.21",country:"Germany",
        domain:result==="vpn"?"vpn.example":"media.example",status:result==="vpn"?null:result==="failed"?401:200,outcome,origin_reason:null}],
    }});
  });
  await page.goto("/traffic-map");
  const table=page.getByRole("table",{name:"Authentication log",exact:true});
  await expect(table.getByRole("cell",{name:/^Login accepted/})).toBeVisible();
  await expect(table.getByText("Outside allowed origins")).toBeVisible();
  await expect(page.getByRole("alert").filter({hasText:"Unresolved addresses are not exempt"})).toBeVisible();
  await page.getByLabel("Authentication result").selectOption("failed");
  await expect(table.getByRole("cell",{name:/^Login rejected/})).toBeVisible();
  await page.getByRole("button",{name:"Next log page"}).click();
  await expect(table.getByText("192.0.2.22")).toBeVisible();
  await expect(page.getByRole("button",{name:"Next log page"})).toBeDisabled();
  await page.getByLabel("Authentication result").selectOption("vpn");
  await expect(table.getByText("Authenticated VPN handshake", {exact:true})).toBeVisible();
  await expect(table.getByText("192.0.2.21")).toBeVisible();
  await expect(page.getByRole("button",{name:"Previous log page"})).toBeDisabled();
  expect(errors).toEqual([]);
});

for (const path of ["/traffic-map?service=media","/traffic-map/wallboard?service=media"]) {
  test("top authentication notice remains live across filters and pause: "+path, async ({page})=>{
    await page.addInitScript(()=>localStorage.setItem("ops_center_token","pwa-test-only"));
    await page.route("**/api/traffic/history?*", route=>route.fulfill({json:{
      now:Date.now()/1000,stats:{total:0,clients:0,countries:0,errors:0,handshakes:0,http:0},
      events:[],countries:[],timeline:[],sources:[],destinations:{}
    }}));
    await page.route("**/api/traffic/security?*",route=>route.fulfill({json:{alerts:[],logins:[],authentication:[]}}));
    let later=false,failed=false,backendFailed=false;
    await page.route("**/api/traffic/security/banner",route=>backendFailed?route.fulfill({status:503,json:{detail:"Test source unavailable"}}):route.fulfill({json:{
      now:Date.now()/1000,last_success:Date.now()/1000,error:failed?"Test collector unavailable":null,
      sources:["npm","caddy","wireguard","ssh","hagen"].map(name=>({name,last_success:Date.now()/1000,error:null})),
      alerts:[{id:1,title:later?"Successful admin login outside trusted origins":"Successful SSH login outside your current IP",
        severity:"high",domain:later?"admin.example.com":"edge-host",ip:"192.0.2.21",last_seen:Date.now()/1000,evidence:{country:"Germany"},notified_at:null}],
      observations:[{id:2,ts:Date.now()/1000,ip:"192.0.2.22",country:"Germany",domain:"admin.example.com",kind:"auth",outcome:"login_failure"}]
    }}));
    await page.goto(path);
    const banner=page.getByRole("complementary",{name:"Live authentication notices"});
    await expect(banner.getByText("High priority authentication alert",{exact:true})).toBeVisible();
    await expect(banner.getByText("Successful SSH login outside your current IP",{exact:true})).toBeVisible();
    await expect(banner.getByText("Login rejected",{exact:true})).toBeVisible();
    expect((await banner.boundingBox())!.y).toBeLessThan((await page.locator(".traffic-toolbar").boundingBox())!.y);
    await page.getByRole("button",{name:"Pause",exact:true}).click();
    later=true;
    await expect(banner.getByText("Successful admin login outside trusted origins",{exact:true})).toBeVisible({timeout:10000});
    await expect(page).toHaveURL(/service=media/);
    const expandedHeight=(await banner.boundingBox())!.height;
    await banner.getByRole("button",{name:"Minimize authentication notices"}).click();
    await expect(banner.getByRole("button",{name:"Expand authentication notices"})).toHaveAttribute("aria-expanded","false");
    await expect(banner.getByText("Successful admin login outside trusted origins",{exact:true})).toBeHidden();
    expect((await banner.boundingBox())!.height).toBeLessThan(expandedHeight);
    await page.reload();
    await expect(banner.getByRole("button",{name:"Expand authentication notices"})).toBeVisible();
    await expect(banner.getByText("High priority authentication alert",{exact:true})).toBeVisible();
    await page.screenshot({path:"test-results/auth-banner-minimized-"+test.info().project.name+".png"});
    failed=true;
    await expect(banner.getByRole("alert")).toContainText("Last received observations may be incomplete",{timeout:10000});
    await banner.getByRole("button",{name:"Expand authentication notices"}).click();
    await expect(banner.getByText("Successful admin login outside trusted origins",{exact:true})).toBeVisible();
    await page.screenshot({path:"test-results/auth-banner-expanded-"+test.info().project.name+".png"});
    backendFailed=true;
    await expect(page.getByRole("alertdialog",{name:"Ops Center is currently offline"})).toBeVisible({timeout:10000});
  });
}
