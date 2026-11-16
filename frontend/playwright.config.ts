import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: { baseURL: "http://127.0.0.1:4175", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", testMatch: ["**/monitoring.spec.ts", "**/incidents.spec.ts", "**/pwa.spec.ts", "**/ios-install.spec.ts", "**/session-renewal.spec.ts", "**/ai-workspace.spec.ts", "**/traffic-auth.spec.ts", "**/traffic-settings.spec.ts", "**/mcp-access.spec.ts", "**/ai-budget.spec.ts", "**/collaboration.spec.ts", "**/traffic-wallboard.spec.ts", "**/nova.spec.ts", "**/ops-floor-external.spec.ts", "**/nova-memory.spec.ts", "**/nova-routines.spec.ts", "**/gui-*.spec.ts"], use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", testMatch: ["**/ai-workspace.spec.ts", "**/monitoring.spec.ts", "**/incidents.spec.ts", "**/pwa.spec.ts", "**/ai-budget.spec.ts", "**/collaboration.spec.ts", "**/traffic-wallboard.spec.ts", "**/nova.spec.ts", "**/ops-floor-external.spec.ts", "**/nova-memory.spec.ts", "**/nova-routines.spec.ts", "**/gui-numbers.spec.ts"], use: { ...devices["Pixel 7"] } },
    { name: "tablet", testMatch: ["**/ai-workspace.spec.ts", "**/monitoring.spec.ts", "**/incidents.spec.ts", "**/pwa.spec.ts", "**/ai-budget.spec.ts", "**/collaboration.spec.ts", "**/traffic-wallboard.spec.ts", "**/nova.spec.ts", "**/ops-floor-external.spec.ts", "**/nova-memory.spec.ts", "**/nova-routines.spec.ts"], use: { ...devices["iPad Pro 11"], defaultBrowserType: "chromium" } },
    { name: "ipad-webkit", testMatch: ["**/ios-install.spec.ts", "**/session-renewal.spec.ts", "**/traffic-auth.spec.ts", "**/traffic-settings.spec.ts", "**/mcp-access.spec.ts", "**/ai-budget.spec.ts", "**/collaboration.spec.ts", "**/traffic-wallboard.spec.ts"], use: { ...devices["iPad Pro 11"], defaultBrowserType: "webkit" } },
    { name: "iphone-webkit", testMatch: ["**/mobile-devices.spec.ts"], use: { ...devices["iPhone 13"] } },
    { name: "android-chrome", testMatch: ["**/mobile-devices.spec.ts"], use: { ...devices["Pixel 7"] } },
  ],
  webServer: { command: "node tests/pwa-server.mjs", url: "http://127.0.0.1:4175/login", reuseExistingServer: false },
});
