// Random queries (seeded, so the same ones every run) against the type-level reader: for each, the
// type inferred from the query text must describe the data the library returns. Argument usage is
// a function of the field name, because the runtime merges the arguments of every occurrence of a
// field while the type-level reader looks at one occurrence (documented limit, docs/design.md section 20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { graceholder } from "../src/index.js";
import { compileTypes, fits, unknownPaths } from "./typed-harness.js";

const SCALARS = "id userId name email age price total subtotal isActive hasBadge canEdit createdAt updatedAt deletedAt birthday title status url avatar imageUrl phone phoneNumber views likes commentCount totalPosts tags scores emails note color rating latitude qty numberOfItems zip hasEmail emailCount urlCount firstName bio slug token ip level size rank website items_count score_total".split(" ");
const OBJECTS = "author owner profile address company manager coupon".split(" ");
const LISTS = "posts comments people children categories boxes results allUsers entries".split(" ");
const PAGED = ["latestPost", "feedItem", "recentThing"]; // singular names that take a paging argument
const UNIONS = ["search", "hits"];
const CONNECTIONS = ["postsConnection", "userConnection"];
const MASS = "news series history".split(" "); // plural-looking but not lists, or singular: never @count
const DIRECTIVE_SCALARS = [" @nullRate(p: 0.5)", ' @pick(values: ["a", "b"])', ' @gen(name: "int")', ' @pattern(p: "A##")', ""];

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function makeQuery(next) {
  const pick = (a) => a[Math.floor(next() * a.length)];
  const some = (a, n) => {
    const out = new Set();
    while (out.size < n) out.add(pick(a));
    return [...out];
  };
  const fragments = [];
  const select = (depth, taken = new Set()) => {
    const parts = [];
    const add = (key, text) => {
      if (taken.has(key)) return;
      taken.add(key);
      parts.push(text);
    };
    for (const n of some(SCALARS, 2 + Math.floor(next() * 3))) {
      const alias = next() < 0.15 ? `a_${n}: ` : "";
      // one directive per field name: the runtime refuses different @gen/@pick overrides for one field of a type
      const dir = n === "id" ? "" : DIRECTIVE_SCALARS[[...n].reduce((a, c) => a + c.charCodeAt(0), 0) % DIRECTIVE_SCALARS.length];
      add(alias ? `a_${n}` : n, `${alias}${n}${dir}`);
    }
    if (depth < 2) {
      for (const n of some(OBJECTS, Math.floor(next() * 2))) add(n, `${n} { ${select(depth + 1)} }`);
      for (const n of some(LISTS, Math.floor(next() * 3))) {
        const dir = next() < 0.25 ? " @count(n: 2)" : "";
        const key = next() < 0.2 ? "first" : "";
        add(n, `${n}${key ? "(first: 2)" : ""}${dir} { ${select(depth + 1)} }`);
      }
      for (const n of some(MASS, Math.floor(next() * 2))) add(n, `${n} { ${select(depth + 1)} }`);
      if (next() < 0.3) { const n = pick(PAGED); add(n, `${n}(first: 2) { ${select(depth + 1)} }`); }
      if (next() < 0.2) { const n = pick(UNIONS); add(n, `${n}(first: 3) { __typename ... on User { id handle } ... on Post { id headline } }`); }
      if (next() < 0.15) { const n = pick(CONNECTIONS); add(n, `${n}(first: 2) { totalCount edges { cursor node { ${select(depth + 1)} } } pageInfo { hasNextPage endCursor } }`); }
      if (next() < 0.2) {
        const name = `F${fragments.length}`;
        fragments.push(`fragment ${name} on Thing { ${select(depth + 1)} }`);
        const n = pick(OBJECTS);
        add(n, `${n} { ...${name} }`);
      }
      if (next() < 0.1) add("one", `one @one { ${select(depth + 1)} }`);
    }
    if (next() < 0.1) add("__typename", "__typename");
    return parts.join(" ");
  };
  return `query { ${select(0)} } ${fragments.join(" ")}`;
}

test("random queries: the inferred types describe what the library returns", () => {
  const next = rng(20241023);
  const queries = Array.from({ length: 100 }, () => makeQuery(next));
  const { shapes, diagnostics } = compileTypes(queries.map((q) => `ResultOf<${JSON.stringify(q)}>`));
  assert.deepEqual(diagnostics, []);
  let checked = 0;
  const problems = [];
  queries.forEach((q, i) => {
    let datas;
    try {
      datas = ["x", "y"].map((seed) => JSON.parse(JSON.stringify(graceholder(q, { seed }))));
    } catch {
      return; // a combination the library refuses (for example a conflicting shape): not a type question
    }
    checked++;
    for (const d of datas) {
      const misfit = fits(shapes[i], d);
      if (misfit.length) problems.push(`${q}\n   ${misfit[0]}`);
    }
    const unknown = unknownPaths(shapes[i]);
    if (unknown.length) problems.push(`${q}\n   unknown at ${unknown[0]}`);
  });
  assert.ok(checked >= 90, `only ${checked} queries ran`);
  assert.deepEqual(problems.slice(0, 3), []);
});
