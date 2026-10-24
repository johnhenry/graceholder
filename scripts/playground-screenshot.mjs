// Writes playground/screenshot.png: the playground with a value explained (needs Playwright's Chromium).
import { chromium } from "playwright-core";
import { pathToFileURL, fileURLToPath } from "node:url";
import { findChromium } from "../test/chromium-support.js";

const dir = fileURLToPath(new URL("../playground/", import.meta.url));
const exe = findChromium();
if (!exe) throw new Error("no Chromium found; set PLAYWRIGHT_CHROMIUM");
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1360, height: 1040 }, colorScheme: "light" });
await page.goto(pathToFileURL(`${dir}index.html`).href);
await page.waitForSelector("#output .tok");
await page.click(`[data-path='["users",1,"email"]']`);
await page.waitForSelector("#explain h3");
await page.screenshot({ path: `${dir}screenshot.png`, fullPage: true });
await browser.close();
console.log(`wrote ${dir}screenshot.png`);
