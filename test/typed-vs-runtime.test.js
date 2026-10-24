// The type-level reader mirrors the runtime inference rules by hand. This test is the guard against
// the two drifting apart: for each fixture query the inferred type is compared with the data the library
// returns, for several seeds (docs/design.md section 20, limits).
import { test } from "node:test";
import assert from "node:assert/strict";
import { graceholder } from "../src/index.js";
import { FIXTURES } from "./typed-fixtures.js";
import { compileTypes, fits, unknownPaths } from "./typed-harness.js";

const { shapes, diagnostics } = compileTypes(FIXTURES.map((f) => `ResultOf<${JSON.stringify(f.query)}>`));

test("the type-level reader compiles every fixture without diagnostics", () => {
  assert.deepEqual(diagnostics, []);
});

for (const [i, fx] of FIXTURES.entries()) {
  test(`types match the runtime: ${fx.name}`, () => {
    for (const seed of ["a", "graceholder", 7, "zz"]) {
      const data = JSON.parse(JSON.stringify(graceholder(fx.query, { seed, variables: fx.variables })));
      assert.deepEqual(fits(shapes[i], data), [], `seed ${seed}`);
    }
    assert.deepEqual(unknownPaths(shapes[i]).filter((p) => !(fx.unknown ?? []).includes(p)), [], "inference gave up somewhere unexpected");
  });
}

// Known divergences (docs/design.md section 20, limits). The type-level reader looks at one occurrence
// of a field; the runtime merges every occurrence of a field of a type, and honours options the types
// cannot see. Each case below is a place where the inferred type is wrong on purpose-documented grounds;
// if one of them starts to fit, the limit has been lifted and the docs must change.
const DIVERGENT = [
  {
    name: "a directive on another occurrence of the same field of the same type",
    query: `{ a { name } b: author @type(name: "A") { name @gen(name: "int") } }`,
    note: "the @gen applies to A.name everywhere; the type of the first `name` still says string",
  },
  {
    name: "a paging argument on only one occurrence of a field",
    query: `{ x { thing(first: 2) { id } } y: x { thing { id } } }`,
    note: "the arguments of every occurrence of a field are merged: both `thing` are lists at run time",
  },
  {
    name: "scalar types are changed by a pack",
    query: `{ place { lon } }`,
    options: { packs: ["geo"] },
    note: "packs add name rules (P1) that the types do not know: `lon` is a string by default and a number with the geo pack",
  },
  {
    name: "the nulls scenario makes fields nullable",
    query: `{ users(first: 40) { id name age } }`,
    options: { scenario: "nulls" },
    note: "scenarios widen fields to nullable; the types do not know the scenario",
  },
  {
    name: "realistic distributions turn a plural popularity name into a number",
    query: `{ post { followers } }`,
    options: { distributions: "realistic" },
    note: "followers is a list of strings by the default rules, a number when distributions are realistic",
  },
];

test("known divergences are real (and documented in docs/design.md section 20)", async () => {
  const { registerPack } = await import("../src/index.js");
  const { geo } = await import("../src/packs/index.js");
  registerPack(geo);
  const { shapes: dshapes } = compileTypes(DIVERGENT.map((d) => `ResultOf<${JSON.stringify(d.query)}>`));
  DIVERGENT.forEach((d, i) => {
    const data = JSON.parse(JSON.stringify(graceholder(d.query, { seed: "a", ...(d.options ?? {}) })));
    const problems = fits(dshapes[i], data);
    assert.ok(problems.length > 0, `${d.name}: the types now fit the runtime, so the limit in the docs is out of date (${d.note})`);
  });
});
