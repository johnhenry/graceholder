import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listGoldens, readGolden, actualOutput, updateGoldens, serialize } from "./golden-harness.js";
import { findBanned, stripComments, checkDir } from "../scripts/check-banned.mjs";
import { fileURLToPath } from "node:url";

test("golden harness: list, read, run and update", () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-golden-"));
  try {
    const g = { name: "x", header: { locale: "en", keyScheme: "gh1" }, input: { query: "{ a }", options: { seed: 1 } }, output: null };
    writeFileSync(join(dir, "x.json"), serialize(g));
    writeFileSync(join(dir, "ignored.txt"), "no");
    assert.equal(listGoldens(dir).length, 1);
    const run = (q, o) => ({ q, seed: o.seed });
    assert.deepEqual(actualOutput(readGolden(listGoldens(dir)[0]), run), { q: "{ a }", seed: 1 });
    updateGoldens(dir, run);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "x.json"), "utf8")).output, { q: "{ a }", seed: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("banned-token check finds clock, random, env and locale reads", () => {
  const bad = [
    "Math.random()",
    "Date.now()",
    "new Date()",
    "performance.now()",
    "crypto.randomUUID()",
    "process.env.X",
    "d.toLocaleString()",
    "Intl.DateTimeFormat()",
  ];
  for (const src of bad) assert.equal(findBanned(src).length, 1, src);
  assert.equal(findBanned("new Date(0).toISOString()").length, 0);
  assert.equal(findBanned("// Math.random is banned\n/* Date.now */ const a = 1;").length, 0);
  assert.equal(stripComments("const u = 'https://x.y'; // c").includes("https://x.y"), true);
});

test("src/ passes the banned-token check", () => {
  const src = fileURLToPath(new URL("../src", import.meta.url));
  assert.deepEqual(checkDir(src), []);
});
