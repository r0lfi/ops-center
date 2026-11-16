import { expect, test } from "@playwright/test";

import { ROUTES, signInWithFullData } from "./mobile-fixtures";

test.setTimeout(240000);

// Worst-case data on every page: nothing may run sideways, and every field and table adapts.
for (const [width, height, touch] of [[320, 640, true], [375, 812, true], [768, 1024, true], [1440, 900, false]] as const) {
  test(`every page holds at ${width}px`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, viewport: { width, height }, hasTouch: touch, isMobile: touch, serviceWorkers: "block" });
    const page = await context.newPage();
    const crashes: string[] = [];
    page.on("pageerror", (error) => crashes.push(`${page.url()}: ${error.message}`));
    await signInWithFullData(page);
    for (const path of ROUTES) {
      await page.goto(path);
      await page.waitForTimeout(350);
      const result = await page.evaluate(() => {
        const main = document.querySelector("main");
        const fields = [...document.querySelectorAll<HTMLElement>("main input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=range]), main select, main textarea")].filter((el) => el.offsetParent).map((el) => parseFloat(getComputedStyle(el).fontSize));
        return { doc: document.documentElement.scrollWidth - innerWidth, main: main ? main.scrollWidth - main.clientWidth : 0, smallest: Math.min(16, ...fields) };
      });
      expect(result.doc, `${path} page width`).toBeLessThanOrEqual(0);
      expect(result.main, `${path} content width`).toBeLessThanOrEqual(1);
      if (touch) expect(result.smallest, `${path} field text`).toBeGreaterThanOrEqual(16);
    }
    expect(crashes).toEqual([]);
    await context.close();
  });
}
