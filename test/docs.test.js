import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { checkDocs, blocks } from "../scripts/docs.mjs";
import { stabilityText } from "../scripts/gen-stability.mjs";
import { evaluate } from "../scripts/check-golden-change.mjs";
import { GENERATOR_NAMES } from "../src/generators.js";
import { DIRECTIVES } from "../src/directives.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("every ```js example in the README and docs runs, and its output block matches", async () => {
  const problems = await checkDocs();
  assert.deepEqual(problems, []);
});

test("the docs contain runnable examples with recorded output", () => {
  for (const f of ["README.md", "docs/cookbook.md", "docs/api.md"]) {
    const list = blocks(read(f));
    assert.ok(list.some((b) => b.lang === "js"), f);
    assert.ok(list.some((b) => b.lang === "json"), f);
  }
});

test("docs/api.md documents every generator, directive and error code", () => {
  const api = read("docs/api.md");
  for (const n of GENERATOR_NAMES) assert.ok(api.includes(`\`${n}\``), `generator ${n}`);
  for (const d of DIRECTIVES.filter((x) => x !== "one")) assert.ok(api.includes(`@${d}`), `directive @${d}`);
  const errorCodes = [...read("src/index.d.ts").match(/export type ErrorCode =([\s\S]*?);/)[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(errorCodes.length > 15);
  for (const c of errorCodes) assert.ok(api.includes(`\`${c}\``), `error code ${c}`);
});

test("STABILITY.md is generated from the design's stability section", () => {
  assert.equal(read("STABILITY.md"), stabilityText());
  assert.match(read("STABILITY.md"), /byte-identical/);
  assert.ok(JSON.parse(read("package.json")).files.includes("STABILITY.md"));
});

test("README links resolve", () => {
  const readme = read("README.md");
  for (const m of readme.matchAll(/\]\(((?!https?:)[^)#]+)\)/g)) assert.ok(existsSync(new URL(`../${m[1]}`, import.meta.url)), m[1]);
});

test("golden guard: required label from 1.0.0 on, report-only before", () => {
  const changed = ["src/x.js", "test/golden/a.json"];
  assert.equal(evaluate({ version: "0.0.0", changedFiles: changed, labels: [] }).ok, true);
  assert.equal(evaluate({ version: "1.0.0", changedFiles: changed, labels: [] }).ok, false);
  assert.equal(evaluate({ version: "1.2.3", changedFiles: changed, labels: ["breaking"] }).ok, true);
  assert.equal(evaluate({ version: "1.0.0", changedFiles: ["src/x.js"], labels: [] }).ok, true);
});
