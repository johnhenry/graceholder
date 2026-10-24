import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { bundle, OUT } from "../scripts/build-playground.mjs";

test("playground/graceholder.js is the current build of src/ (run npm run playground:build)", async () => {
  assert.ok(existsSync(OUT), "playground/graceholder.js is missing");
  assert.equal(readFileSync(OUT, "utf8"), await bundle());
});

test("the playground page loads only its own files: no external URLs", () => {
  const html = readFileSync(new URL("../playground/index.html", import.meta.url), "utf8");
  const attrs = [...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)].map((m) => m[1]);
  for (const a of attrs) assert.ok(!/^(https?:)?\/\//.test(a) || a.startsWith("https://github.com/johnhenry/graceholder"), `external reference ${a}`);
  assert.ok(!/@import|url\(\s*["']?https?:/.test(html));
  assert.ok(attrs.includes("graceholder.js"));
  // a classic script, so file:// works
  assert.ok(/<script src="graceholder\.js"><\/script>/.test(html));
  assert.ok(!/type=["']module["']/.test(html));
});
