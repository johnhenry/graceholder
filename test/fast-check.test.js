import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import * as fc from "fast-check";
import { graceholder, SCENARIOS } from "../src/index.js";
import { graceholderArbitrary, replay } from "../src/fast-check.js";

const Q = "{ users(first: 5) { id name age createdAt posts { id title } } }";

test("samples carry seed, scenarios, data and errors, and equal the graceholder call", () => {
  const samples = fc.sample(graceholderArbitrary(Q), { numRuns: 25, seed: 7 });
  assert.equal(samples.length, 25);
  for (const s of samples) {
    assert.deepEqual(Object.keys(s).sort(), ["data", "errors", "scenarios", "seed"]);
    assert.ok(Number.isInteger(s.seed));
    assert.ok(s.scenarios.every((x) => SCENARIOS.includes(x)));
    const direct = graceholder(Q, { seed: s.seed, scenario: s.scenarios, errors: "result" });
    assert.deepEqual(s.data, direct.data ?? null);
    assert.deepEqual(s.errors, direct.errors ?? []);
  }
  assert.ok(samples.some((s) => s.scenarios.length > 1), "scenarios combine");
});

test("the same fast-check seed gives the same samples", () => {
  const run = () => fc.sample(graceholderArbitrary(Q), { numRuns: 10, seed: 99 }).map((s) => JSON.stringify(s));
  assert.deepEqual(run(), run());
});

test("scenarios: false and [] mean none; a list limits the choice; extra options pass through", () => {
  for (const scenarios of [false, []]) {
    assert.ok(fc.sample(graceholderArbitrary(Q, { scenarios }), { numRuns: 15, seed: 1 }).every((s) => s.scenarios.length === 0));
  }
  const only = fc.sample(graceholderArbitrary(Q, { scenarios: ["nulls", "empty"] }), { numRuns: 40, seed: 1 });
  assert.ok(only.every((s) => s.scenarios.every((x) => x === "nulls" || x === "empty")));
  const spec = fc.sample(graceholderArbitrary("{ users { id name } }", { scenarios: false, spec: { users: { count: 2 } } }), { numRuns: 5, seed: 1 });
  assert.ok(spec.every((s) => s.data.users.length === 2));
  const seeds = fc.sample(graceholderArbitrary(Q, { scenarios: false, seeds: fc.constantFrom("alpha", "beta") }), { numRuns: 10, seed: 1 });
  assert.ok(seeds.every((s) => s.seed === "alpha" || s.seed === "beta"));
});

test("options the arbitrary owns are rejected; a bad query fails at construction", () => {
  assert.throws(() => graceholderArbitrary(Q, { seed: 1 }), (e) => e.code === "bad-options");
  assert.throws(() => graceholderArbitrary(Q, { scenario: "empty" }), (e) => e.code === "bad-options");
  assert.throws(() => graceholderArbitrary(Q, { scenarios: ["chaos"] }), (e) => e.code === "bad-options");
  assert.throws(() => graceholderArbitrary("{ nope"), (e) => e.name === "GraceholderError" || e.name === "GraphQLError");
});

const failing = (arb, predicate) => fc.check(fc.property(arb, (s) => !predicate(s)), { numRuns: 200, seed: 42 });

test("shrinking: a property that always fails shrinks to seed 0 and no scenarios", () => {
  const r = failing(graceholderArbitrary(Q), () => true);
  assert.equal(r.failed, true);
  assert.equal(r.counterexample[0].seed, 0);
  assert.deepEqual(r.counterexample[0].scenarios, []);
});

test("shrinking: the scenario set shrinks to the one scenario that matters", () => {
  const r = failing(graceholderArbitrary(Q), (s) => s.scenarios.includes("empty") && s.data.users.length === 0);
  assert.equal(r.failed, true);
  assert.deepEqual(r.counterexample[0].scenarios, ["empty"]);
  assert.equal(r.counterexample[0].seed, 0);
  const two = failing(graceholderArbitrary(Q), (s) => s.scenarios.includes("nulls") && s.scenarios.includes("unicode"));
  assert.deepEqual(two.counterexample[0].scenarios, ["nulls", "unicode"]);
});

test("shrinking: seeds shrink to the smallest failing seed", () => {
  const r = failing(graceholderArbitrary(Q, { scenarios: false }), (s) => s.seed >= 1000);
  assert.equal(r.counterexample[0].seed, 1000);
});

test("a deliberately failing property reproduces from the reported seed", () => {
  // a real bug a UI might have: it cannot cope with a missing name
  const arb = graceholderArbitrary(Q);
  const render = (s) => s.data.users.every((u) => u.name === null || u.name.length < 2000);
  const prop = fc.property(arb, (s) => render(s) && s.errors.length === 0);
  const first = fc.check(prop, { numRuns: 100, seed: 2024 });
  assert.equal(first.failed, true);
  const bad = first.counterexample[0];

  // 1. the report prints the seed and scenarios, not the whole payload
  const report = fc.stringify(bad);
  assert.match(report, new RegExp(`graceholder\\(\\{"seed":${bad.seed},"scenarios":${JSON.stringify(bad.scenarios).replaceAll("[", "\\[").replaceAll("]", "\\]")}\\}\\)`));
  assert.ok(report.length < 200);

  // 2. fast-check replays the same run, and fails on the same shrunk value
  const again = fc.check(prop, { numRuns: 100, seed: first.seed, path: first.counterexamplePath });
  assert.equal(again.failed, true);
  assert.deepEqual(again.counterexample[0], bad);

  // 3. without fast-check, the printed seed and scenarios regenerate the failing data
  const direct = graceholder(Q, { seed: bad.seed, scenario: bad.scenarios, errors: "result" });
  assert.deepEqual(direct.data ?? null, bad.data);
  assert.deepEqual(direct.errors ?? [], bad.errors);
  assert.deepEqual(replay(Q, { seed: bad.seed, scenarios: bad.scenarios }), bad);
  assert.equal(render(replay(Q, bad)) && replay(Q, bad).errors.length === 0, false);
});

test("a property that holds for all seeds and scenarios passes", () => {
  fc.assert(
    fc.property(graceholderArbitrary(Q, { scenarios: ["unicode", "boundary", "nulls", "empty"] }), (s) => Array.isArray(s.data.users) && s.errors.length === 0),
    { numRuns: 40, seed: 5 },
  );
});

test("fast-check is an optional peer dependency and only the subpath imports it", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.peerDependencies["fast-check"]);
  assert.equal(pkg.peerDependenciesMeta["fast-check"].optional, true);
  assert.ok(pkg.devDependencies["fast-check"]);
  assert.deepEqual(Object.keys(pkg.dependencies), ["graphql"]);
  assert.equal(pkg.exports["./fast-check"].default, "./src/fast-check.js");
  for (const f of readdirSync(new URL("../src/", import.meta.url), { recursive: true })) {
    if (!f.endsWith(".js") || f === "fast-check.js") continue;
    assert.doesNotMatch(readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8"), /fast-check/, f);
  }
});
