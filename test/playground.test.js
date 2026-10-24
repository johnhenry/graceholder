// Smoke test of the playground page in headless Chromium (Playwright's bundled build; no GPU needed).
// It runs the page from file:// and over http (the way GitHub Pages serves it), blocks the network, and
// checks output, inferred SDL and explain-on-click against the library running in Node.
// Skipped when no Chromium is installed; GRACEHOLDER_BROWSER=1 makes a missing browser a failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { graceholder, explain, inferSchema, registerPack } from "../src/index.js";
import { allPacks } from "../src/packs/index.js";
import { findChromium } from "./chromium-support.js";

for (const p of allPacks) registerPack(p);
const exe = findChromium();
const required = process.env.GRACEHOLDER_BROWSER === "1";
const skip = !exe && !required ? "no Chromium installed (set PLAYWRIGHT_CHROMIUM)" : false;
const DIR = fileURLToPath(new URL("../playground/", import.meta.url));

const QUERY = "{\n  users(first: 4) {\n    id\n    name\n    email\n    createdAt\n    tags\n    posts(first: 2) { title author { name } }\n  }\n}";

function serve() {
  const server = createServer((req, res) => {
    const name = req.url === "/" || req.url?.startsWith("/index.html") ? "index.html" : req.url?.replace(/^\//, "").split(/[?#]/)[0];
    try {
      const body = readFileSync(DIR + name);
      res.writeHead(200, { "content-type": name.endsWith(".js") ? "text/javascript" : name.endsWith(".html") ? "text/html" : "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function exercise(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const attempted = [];
  await context.route("**/*", (route) => {
    const u = route.request().url();
    attempted.push(u);
    const local = u.startsWith("file://") || u.startsWith(url.split("/").slice(0, 3).join("/"));
    return local ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  await page.goto(url);
  await page.waitForSelector("#output .tok");

  // the default example: output is the library's output, byte for byte
  assert.equal(await page.inputValue("#query"), QUERY);
  const seed = await page.inputValue("#seed");
  const expected = graceholder(QUERY, { seed });
  assert.equal(await page.textContent("#output"), JSON.stringify(expected, null, 2));

  // the inferred SDL is the library's
  await page.click("#tab-sdl");
  assert.equal((await page.textContent("#sdl")).trim(), inferSchema(QUERY, undefined, {}).sdl.trim());
  await page.click("#tab-out");

  // explain on click
  await page.click(`[data-path='["users",1,"email"]']`);
  await page.waitForSelector("#explain h3");
  assert.equal((await page.textContent("#explain h3")).startsWith("users.1.email"), true);
  const ex = explain(QUERY, "users.1.email", { seed });
  const panel = await page.textContent("#explain");
  assert.ok(panel.includes(ex.summary), "the summary is shown");
  assert.ok(panel.includes("person.email"));
  assert.ok(panel.includes(ex.key.parts[3]) && panel.includes(ex.key.hash === undefined ? "" : ""), "the key parts are shown");
  assert.equal(await page.$$eval("#explain .keyparts span", (els) => els.map((e) => e.textContent).join("|")), ex.key.parts.join("|"));
  // clicking a list explains the list
  await page.click(`[data-path='["users"]']`);
  assert.ok((await page.textContent("#explain")).includes("list of User"));

  // a different seed gives different data, and the page recomputes
  await page.fill("#seed", "other");
  await page.waitForFunction((t) => document.getElementById("output").textContent !== t, JSON.stringify(expected, null, 2));
  assert.equal(await page.textContent("#output"), JSON.stringify(graceholder(QUERY, { seed: "other" }), null, 2));

  // scenario checkbox
  await page.check("#sc-unicode");
  await page.waitForFunction(() => document.getElementById("output").textContent.length > 0);
  assert.equal(await page.textContent("#output"), JSON.stringify(graceholder(QUERY, { seed: "other", scenario: ["unicode"] }), null, 2));
  await page.uncheck("#sc-unicode");

  // spec editor: an override applies, and invalid JSON is reported instead of thrown
  await page.fill("#spec", JSON.stringify({ "users.name": { pick: ["Ada", "Grace"] } }));
  await page.waitForFunction(() => /"Ada"|"Grace"/.test(document.getElementById("output").textContent));
  await page.fill("#spec", "{ not json");
  await page.waitForSelector("#error:not([hidden])");
  assert.match(await page.textContent("#error"), /Spec is not valid JSON/);
  await page.fill("#spec", "{}");
  await page.waitForSelector("#error[hidden]", { state: "attached" });

  // a query error shows the library's code and message
  await page.fill("#query", "{ users { id }");
  await page.waitForSelector("#error:not([hidden])");
  assert.match(await page.textContent("#error"), /graphql/);
  await page.fill("#query", QUERY);
  await page.waitForSelector("#error[hidden]", { state: "attached" });

  // examples, including a world with a pin
  await page.selectOption("#example", { label: "World with a pin" });
  await page.waitForFunction(() => document.getElementById("output").textContent.includes("pinned@example.com"));
  await page.click(`[data-path='["users",1,"email"]']`);
  await page.waitForFunction(() => /pinned in the world/.test(document.getElementById("explain").textContent));

  assert.deepEqual(problems, []);
  assert.deepEqual(attempted.filter((u) => !(u.startsWith("file://") || u.startsWith(url.split("/").slice(0, 3).join("/")))), [], "no external request was even attempted");
  await context.close();
}

test("the playground works from file:// and over http, offline", { skip }, async () => {
  assert.ok(exe, "GRACEHOLDER_BROWSER=1 but no Chromium was found");
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  const server = await serve();
  try {
    await exercise(browser, pathToFileURL(DIR + "index.html").href);
    await exercise(browser, `http://127.0.0.1:${server.address().port}/index.html`);
  } finally {
    await browser.close();
    server.close();
  }
});

test("a link restores the editors", { skip }, async () => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(DIR + "index.html").href);
    await page.waitForSelector("#output .tok");
    await page.fill("#seed", "linked");
    await page.fill("#query", "{ greeting wordList }");
    await page.waitForFunction(() => location.hash.length > 10 && document.getElementById("output").textContent.includes("greeting"));
    const url = page.url();
    const page2 = await browser.newPage();
    await page2.goto(url);
    await page2.waitForSelector("#output .tok");
    assert.equal(await page2.inputValue("#seed"), "linked");
    assert.equal(await page2.inputValue("#query"), "{ greeting wordList }");
  } finally {
    await browser.close();
  }
});
