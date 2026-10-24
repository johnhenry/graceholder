// Real-browser smoke test: runs the bundled library in headless Chromium and compares every
// golden with the Node output. Skipped when no Chromium is installed; set GRACEHOLDER_BROWSER=1
// to make a missing browser a failure (npm run test:browser).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

test("headless Chromium: the fetch adapter answers a real fetch() like graceholder()", { skip: !exe && !required ? "no Chromium installed (set PLAYWRIGHT_CHROMIUM)" : false }, async () => {
  assert.ok(exe, "GRACEHOLDER_BROWSER=1 but no Chromium was found");
  const { chromium } = await import("playwright-core");
  const { build } = await import("esbuild");
  const { graceholder } = await import("../src/index.js");
  const adapter = (
    await build({
      entryPoints: [fileURLToPath(new URL("../src/adapters/fetch.js", import.meta.url))],
      bundle: true,
      format: "iife",
      globalName: "GraceholderFetch",
      platform: "browser",
      target: "es2022",
      write: false,
      logLevel: "silent",
    })
  ).outputFiles[0].text;
  const query = "{ users { id name email } }";
  const opts = { seed: "browser", spec: { users: { count: 3 } } };
  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><title>graceholder</title>");
    await page.addScriptTag({ content: adapter });
    const out = await page.evaluate(async ([q, o]) => {
      const f = GraceholderFetch.createFetch(o);
      const res = await f("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q }) });
      return { status: res.status, body: await res.json() };
    }, [query, opts]);
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { data: graceholder(query, opts) });
  } finally {
    await browser.close();
  }
});
