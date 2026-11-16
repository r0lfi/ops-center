import { writeFileSync } from "node:fs";
import { test } from "@playwright/test";

import { ROUTES, signInWithFullData } from "./mobile-fixtures";

test.use({ serviceWorkers: "block" });
test.skip(!process.env.MOBILE_AUDIT, "Measurement tool. Run with MOBILE_AUDIT=<output.json>.");
test.setTimeout(900000);

const VIEWPORTS = [[320, 640, 1], [375, 812, 1], [390, 844, 1], [430, 932, 1], [844, 390, 1], [768, 1024, 1], [1024, 768, 1], [1440, 900, 0]];
const ONLY = process.env.MOBILE_WIDTHS?.split(",").map(Number);

test("measure every page", async ({ browser, baseURL }) => {
  const report: unknown[] = [];
  let errors: string[] = [];
  for (const [width, height, touch] of VIEWPORTS) {
    if (ONLY && !ONLY.includes(width)) continue;
    const context = await browser.newContext({ baseURL, viewport: { width, height }, hasTouch: !!touch, isMobile: !!touch, serviceWorkers: "block" });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message.slice(0, 160)));
    await signInWithFullData(page);
    for (const path of ROUTES) {
      errors = [];
      await page.goto(path);
      await page.waitForTimeout(700);
      const result = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const visible = (el: Element) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
        const describe = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${String(el.getAttribute("class") ?? "").split(/\s+/).slice(0, 4).join(".")} "${(el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 30)}"`;
        const inScroller = (el: Element) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if ((o === "auto" || o === "scroll") && p.tagName !== "MAIN") return true; } return false; };
        const main = document.querySelector("main");
        const wide = [...document.querySelectorAll("body *")].filter((el) => visible(el) && el.getBoundingClientRect().right > vw + 1 && !inScroller(el));
        const spill = [...document.querySelectorAll("main *, [role=dialog] *")].filter((el) => visible(el) && !inScroller(el) && getComputedStyle(el).overflowX === "visible" && el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).display !== "inline" && el.getBoundingClientRect().right + (el.scrollWidth - el.clientWidth) > vw + 1).filter((el, _, all) => !all.some((o) => o !== el && el.contains(o)));
        const leaves = wide.filter((el) => !wide.some((other) => other !== el && el.contains(other)));
        const inView = (el: Element) => !inScroller(el) || true;
        const targets = [...document.querySelectorAll("button, select, summary, [role=button], [role=tab], [role=menuitem], [role=switch], input:not([type=hidden]), textarea, a[href]")].filter((el) => visible(el) && inView(el));
        const inlineLink = (el: Element) => el.tagName === "A" && (getComputedStyle(el).display === "inline" || !!el.closest("p, td, li"));
        const small = targets.filter((el) => { if (inlineLink(el)) return false; const r = el.getBoundingClientRect(); const box = el as HTMLInputElement; if (box.type === "checkbox" || box.type === "radio") return r.width < 24; return r.height < 43.5 || r.width < 43.5; });
        const fields = [...document.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=hidden]), select, textarea")].filter((el) => visible(el) && parseFloat(getComputedStyle(el).fontSize) < 16);
        const texts = [...document.querySelectorAll("main p, main li, main td, main dd")].filter((el) => visible(el) && (el.textContent ?? "").trim().length > 40);
        const smallText = texts.filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16);
        const tables = [...document.querySelectorAll("table")].filter(visible).map((t) => ({ cards: getComputedStyle(t).display === "block", scroller: inScroller(t), over: t.getBoundingClientRect().width - vw }));
        return { doc: document.documentElement.scrollWidth - innerWidth, main: main ? main.scrollWidth - main.clientWidth : 0, wide: [...leaves, ...spill].slice(0, 5).map(describe), tapCount: small.length, taps: [...new Set(small.map(describe))].slice(0, 8), fields: fields.length, texts: texts.length, smallText: smallText.length, tables, h1: document.querySelector("h1")?.textContent ?? null };
      });
      report.push({ width, path, ...result, errors: [...new Set(errors)] });
    }
    await context.close();
  }
  writeFileSync(process.env.MOBILE_AUDIT!, JSON.stringify(report));
});
