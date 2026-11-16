import { expect, test } from "@playwright/test";

import { signInWithFullData } from "./mobile-fixtures";

/** Runs on the phone profiles: touch, a real mobile viewport, and Safari's engine on the iPhone profile. */
test.use({ serviceWorkers: "block" });
test.beforeEach(async ({ page }) => { await signInWithFullData(page); });

const sideways = (page: import("@playwright/test").Page) => page.evaluate(() => {
  const main = document.querySelector("main");
  return Math.max(document.documentElement.scrollWidth - innerWidth, main ? main.scrollWidth - main.clientWidth - 1 : 0);
});

test("the page can be zoomed", async ({ page }) => {
  await page.goto("/");
  const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
  expect(viewport).toContain("width=device-width");
  expect(viewport).not.toMatch(/maximum-scale|user-scalable\s*=\s*no/);
});

test("the menu opens, shows where you are, reaches every page and closes", async ({ page }) => {
  await page.goto("/alerts");
  const toggle = page.getByRole("button", { name: "Open menu" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.tap();
  const menu = page.locator("#ops-navigation");
  await expect(menu.locator('a[aria-current="page"]')).toHaveText(/Alerts/);
  await expect.poll(async () => (await menu.boundingBox())!.x).toBe(0);
  const box = (await menu.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);

  // Groups fold, so open each one and check what it holds.
  let reached = 0;
  for (const group of await menu.locator("button[aria-controls]").all()) {
    if (await group.getAttribute("aria-expanded") === "false") await group.tap();
    const links = menu.locator(`[id="${await group.getAttribute("aria-controls")}"] a[href]`);
    await expect(links.first()).toBeVisible();
    for (const link of await links.all()) {
      await link.scrollIntoViewIfNeeded();
      expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
      reached += 1;
    }
  }
  expect(reached).toBeGreaterThan(20);

  await menu.getByRole("button", { name: "Close menu" }).tap();
  await expect(page.getByRole("button", { name: "Open menu" })).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Open menu" }).tap();
  await menu.getByRole("link", { name: "Servers", exact: true }).first().tap();
  await expect(page).toHaveURL(/\/servers$/);
  await expect(page.getByRole("button", { name: "Open menu" })).toHaveAttribute("aria-expanded", "false");
});

test("the keyboard closes the menu and returns to the button", async ({ page }) => {
  await page.goto("/alerts");
  await page.getByRole("button", { name: "Open menu" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('#ops-navigation a[aria-current="page"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open menu" })).toBeFocused();
});

test("the header takes little space and covers nothing", async ({ page }) => {
  await page.goto("/servers");
  const header = (await page.locator("header").first().boundingBox())!;
  const main = (await page.locator("main").boundingBox())!;
  expect(header.height).toBeLessThanOrEqual(56);
  expect(main.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
});

test("a long dialog fits, scrolls and closes", async ({ page }) => {
  await page.goto("/servers");
  await page.getByRole("button", { name: "Add Server" }).tap();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  const scroll = await dialog.evaluate((el) => { el.scrollTop = 99999; return { top: el.scrollTop, room: el.scrollHeight - el.clientHeight }; });
  expect(scroll.top).toBeGreaterThan(0);
  expect(scroll.top).toBeGreaterThanOrEqual(scroll.room - 1);
  await dialog.evaluate((el) => { el.scrollTop = 0; });
  const close = page.getByRole("button", { name: "Close dialog" });
  const size = (await close.boundingBox())!;
  expect(size.width).toBeGreaterThanOrEqual(44);
  expect(size.height).toBeGreaterThanOrEqual(44);
  await close.tap();
  await expect(dialog).toBeHidden();
});

test("no field makes iOS zoom the page", async ({ page }) => {
  for (const path of ["/servers", "/logs", "/jobs"]) {
    await page.goto(path);
    await expect(page.locator("main input, main select").first()).toBeVisible();
    const sizes = await page.locator("main input:not([type=checkbox]):not([type=radio]), main select, main textarea").evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).fontSize)));
    expect(Math.min(...sizes), path).toBeGreaterThanOrEqual(16);
  }
});

test("long log lines scroll in their own box", async ({ page }) => {
  await page.goto("/logs");
  await expect(page.getByText(/TASK \[install security updates\]/).first()).toBeVisible();
  expect(await sideways(page)).toBeLessThanOrEqual(0);
});

test("sorting still works when the table is cards", async ({ page }) => {
  await page.goto("/containers/example-production-database-cluster-node-1");
  const first = page.locator("tbody tr").first().locator('td[data-label="Name"]');
  await expect(first).toBeVisible();
  const before = await first.innerText();
  const header = page.locator("thead th.cursor-pointer", { hasText: "Name" });
  await expect(header).toBeVisible();
  await header.tap();
  await expect(first).not.toHaveText(before);
});

test("landscape works", async ({ page }) => {
  const { width, height } = page.viewportSize()!;
  await page.setViewportSize({ width: height, height: width });
  for (const path of ["/", "/servers", "/alerts", "/ai-agents/agents"]) {
    await page.goto(path);
    await expect(page.locator("h1").first()).toBeVisible();
    await page.waitForTimeout(300);
    expect(await sideways(page), path).toBeLessThanOrEqual(0);
  }
});

test("doubled text size does not break the page", async ({ page }) => {
  for (const path of ["/", "/servers", "/alerts", "/jobs"]) {
    await page.goto(path);
    await expect(page.locator("h1").first()).toBeVisible();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.waitForTimeout(300);
    expect(await sideways(page), path).toBeLessThanOrEqual(0);
  }
});
