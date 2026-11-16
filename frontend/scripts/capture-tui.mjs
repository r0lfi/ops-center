// Turn the opstui views written by tui/tests/screenshot.rs into README images.
//   OPSTUI_SCREENSHOT_DIR=/tmp/opstui cargo test --test screenshot -- --ignored   (in tui/)
//   node scripts/capture-tui.mjs /tmp/opstui                                     (in frontend/)
// The pages are local files with synthetic data; nothing else is loaded.
import { readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const source = process.argv[2];
if (!source) throw new Error("Usage: node scripts/capture-tui.mjs <directory with opstui-*.html>");
const output = resolve(dirname(fileURLToPath(import.meta.url)), "../../docs/images/features");
const pages = (await readdir(source)).filter(name => /^opstui-[a-z]+\.html$/.test(name));
if (!pages.length) throw new Error(`No opstui-*.html in ${source}`);
const browser = await chromium.launch({ headless: true });
try {
  for (const name of pages) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1 });
    await page.route("**/*", route => route.request().url().startsWith("file:") ? route.continue() : route.abort());
    await page.goto(pathToFileURL(resolve(source, name)).href);
    await page.locator("pre").screenshot({ path: resolve(output, name.replace(".html", ".png")) });
    console.log(`Captured ${name.replace(".html", ".png")}`);
    await page.close();
  }
} finally { await browser.close(); }
