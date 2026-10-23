import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSchema, parse } from "graphql";
import { graceholder, inferSchema, GraceholderError, KEY_SCHEME } from "../src/index.js";

const FEED = `{
  posts { id title body createdAt author { firstName lastName email } tags commentCount }
  users { id name }
}`;
const run = (q, o) => graceholder(q, { seed: "t", ...o });
const json = (v) => JSON.stringify(v);

test("KEY_SCHEME is gh1", () => assert.equal(KEY_SCHEME, "gh1"));

test("returns synchronously, plain JSON-compatible objects", () => {
  const out = run(FEED);
  assert.ok(!(out instanceof Promise));
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(Object.getPrototypeOf(out.posts[0]), Object.prototype);
  assert.deepEqual(JSON.parse(json(out)), out);
});

test("same seed, query and options give byte-identical output", () => {
  assert.equal(json(run(FEED)), json(run(FEED)));
  assert.equal(json(graceholder(FEED)), json(graceholder(FEED))); // default seed
  // a parsed document behaves like the string
  assert.equal(json(run(parse(FEED))), json(run(FEED)));
});

test("a numeric seed is its string form", () => {
  assert.equal(json(graceholder(FEED, { seed: 42 })), json(graceholder(FEED, { seed: "42" })));
});

test("different seeds give different output", () => {
  const a = json(graceholder(FEED, { seed: "one" }));
  const b = json(graceholder(FEED, { seed: "two" }));
  assert.notEqual(a, b);
  // and most individual values differ, not just one
  const pa = graceholder(FEED, { seed: "one" }).posts;
  const pb = graceholder(FEED, { seed: "two" }).posts;
  assert.notEqual(pa[0].title, pb[0].title);
});

test("lists have a stable count of 3 to 10, keyed (not positional)", () => {
  for (let i = 0; i < 40; i++) {
    const out = graceholder("{ posts { id } users { id } }", { seed: `s${i}` });
    assert.ok(out.posts.length >= 3 && out.posts.length <= 10, String(out.posts.length));
    assert.ok(out.users.length >= 3 && out.users.length <= 10);
  }
  const counts = new Set();
  for (let i = 0; i < 60; i++) counts.add(graceholder("{ posts { id } }", { seed: `s${i}` }).posts.length);
  assert.ok(counts.size >= 6, [...counts].join());
  // the count does not depend on what is selected
  assert.equal(run("{ posts { id } }").posts.length, run("{ posts { title author { email } } }").posts.length);
});

test("top-level list members are the shared pool: ids 1..n", () => {
  const out = run("{ posts { id } }");
  assert.deepEqual(out.posts.map((p) => p.id), out.posts.map((_, i) => String(i + 1)));
});

test("owned nested lists get their own count and ids", () => {
  const out = run("{ posts { id comments { id text } } }");
  for (const p of out.posts) {
    assert.ok(p.comments.length >= 3 && p.comments.length <= 10);
    for (const c of p.comments) assert.match(c.id, /^[1-9][0-9]*$/);
  }
  assert.notDeepEqual(out.posts[0].comments, out.posts[1].comments);
});

test("scalar lists: tags is a list of strings", () => {
  const { posts } = run("{ posts { tags } }");
  for (const p of posts) {
    assert.ok(Array.isArray(p.tags) && p.tags.length >= 3 && p.tags.length <= 10);
    for (const t of p.tags) assert.equal(typeof t, "string");
  }
});

test("alias invariance: aliasing never changes values", () => {
  const plain = run("{ posts { id title author { email } } }");
  const aliased = run("{ articles: posts { key: id headline: title writer: author { mail: email } } }");
  assert.equal(json(aliased.articles.map((a) => ({ id: a.key, title: a.headline, author: { email: a.writer.mail } }))), json(plain.posts));
  // two aliases of one field agree
  const twice = run("{ a: posts { id title } b: posts { id title } }");
  assert.equal(json(twice.a), json(twice.b));
});

test("field-order invariance", () => {
  const a = run("{ posts { id title body author { firstName email } } }");
  const b = run("{ posts { author { email firstName } body title id } }");
  const sorted = (p) => ({ id: p.id, title: p.title, body: p.body, author: { firstName: p.author.firstName, email: p.author.email } });
  assert.equal(json(a.posts), json(b.posts.map(sorted)));
});

test("sibling add/remove invariance", () => {
  const base = run("{ posts { id title } }");
  const more = run("{ posts { id title body createdAt tags author { name } } }");
  assert.equal(json(base.posts), json(more.posts.map(({ id, title }) => ({ id, title }))));
  const fewer = run("{ posts { title } }");
  assert.equal(json(fewer.posts), json(base.posts.map(({ title }) => ({ title }))));
  // adding a whole sibling root field changes nothing else
  const withUsers = run("{ users { name } posts { id title } }");
  assert.equal(json(withUsers.posts), json(base.posts));
});

test("unrelated variables and operation names do not change values", () => {
  const a = run("query A($x: Int = 1) { posts(note: $x) { id title } }");
  const b = run("query B($x: Int = 2, $y: String) { posts(note: $x, other: $y) { id title } }", { variables: { y: "z" } });
  assert.equal(json(a), json(b));
  assert.equal(json(a), json(run("{ posts { id title } }")));
});

test("named and inline fragments", () => {
  const plain = run("{ posts { id title author { firstName email } } }");
  const frag = run(`
    query { posts { ...P } }
    fragment P on Post { id title author { ...A } }
    fragment A on Author { firstName email }`);
  assert.equal(json(frag), json(plain));
  const inline = run("{ posts { id ... on Post { title } author { ... { firstName } ... on Author { email } } } }");
  assert.equal(json(inline.posts), json(plain.posts));
  // the fragment's type condition names the type (N2) and so keys its values
  const named = run("{ posts { author { ...U } } } fragment U on User { firstName }");
  const direct = run("{ posts { author { firstName } } }");
  assert.notEqual(json(named), json(direct));
  assert.ok(inferSchema("{ posts { author { ...U } } } fragment U on User { firstName }").sdl.includes("type User {"));
});

test("variables, including defaults and @skip/@include", () => {
  const q = "query Q($withBody: Boolean!, $who: String = \"x\") { posts(by: $who) { id title body @include(if: $withBody) hidden: tags @skip(if: true) } }";
  const on = run(q, { variables: { withBody: true } });
  const off = run(q, { variables: { withBody: false } });
  assert.ok("body" in on.posts[0]);
  assert.ok(!("body" in off.posts[0]));
  assert.ok(!("hidden" in on.posts[0]));
  assert.equal(on.posts[0].title, off.posts[0].title);
  assert.throws(() => run(q), (e) => e instanceof GraceholderError && e.code === "graphql");
});

test("arguments are accepted and typed, literal and variable", () => {
  const out = run("query($n: Int!) { user(id: 5, verbose: true) { id name } posts(first: $n, tags: [\"a\"], filter: {status: OPEN, q: \"x\"}) { id } }", { variables: { n: 2 } });
  assert.ok(out.user.name);
  assert.ok(Array.isArray(out.posts));
});

test("__typename resolves to the inferred type name", () => {
  const out = run("{ __typename posts { __typename id author { __typename email } } people { __typename } }");
  assert.equal(out.__typename, "Query");
  assert.equal(out.posts[0].__typename, "Post");
  assert.equal(out.posts[0].author.__typename, "Author");
  assert.equal(out.people[0].__typename, "Person");
  // __typename does not perturb other values
  const bare = run("{ posts { id author { email } } }");
  assert.equal(out.posts[0].author.email, bare.posts[0].author.email);
});

test("singular nested objects are references into a pool of 100", () => {
  const out = run("{ posts { author { id } } }");
  for (const p of out.posts) assert.ok(Number(p.author.id) >= 1 && Number(p.author.id) <= 100);
  const me = run("{ me { id } }");
  assert.equal(me.me.id, "1"); // top-level singular fields use key 1
});

test("scalar types follow field names", () => {
  const out = run("{ users { id isAdmin age price createdAt email url phone status title } }");
  const u = out.users[0];
  assert.equal(typeof u.id, "string");
  assert.equal(typeof u.isAdmin, "boolean");
  assert.ok(Number.isInteger(u.age) && u.age >= 18 && u.age <= 90);
  assert.equal(typeof u.price, "number");
  assert.match(u.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.match(u.email, /@/);
  assert.match(u.url, /^https:\/\//);
  assert.match(u.phone, /^\(\d{3}\) 555-01\d\d$/);
  assert.ok(["draft", "pending", "active", "published", "archived", "closed", "open", "resolved"].includes(u.status));
});

test("anchorDate: default constant, overridable, no clock reads", () => {
  const q = "{ users { createdAt } }";
  const def = graceholder(q, { seed: "a" });
  for (const u of def.users) assert.ok(Date.parse(u.createdAt) <= Date.parse("2025-01-01T00:00:00.000Z"));
  const later = graceholder(q, { seed: "a", anchorDate: "2026-01-01T00:00:00.000Z" });
  assert.equal(Date.parse(later.users[0].createdAt) - Date.parse(def.users[0].createdAt), Date.parse("2026-01-01") - Date.parse("2025-01-01"));
  const asDate = graceholder(q, { seed: "a", anchorDate: new Date("2026-01-01T00:00:00.000Z") });
  assert.equal(json(asDate), json(later));
  assert.throws(() => graceholder(q, { anchorDate: "not a date" }), (e) => e.code === "bad-options");
});

test("output does not depend on the system clock or Math.random", () => {
  const RealDate = globalThis.Date;
  const realRandom = Math.random;
  const before = json(run(FEED));
  try {
    globalThis.Date = class extends RealDate {
      constructor(...a) { super(...(a.length ? a : [1234567890000])); }
      static now() { return 1234567890000; }
    };
    Math.random = () => 0.123;
    assert.equal(json(run(FEED)), before);
    Math.random = () => { throw new Error("Math.random called"); };
    assert.equal(json(run(FEED)), before);
  } finally {
    globalThis.Date = RealDate;
    Math.random = realRandom;
  }
});

test("inferSchema: SDL, ordering and decisions", () => {
  const { sdl, decisions, document } = inferSchema(
    `query Feed($first: Int = 3) { me: user(id: 5) { id fullName createdAt } posts(first: $first) { id title author { firstName } tags } }`,
  );
  assert.equal(
    sdl,
    `scalar DateTime

type Query {
  user(id: Int): User!
  posts(first: Int): [Post!]!
}

type User {
  id: ID!
  fullName: String!
  createdAt: DateTime!
}

type Post {
  id: ID!
  title: String!
  author: Author!
  tags: [String!]!
}

type Author {
  firstName: String!
}
`,
  );
  assert.doesNotThrow(() => buildSchema(sdl));
  assert.equal(document.kind, "Document");
  const byPath = Object.fromEntries(decisions.map((d) => [`${d.path}#${d.kind}`, d]));
  assert.deepEqual([byPath["posts#list"].value, byPath["posts#list"].rule, byPath["posts#list"].source], [true, "L2", "heuristic"]);
  assert.deepEqual([byPath["posts#type"].value, byPath["posts#type"].rule], ["Post", "N3"]);
  assert.deepEqual([byPath["posts.tags#scalar"].value, byPath["posts.tags#scalar"].rule], ["String", "T13"]);
  assert.deepEqual([byPath["posts.title#scalar"].value, byPath["posts.title#scalar"].rule], ["String", "T11"]);
  assert.deepEqual([byPath["user#list"].value, byPath["user#list"].rule], [false, "L6"]);
});

test("inferSchema: types merge by name, unions of fields", () => {
  const { sdl } = inferSchema("{ posts { author { name } } comments { author { email } } }");
  assert.match(sdl, /type Author \{\n  name: String!\n  email: String!\n\}/);
});

test("inferSchema: recursion through the same type name", () => {
  const { sdl } = inferSchema("{ users { friends { friends { name } } } }");
  assert.match(sdl, /type Friend \{\n  friends: \[Friend!\]!\n  name: String!\n\}/);
});

test("errors: operations, directives, graphql problems", () => {
  const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
  assert.equal(code(() => run("query A { posts { id } } query B { users { id } }")), "bad-operation");
  assert.equal(code(() => run("query A { posts { id } } query B { users { id } }", { operationName: "C" })), "bad-operation");
  assert.deepEqual(run("query A { posts { id } } query B { users { id } }", { operationName: "B" }).users.map((u) => u.id).slice(0, 1), ["1"]);
  assert.equal(code(() => run("mutation { makePost { id } }")), "bad-operation");
  assert.equal(code(() => run("{ posts @nope { id } }")), "unknown-directive");
  assert.equal(code(() => run("{ posts { id ")), "graphql");
  assert.equal(code(() => run("{ posts { ...Missing } }")), "graphql");
  assert.equal(code(() => run("{ posts { ...A } } fragment A on Post { ...B } fragment B on Post { ...A }")), "graphql");
  assert.equal(code(() => run("{ posts { title } posts { title { x } } }")), "conflicting-shape");
  assert.equal(code(() => run("{ posts { id } }", { locale: "xx" })), "unknown-locale");
});

test("errors: 'result' mode returns {data, errors} instead of throwing", () => {
  const r = graceholder("{ posts { id ", { errors: "result" });
  assert.equal(r.data, undefined);
  assert.ok(r.errors.length > 0);
  const ok = graceholder("{ posts { id } }", { errors: "result", seed: "q" });
  assert.ok(Array.isArray(ok.data.posts));
  assert.equal(ok.errors, undefined);
});

test("root-level fragments and aliases on the root", () => {
  const out = run("fragment R on Query { posts { id } } { ...R mine: users { id } }");
  assert.ok(out.posts && out.mine);
});

test("custom scalar variable types are tolerated", () => {
  const out = run("query($f: PostFilter) { posts(filter: $f) { id } }", { variables: { f: { a: 1 } } });
  assert.ok(out.posts.length >= 3);
});
