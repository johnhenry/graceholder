import { test } from "node:test";
import assert from "node:assert/strict";
import { generate, GENERATOR_NAMES, GRAPH_GENERATORS, asciiFold } from "../src/generators.js";
import { keyStream } from "../src/key.js";
import { Stream } from "../src/rng.js";
import { GraceholderError } from "../src/errors.js";

const ANCHOR = Date.parse("2025-01-01T00:00:00.000Z");
const ctxFor = (i, args = {}, extra = {}) => ({
  stream: new Stream(BigInt(i) * 0x9e3779b97f4a7c15n + 1n),
  slot: (name) => keyStream({ seed: i, scope: "p", typeName: "T", entityKey: "7", fieldName: name }),
  anchorMs: ANCHOR,
  args,
  typeName: "Thing",
  entityKey: "7",
  fieldName: "f",
  ...extra,
});
const many = (name, args, n = 60) => Array.from({ length: n }, (_, i) => generate(name, ctxFor(i, args)));

test("every generator is pure: same stream state, same value", () => {
  for (const name of GENERATOR_NAMES.filter((n) => !GRAPH_GENERATORS.includes(n))) {
    const args = name === "oneOf" ? { values: ["a", "b", "c"] } : name === "pattern" ? { p: "AA-##" } : {};
    assert.deepEqual(generate(name, ctxFor(3, args)), generate(name, ctxFor(3, args)), name);
  }
});

test("unknown generator is an error with a hint", () => {
  assert.throws(
    () => generate("persn.first", ctxFor(1)),
    (e) => e instanceof GraceholderError && e.code === "unknown-generator" && /person\.first/.test(e.hint),
  );
});

test("id.key: decimal entity keys pass through, others hash to a stable number", () => {
  assert.equal(generate("id.key", ctxFor(1, {}, { entityKey: "42" })), "42");
  const a = generate("id.key", ctxFor(1, {}, { entityKey: "1.comments.3" }));
  assert.match(a, /^[1-9][0-9]{0,5}$/);
  assert.equal(a, generate("id.key", ctxFor(1, {}, { entityKey: "1.comments.3" })));
});

test("id.int and id.uuid", () => {
  for (const v of many("id.int", { min: 1, max: 100, string: true })) assert.match(v, /^(100|[1-9][0-9]?)$/);
  for (const v of many("id.int", { min: 5, max: 6 })) assert.ok(v === 5 || v === 6);
  for (const v of many("id.uuid")) assert.match(v, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("numbers: int, float, money, percent, bool", () => {
  for (const v of many("int", { min: 3, max: 9 })) assert.ok(Number.isInteger(v) && v >= 3 && v <= 9);
  for (const v of many("float", { min: -1, max: 1, decimals: 3 })) {
    assert.ok(v >= -1 && v <= 1);
    assert.equal(Math.round(v * 1000) / 1000, v);
  }
  for (const v of many("money", { min: 1, max: 50 })) {
    assert.ok(v >= 1 && v <= 50);
    assert.equal(Math.round(v * 100) / 100, v);
  }
  for (const v of many("percent")) assert.ok(v >= 0 && v <= 100);
  const bools = many("bool");
  assert.ok(bools.includes(true) && bools.includes(false));
  assert.ok(many("bool", { p: 0 }).every((b) => b === false));
  assert.throws(() => generate("int", ctxFor(1, { min: 5, max: 1 })), (e) => e.code === "bad-generator-args");
});

test("text: word, words, sentence, paragraph, title, slug, lorem", () => {
  for (const v of many("word")) assert.match(v, /^[a-z]+$/);
  for (const v of many("words", { n: 2 })) assert.match(v, /^[a-z]+ [a-z]+$/);
  for (const v of many("sentence")) assert.match(v, /^[A-Z][a-z ]+\.$/);
  for (const v of many("paragraph")) assert.ok(v.split(". ").length >= 3 && v.endsWith("."));
  for (const v of many("title")) assert.match(v, /^([A-Z][a-z]+ ?)+$/);
  for (const v of many("slug")) assert.match(v, /^[a-z]+(-[a-z]+)+$/);
  for (const v of many("sentences", { n: 3 })) assert.equal(v.match(/\./g).length, 3);
  assert.equal(typeof generate("lorem", ctxFor(1)), "string");
});

test("person.*", () => {
  for (const v of many("person.first")) assert.match(v, /^\p{Lu}\p{L}+$/u);
  for (const v of many("person.last")) assert.match(v, /^\p{Lu}\p{L}+$/u);
  for (const v of many("person.full")) assert.match(v, /^\p{Lu}\p{L}+ \p{Lu}\p{L}+$/u);
  for (const v of many("person.username")) assert.match(v, /^[a-z0-9.]+$/);
  for (const v of many("person.email")) assert.match(v, /^[a-z0-9.]+@[a-z.]+\.(com|org|net)$/);
  for (const v of many("person.phone")) assert.match(v, /^\(\d{3}\) 555-01\d{2}$/);
  for (const v of many("person.jobTitle")) assert.match(v, /^[A-Z][A-Za-z ]+$/);
  for (const v of many("person.bio")) assert.match(v, /\.$/);
});

test("company, product and place", () => {
  for (const v of many("company.name")) assert.match(v, /^\p{Lu}\p{L}+ \p{Lu}\p{L}+$/u);
  for (const v of many("product.name")) assert.match(v, /^\p{Lu}\p{L}+ \p{Lu}\p{L}+$/u);
  for (const v of many("place.city")) assert.match(v, /^\p{Lu}\p{L}+$/u);
  for (const v of many("place.state")) assert.match(v, /^[A-Z][A-Za-z ]+$/);
  for (const v of many("place.country")) assert.ok(["United States", "Canada"].includes(v));
  for (const v of many("place.zip")) assert.match(v, /^([0-9]{5}|[A-Z][0-9][A-Z] [0-9][A-Z][0-9])$/);
  for (const v of many("place.street")) assert.match(v, /^[1-9][0-9]* \p{Lu}\p{L}+ \p{Lu}\p{L}+$/u);
  for (const v of many("place.address")) assert.match(v, /^[1-9][0-9]* .+, .+, [A-Z]{2} .+$/);
});

test("web: url, imageUrl, ip, hex, color", () => {
  for (const v of many("url")) assert.doesNotThrow(() => new URL(v), v);
  for (const v of many("url")) assert.match(v, /^https:\/\/[a-z.]+\/[a-z-]+$/);
  for (const v of many("imageUrl")) assert.match(v, /^https:\/\/images\.example\.org\/[0-9a-f]{12}\.png$/);
  for (const v of many("ip")) assert.match(v, /^(\d{1,3}\.){3}\d{1,3}$/);
  for (const v of many("hex", { length: 32 })) assert.match(v, /^[0-9a-f]{32}$/);
  for (const v of many("hex", { length: 5 })) assert.match(v, /^[0-9a-f]{5}$/);
  for (const v of many("color")) assert.match(v, /^[a-z]+$/);
});

test("datetime: ISO-8601 with ms and Z, never after the anchor", () => {
  for (const v of many("datetime", { minDaysAgo: 30, maxDaysAgo: 1500 })) {
    assert.match(v, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const t = Date.parse(v);
    assert.ok(t <= ANCHOR - 30 * 86400000 && t >= ANCHOR - 1500 * 86400000 - 1, v);
  }
  // a different anchor shifts it deterministically
  const a = generate("datetime", ctxFor(2, { minDaysAgo: 1, maxDaysAgo: 10 }));
  const b = generate("datetime", { ...ctxFor(2, { minDaysAgo: 1, maxDaysAgo: 10 }), anchorMs: ANCHOR + 86400000 });
  assert.equal(Date.parse(b) - Date.parse(a), 86400000);
});

test("choice: oneOf (values and vocab) and pattern", () => {
  for (const v of many("oneOf", { values: ["a", "b"] })) assert.ok(v === "a" || v === "b");
  for (const v of many("oneOf", { vocab: "status" })) assert.ok(["draft", "pending", "active", "published", "archived", "closed", "open", "resolved"].includes(v));
  assert.throws(() => generate("oneOf", ctxFor(1, { vocab: "nope" })), (e) => e.code === "bad-generator-args");
  for (const v of many("pattern", { p: "ORD-#####" })) assert.match(v, /^ORD-\d{5}$/);
  for (const v of many("pattern", { p: "AAA-?*\\#" })) assert.match(v, /^[A-Z]{3}-[a-z][A-Za-z0-9]#$/);
});

test("generator names are exposed for the 'did you mean' hint", () => {
  for (const n of ["int", "person.first", "datetime", "id.uuid", "pattern", "oneOf", "words", "sentence"]) {
    assert.ok(GENERATOR_NAMES.includes(n), n);
  }
});

test("persona generators read slots: same slots, same persona", () => {
  const a = (name) => generate(name, ctxFor(4));
  assert.equal(a("person.full"), `${a("person.first")} ${a("person.last")}`);
  const email = a("person.email");
  assert.ok(email.includes(asciiFold(a("person.first"))) && email.includes(asciiFold(a("person.last"))));
  assert.equal(a("place.address").includes(a("place.city")), true);
  assert.equal(a("place.address").includes(a("place.street")), true);
  assert.equal(a("place.address").endsWith(a("place.zip")), true);
  assert.equal(a("company.domain"), `${a("company.name").split(" ")[0].toLowerCase()}.example.com`);
});

test("time.*: created <= updated <= anchor, deleted is null by default", () => {
  for (let i = 0; i < 100; i++) {
    const c = Date.parse(generate("time.created", ctxFor(i)));
    const u = Date.parse(generate("time.updated", ctxFor(i)));
    const p = Date.parse(generate("time.published", ctxFor(i)));
    assert.ok(c <= u && u <= ANCHOR && c <= p && p <= ANCHOR);
    assert.equal(generate("time.deleted", ctxFor(i)), null);
    const d = generate("time.deleted", ctxFor(i, { nullRate: 0 }));
    assert.ok(Date.parse(d) >= u && Date.parse(d) <= ANCHOR);
  }
});
