import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: { baseURL: "http://127.0.0.1:4175", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", testMatch: ["**/pwa.spec.ts", "**/ios-install.spec.ts", "**/session-renewal.spec.ts", "**/traffic-auth.spec.ts", "**/traffic-settings.spec.ts", "**/traffic-wallboard.spec.ts"], use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", testMatch: ["**/pwa.spec.ts", "**/traffic-wallboard.spec.ts"], use: { ...devices["Pixel 7"] } },
    { name: "tablet", testMatch: ["**/pwa.spec.ts", "**/traffic-wallboard.spec.ts"], use: { ...devices["iPad Pro 11"], defaultBrowserType: "chromium" } },
    { name: "ipad-webkit", testMatch: ["**/ios-install.spec.ts", "**/session-renewal.spec.ts", "**/traffic-auth.spec.ts", "**/traffic-settings.spec.ts", "**/traffic-wallboard.spec.ts"], use: { ...devices["iPad Pro 11"], defaultBrowserType: "webkit" } },
  ],
  webServer: { command: "node tests/pwa-server.mjs", url: "http://127.0.0.1:4175/login", reuseExistingServer: false },
});
