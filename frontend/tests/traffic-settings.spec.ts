import { expect, test } from "@playwright/test";
test.use({ serviceWorkers: "block" });

test("configure an arbitrary registered server and use its dynamic traffic filter", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ops_center_token", "pwa-test-only"));
  const hostId="11111111-1111-4111-8111-111111111111";
  let config={revision:0,enabled:false,sources:[] as Record<string,unknown>[],allowed_countries:[] as string[],trusted_dns:[] as string[],retention_days:30,max_rows:500000,notify_authentication:true};
  await page.route("**/api/hosts",route=>route.fulfill({json:[{id:hostId,hostname:"my-gateway",ssh_host_fingerprint:"synthetic"}]}));
  await page.route("**/api/settings/traffic", async route=>{
    if(route.request().method()==="PUT") config={...route.request().postDataJSON(),revision:config.revision+1};
    return route.fulfill({json:config});
  });
  await page.goto("/settings");
  await page.getByRole("button",{name:"Add traffic source"}).click();
  await page.getByLabel("Source ID",{exact:true}).fill("my-access");
  await page.getByLabel("Display name",{exact:true}).fill("My gateway access");
  await page.getByLabel("Absolute log path or glob").fill("/var/log/custom/access*.log");
  await page.getByLabel("Trusted countries for application/VPN logins").fill("Germany, Netherlands");
  await page.getByLabel("Trusted dynamic DNS hostnames").fill("home.example.com");
  await page.getByLabel("Enable traffic collection and security analysis").check();
  await page.getByRole("button",{name:"Save traffic settings"}).click();
  await expect(page.getByRole("status").filter({hasText:"Settings saved"})).toBeVisible();
  expect(config.sources[0]).toMatchObject({id:"my-access",host_id:hostId,label:"My gateway access",log_path:"/var/log/custom/access*.log"});
  expect(config.allowed_countries).toEqual(["Germany","Netherlands"]);
  await page.reload();
  await expect(page.getByLabel("Display name",{exact:true})).toHaveValue("My gateway access");
  await page.screenshot({path:`test-results/traffic-settings-${test.info().project.name}.png`});
  await page.route("**/api/traffic/history?*",route=>route.fulfill({json:{enabled:true,now:Date.now()/1000,events:[],destinations:{},stats:{total:0,clients:0,countries:0,errors:0,handshakes:0},countries:[],timeline:[],sources:[{name:"my-access",label:"My gateway access",kind:"npm",last_success:Date.now()/1000,error:null,files:1}],retention_days:30,max_rows:500000}}));
  await page.route("**/api/traffic/security?*",route=>route.fulfill({json:{alerts:[],authentication:[],logins:[]}}));
  await page.route("**/api/traffic/security/banner",route=>route.fulfill({json:{enabled:false,sources:[],alerts:[],observations:[]}}));
  await page.goto("/traffic-map");
  await expect(page.getByText("1/1 current")).toBeVisible();
  await page.getByRole("button",{name:"My gateway access",exact:true}).click();
  await expect(page).toHaveURL(/service=my-access/);
  await expect(page.getByText("Collectors live",{exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button",{name:"My gateway access",exact:true})).toHaveAttribute("aria-pressed","true");
});

for (const path of ["/traffic-map","/traffic-map/wallboard"]) {
  test("authentication banner scrolls out of the viewport: "+path, async ({page})=>{
    await page.addInitScript(()=>localStorage.setItem("ops_center_token","pwa-test-only"));
    await page.route("**/api/traffic/history?*",route=>route.fulfill({json:{enabled:true,now:Date.now()/1000,events:[],destinations:{},stats:{total:0,clients:0,countries:0,errors:0,handshakes:0},countries:[],timeline:[],sources:[]}}));
    await page.route("**/api/traffic/security?*",route=>route.fulfill({json:{alerts:[],authentication:[],logins:[]}}));
    await page.route("**/api/traffic/security/banner",route=>route.fulfill({json:{enabled:true,last_success:Date.now()/1000,sources:[],alerts:[],observations:[]}}));
    await page.goto(path);
    const banner=page.getByRole("complementary",{name:"Live authentication notices"});
    await expect(banner).toBeVisible();
    const before=(await banner.boundingBox())!.y;
    await banner.evaluate(node=>{
      let parent=node.parentElement;
      while(parent && parent.scrollHeight<=parent.clientHeight+20) parent=parent.parentElement;
      if(parent)parent.scrollTop=600;
      else window.scrollTo(0,600);
    });
    await expect.poll(async()=>before-(await banner.boundingBox())!.y).toBeGreaterThan(100);
  });
}
