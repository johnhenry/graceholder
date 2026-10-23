import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { suggestSpec, buildSuggestPrompt, SUGGEST_PROMPT_VERSION, graceholder, inferSchema } from "../src/index.js";

const QUERY = "{ orders { code status total items { name } } }";
const GOOD = { "orders.code": { pattern: "ORD-#####" }, "orders.status": { pick: ["new", "paid"] } };
const stub = (...replies) => {
  const calls = [];
  const llm = async (prompt) => {
    calls.push(prompt);
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    return typeof r === "function" ? r(prompt) : r;
  };
  return { llm, calls };
};
const fail = async (p) => { try { await p; } catch (e) { return e; } return null; };

test("a valid JSON reply becomes the spec, and the spec drives generation", async () => {
  const { llm, calls } = stub(JSON.stringify(GOOD));
  const spec = await suggestSpec(QUERY, { llm });
  assert.deepEqual(spec, GOOD);
  assert.equal(calls.length, 1);
  const out = graceholder(QUERY, { spec });
  assert.ok(out.orders.every((o) => /^ORD-\d{5}$/.test(o.code) && ["new", "paid"].includes(o.status)));
});

test("fenced code blocks and surrounding prose are tolerated", async () => {
  for (const reply of [
    "```json\n" + JSON.stringify(GOOD) + "\n```",
    "```\n" + JSON.stringify(GOOD) + "\n```",
    "Here is the spec:\n```json\n" + JSON.stringify(GOOD, null, 2) + "\n```\nHope that helps!",
    "Sure. " + JSON.stringify(GOOD) + " Done.",
  ]) {
    assert.deepEqual(await suggestSpec(QUERY, { llm: stub(reply).llm }), GOOD);
  }
});

test("invalid JSON triggers one repair round that includes the problems", async () => {
  const { llm, calls } = stub("not json at all", JSON.stringify(GOOD));
  const spec = await suggestSpec(QUERY, { llm });
  assert.deepEqual(spec, GOOD);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /could not be parsed|not valid JSON/i);
  assert.ok(calls[1].includes("not json at all"));
});

test("a spec that violates the Spec schema is repaired once, then rejected", async () => {
  const bad = JSON.stringify({ "orders.code": { nullRate: 5 } });
  const { llm, calls } = stub(bad, JSON.stringify(GOOD));
  assert.deepEqual(await suggestSpec(QUERY, { llm }), GOOD);
  assert.match(calls[1], /nullRate/);

  const twice = stub(bad, bad);
  const e = await fail(suggestSpec(QUERY, { llm: twice.llm }));
  assert.equal(e.code, "bad-suggestion");
  assert.match(e.hint, /nullRate/);
  assert.equal(twice.calls.length, 2); // one repair round only
});

test("an unknown generator in a suggestion is rejected, with a nearest-name hint for the repair", async () => {
  const bad = JSON.stringify({ "orders.code": { gen: "persn.first" } });
  const s = stub(bad, bad);
  const e = await fail(suggestSpec(QUERY, { llm: s.llm }));
  assert.equal(e.code, "bad-suggestion");
  assert.match(e.hint, /persn\.first/);
  assert.match(s.calls[1], /person\.first/);
});

test("paths that match nothing, bad paths and conflicts are validation errors too", async () => {
  for (const [bad, pattern] of [
    [{ "nothing.here": { count: 2 } }, /nothing\.here/],
    [{ "orders..code": {} }, /orders\.\.code/],
    [{ orders: { list: true, one: true } }, /list/],
    [{ "orders.code": { derive: { from: "code" } } }, /derive|cycle/],
    [[], /object/],
    ["text", /object/],
  ]) {
    const s = stub(JSON.stringify(bad), JSON.stringify(bad));
    const e = await fail(suggestSpec(QUERY, { llm: s.llm }));
    assert.equal(e?.code, "bad-suggestion", JSON.stringify(bad));
    assert.match(e.hint, pattern);
  }
});

test("a non-string reply or an empty reply is rejected", async () => {
  assert.equal((await fail(suggestSpec(QUERY, { llm: async () => 42 }))).code, "bad-suggestion");
  assert.equal((await fail(suggestSpec(QUERY, { llm: async () => "" }))).code, "bad-suggestion");
});

test("an llm that throws is not swallowed", async () => {
  const e = await fail(suggestSpec(QUERY, { llm: async () => { throw new Error("network down"); } }));
  assert.equal(e.message, "network down");
});

test("the prompt carries the query, SDL, decisions, grammar and generator names", async () => {
  const { llm, calls } = stub(JSON.stringify({}));
  await suggestSpec(QUERY, { llm, spec: { "orders.code": { pattern: "X-##" } } });
  const p = calls[0];
  assert.ok(p.includes(QUERY));
  assert.ok(p.includes(inferSchema(QUERY).sdl.trim().split("\n")[0]));
  for (const needle of ["person.first", "datetime", "oneOf", "pattern", "**", "@Type.field", "JSON", SUGGEST_PROMPT_VERSION, "X-##", "T11", "orders.status"]) {
    assert.ok(p.includes(needle), needle);
  }
});

test("prompt snapshot (wording is not part of the output-stability guarantee)", () => {
  const file = new URL("./snapshots/suggest-prompt.txt", import.meta.url);
  const actual = buildSuggestPrompt(QUERY, undefined);
  if (process.env.UPDATE_SNAPSHOTS || !existsSync(file)) writeFileSync(file, actual);
  assert.equal(actual, readFileSync(file, "utf8"));
});

test("the existing spec is carried into the request and the result is validated against the query", async () => {
  const existing = { "orders.total": { gen: { name: "money", args: { min: 5, max: 9 } } } };
  const { llm } = stub(JSON.stringify({ ...existing, ...GOOD }));
  const spec = await suggestSpec(QUERY, { llm, spec: existing });
  assert.deepEqual(spec, { ...existing, ...GOOD });
  const out = graceholder(QUERY, { spec, seed: "s" });
  assert.ok(out.orders.every((o) => o.total >= 5 && o.total <= 9.99));
});

test("the core has no LLM dependency", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(pkg.dependencies), ["graphql"]);
  // client adapters add peers, but only optional ones (test/adapters-bundle.test.js checks which)
  for (const k of Object.keys(pkg.peerDependencies ?? {})) assert.equal(pkg.peerDependenciesMeta?.[k]?.optional, true, k);
  assert.equal(pkg.optionalDependencies, undefined);
  const banned = /anthropic|openai|langchain|ollama|@google|cohere|mistral|llamaindex|ai-matey/i;
  for (const k of [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies), ...Object.keys(pkg.peerDependencies ?? {})]) assert.ok(!banned.test(k), k);
});

test("suggestSpec knows the packs and distributions the data will be generated with", async () => {
  const { geo } = await import("../src/packs/geo.js");
  const q = "{ users { id city timezone } }";
  const prompt = buildSuggestPrompt(q, undefined, { packs: [geo], distributions: "realistic" });
  assert.match(prompt, /geo\.timezone/);
  assert.match(prompt, /timezone \| scalar \| "String" \| heuristic \| P1/);
  assert.ok(!buildSuggestPrompt(q).includes("geo.timezone"));
  // a reply that uses a pack generator validates only when the pack is passed
  const reply = JSON.stringify({ "users.city": { gen: "geo.timezone" } });
  await assert.rejects(suggestSpec(q, { llm: async () => reply }), (e) => e.code === "bad-suggestion");
  assert.deepEqual(await suggestSpec(q, { llm: async () => reply, packs: [geo] }), JSON.parse(reply));
});
