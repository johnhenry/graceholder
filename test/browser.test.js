// Real-browser smoke test: runs the bundled library in headless Chromium and compares every
// golden with the Node output. Skipped when no Chromium is installed; set GRACEHOLDER_BROWSER=1
// to make a missing browser a failure (npm run test:browser).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bundle, goldens, callFor } from "./browser-support.js";

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM && existsSync(process.env.PLAYWRIGHT_CHROMIUM)) return process.env.PLAYWRIGHT_CHROMIUM;
  const root = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(root)) return undefined;
  const dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
  for (const d of dirs) {
    for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
      const p = join(root, d, sub);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

const exe = findChromium();
const required = process.env.GRACEHOLDER_BROWSER === "1";

test("headless Chromium reproduces every golden", { skip: !exe && !required ? "no Chromium installed (set PLAYWRIGHT_CHROMIUM)" : false }, async () => {
  assert.ok(exe, "GRACEHOLDER_BROWSER=1 but no Chromium was found");
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><title>graceholder</title>");
    await page.addScriptTag({ content: await bundle() });
    for (const g of goldens()) {
      const { query, options } = callFor(g);
      const out = await page.evaluate(([q, o]) => JSON.stringify(Graceholder.graceholder(q, o)), [query, options]);
      assert.equal(out, JSON.stringify(g.output), g.name);
    }
  } finally {
    await browser.close();
  }
});
