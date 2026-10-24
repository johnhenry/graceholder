// A large query must typecheck in a bounded amount of compiler work. The instantiation count is the
// deterministic measure (it does not depend on how busy the machine is); the wall-clock bound is loose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { graceholder } from "../src/index.js";
import { compileTypes, fits, unknownPaths } from "./typed-harness.js";

const big = (roots) =>
  "query Big {\n" +
  Array.from({ length: roots }, (_, i) => `  users${i}(first: 3) { id name email age createdAt isActive tags posts { id title body views author { id name } comments { id body } } }`).join("\n") +
  "\n}";

test("a query of about 450 fields typechecks within a bound, and is still fully typed", () => {
  const q = big(30);
  const fields = (q.match(/[A-Za-z]+(?=[ ({])/g) ?? []).length;
  assert.ok(fields > 450, `${fields} fields`);
  const base = compileTypes(["1"]);
  const { shapes, diagnostics, ms, instantiations } = compileTypes([`ResultOf<${JSON.stringify(q)}>`]);
  console.log(`# ${q.length} characters, ${fields} fields: ${instantiations - base.instantiations} instantiations, ${Math.round(ms)} ms`);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(unknownPaths(shapes[0]), []);
  assert.ok(instantiations - base.instantiations < 1_500_000, `${instantiations - base.instantiations} instantiations`);
  assert.ok(ms < 60_000, `${ms} ms`);
  // and the type is the right one
  assert.deepEqual(fits(shapes[0], JSON.parse(JSON.stringify(graceholder(q, { seed: "p" })))), []);
});

test("a deeply nested query (25 levels) is typed", () => {
  const q = "{ " + Array.from({ length: 25 }, (_, i) => `level${i} {`).join(" ") + " id " + "}".repeat(25) + " }";
  const { shapes, diagnostics } = compileTypes([`ResultOf<${JSON.stringify(q)}>`]);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(unknownPaths(shapes[0]), []);
  assert.deepEqual(fits(shapes[0], graceholder(q)), []);
});

test("a selection set of more than 600 items degrades to Record<string, unknown> instead of failing to compile", () => {
  const q = "{ " + Array.from({ length: 700 }, (_, i) => `f${i}`).join(" ") + " }";
  const { shapes, diagnostics } = compileTypes([`ResultOf<${JSON.stringify(q)}>`]);
  assert.deepEqual(diagnostics, []);
  assert.equal(shapes[0].kind, "object");
  assert.deepEqual(Object.keys(shapes[0].props), []);
});
