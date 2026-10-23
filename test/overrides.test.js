import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { buildSchema } from "graphql";
import { graceholder, inferSchema } from "../src/index.js";
import { matchPath, compileSpec } from "../src/spec.js";
import { encodeCursor } from "../src/cursor.js";

const run = (q, o) => graceholder(q, { seed: "o", ...o });
const json = (v) => JSON.stringify(v);
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
const err = (fn) => { try { fn(); } catch (e) { return e; } return null; };

// ---- directives, one test each, each with its side-car spec equivalent -------------

test("@list and @one force the shape (L1)", () => {
  const dir = run("{ user @list { id } users @one { id } }");
  assert.ok(Array.isArray(dir.user) && dir.user.length >= 3);
  assert.ok(!Array.isArray(dir.users) && typeof dir.users.id === "string");
  const spec = run("{ user { id } users { id } }", { spec: { user: { list: true }, users: { one: true } } });
  assert.equal(json(spec), json(dir));
  assert.match(inferSchema("{ user @list { id } }").sdl, /user: \[User!\]!/);
  const decision = inferSchema("{ user @list { id } }").decisions.find((d) => d.kind === "list");
  assert.deepEqual([decision.value, decision.source, decision.rule], [true, "directive", "L1"]);
  assert.equal(inferSchema("{ user { id } }", { user: { list: true } }).decisions.find((d) => d.kind === "list").source, "spec");
});

test("@count: a fixed number or a keyed range", () => {
  const fixed = run("{ posts @count(n: 5) { id } }");
  assert.equal(fixed.posts.length, 5);
  for (let i = 0; i < 30; i++) {
    const out = graceholder("{ posts @count(min: 2, max: 4) { id tags @count(n: 1) } }", { seed: `c${i}` });
    assert.ok(out.posts.length >= 2 && out.posts.length <= 4);
    for (const p of out.posts) assert.equal(p.tags.length, 1);
  }
  const lens = new Set(Array.from({ length: 40 }, (_, i) => graceholder("{ posts @count(min: 2, max: 4) { id } }", { seed: `c${i}` }).posts.length));
  assert.deepEqual([...lens].sort(), [2, 3, 4]);
  // spec forms: n, [min, max], {min, max}
  assert.equal(run("{ posts { id } }", { spec: { posts: { count: 5 } } }).posts.length, 5);
  assert.equal(json(run("{ posts { id } }", { spec: { posts: { count: [2, 4] } } })), json(run("{ posts { id } }", { spec: { posts: { count: { min: 2, max: 4 } } } })));
  assert.equal(json(run("{ posts { id } }", { spec: { posts: { count: [2, 4] } } })), json(run("{ posts @count(min: 2, max: 4) { id } }")));
  assert.equal(code(() => run("{ post @count(n: 2) { id } }")), "conflicting-overrides"); // not a list
  assert.equal(code(() => run("{ posts @count(n: -1) { id } }")), "bad-directive");
  assert.equal(code(() => run("{ posts @count(min: 5, max: 2) { id } }")), "bad-directive");
});

test("@count makes a connection finite (a declared total gives a real end)", () => {
  const q = (args) => `{ posts${args} @count(n: 4) { edges { node { id } } pageInfo { hasNextPage endCursor } totalCount } }`;
  const p1 = run(q("(first: 3)")).posts;
  assert.equal(p1.totalCount, 4);
  assert.equal(p1.pageInfo.hasNextPage, true);
  const p2 = run(q(`(first: 3, after: "${p1.pageInfo.endCursor}")`)).posts;
  assert.deepEqual(p2.edges.map((e) => e.node.id), ["4"]);
  assert.equal(p2.pageInfo.hasNextPage, false);
  assert.equal(run(q(`(first: 3, after: "${encodeCursor(40)}")`)).posts.edges.length, 0);
  assert.equal(run("{ posts(first: 10) @count(n: 4) { id } }").posts.length, 4); // plain paged list clipped too
});

test("@gen: a named generator with arguments", () => {
  const out = run('{ users { age: score @gen(name: "int", min: 1, max: 3) first: nick @gen(name: "person.first") } }');
  for (const u of out.users) {
    assert.ok([1, 2, 3].includes(u.age));
    assert.match(u.first, /^\p{Lu}/u);
  }
  assert.match(inferSchema('{ users { n @gen(name: "int", min: 1, max: 3) f @gen(name: "float") b @gen(name: "bool") d @gen(name: "time.created") } }').sdl, /n: Int!\n  f: Float!\n  b: Boolean!\n  d: DateTime!/);
  const spec = run("{ users { age: score first: nick } }", { spec: { "users.score": { gen: { name: "int", args: { min: 1, max: 3 } } }, "users.nick": { gen: "person.first" } } });
  assert.equal(json(spec), json(out));
  assert.equal(json(run("{ users { x } }", { spec: { "users.x": { gen: "int" } } })), json(run('{ users { x @gen(name: "int") } }')));
});

test("@pattern: # digit, ? lowercase, A uppercase, * alphanumeric, backslash escapes", () => {
  const out = run('{ orders { code @pattern(p: "ORD-#####") tag @pattern(p: "A?*\\\\#") } }');
  for (const o of out.orders) {
    assert.match(o.code, /^ORD-\d{5}$/);
    assert.match(o.tag, /^[A-Z][a-z][A-Za-z0-9]#$/);
  }
  assert.equal(json(run("{ orders { code } }", { spec: { "orders.code": { pattern: "ORD-#####" } } }).orders.map((o) => o.code)), json(out.orders.map((o) => o.code)));
  assert.equal(code(() => run("{ orders { code @pattern(p: 5) } }")), "bad-directive");
});

test("@pick: a fixed set, optionally weighted", () => {
  const out = run('{ tickets { state @pick(values: ["open", "closed"]) } }');
  for (const t of out.tickets) assert.ok(["open", "closed"].includes(t.state));
  const w = Array.from({ length: 200 }, (_, i) => graceholder('{ tickets { state @pick(values: [{value: "a", weight: 9}, {value: "b", weight: 1}]) } }', { seed: `w${i}` }).tickets).flat();
  const a = w.filter((t) => t.state === "a").length;
  assert.ok(a / w.length > 0.8 && a < w.length);
  assert.match(inferSchema('{ t { n @pick(values: [1, 2]) f @pick(values: [1.5]) b @pick(values: [true]) } }').sdl, /n: Int!\n  f: Float!\n  b: Boolean!/);
  assert.equal(json(run("{ tickets { state } }", { spec: { "tickets.state": { pick: ["open", "closed"] } } })), json(out));
  assert.equal(code(() => run("{ tickets { state @pick(values: []) } }")), "bad-directive");
});

test("@nullRate: nullable fields, deterministic nulls", () => {
  const q = "{ users(first: 400) { id bio @nullRate(p: 0.5) never: age @nullRate(p: 0) always: city @nullRate(p: 1) } }";
  const a = run(q).users;
  assert.equal(json(a), json(run(q).users));
  const nulls = a.filter((u) => u.bio === null).length;
  assert.ok(nulls > 140 && nulls < 260, String(nulls));
  assert.ok(a.every((u) => u.never !== null && u.always === null));
  assert.match(inferSchema(q).sdl, /bio: String\n/);
  assert.match(inferSchema(q).sdl, /age: Int!\n/);
  assert.match(inferSchema(q).sdl, /city: String\n/);
  // the non-null values equal the values without the directive
  const plain = run("{ users(first: 400) { id bio } }").users;
  for (let i = 0; i < a.length; i++) if (a[i].bio !== null) assert.equal(a[i].bio, plain[i].bio);
  // nulling an object skips its subtree; spec form is equivalent
  const o = run("{ posts { author @nullRate(p: 1) { name } } }").posts;
  assert.ok(o.every((p) => p.author === null));
  assert.equal(json(run(q.replace(/ @nullRate\(p: [01.5]+\)/g, "")+"", { spec: { "users.bio": { nullRate: 0.5 }, "users.age": { nullRate: 0 }, "users.city": { nullRate: 1 } } })), json(run(q)));
  assert.equal(code(() => run("{ users { bio @nullRate(p: 2) } }")), "bad-directive");
});

test("@derive: copy, slug, username and email forms", () => {
  const out = run('{ posts { title slug @derive(from: "title") } users { firstName email @derive(from: "firstName") handle @derive(from: "fullName") fullName label @derive(from: "city") city } }');
  for (const p of out.posts) assert.equal(p.slug, p.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
  for (const u of out.users) {
    assert.ok(u.email.startsWith(u.firstName.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "") + "@") || u.email.startsWith(u.firstName.toLowerCase().replace(/[^a-z0-9]/g, "")), `${u.email} ${u.firstName}`);
    assert.match(u.email, /@[a-z.]+$/);
    assert.match(u.handle, /^[a-z0-9]+$/);
    assert.equal(u.label, u.city); // other kinds copy
  }
  assert.equal(json(run("{ posts { title slug } }", { spec: { "posts.slug": { derive: { from: "title" } } } }).posts), json(out.posts.map(({ title, slug }) => ({ title, slug }))));
  // the source need not be selected
  assert.equal(run('{ posts { slug @derive(from: "title") } }').posts[0].slug, out.posts[0].slug);
});

test("@type: sets the type name and shares its pool", () => {
  const out = run('{ posts { author @type(name: "User") { id name } } users { id name } }');
  assert.match(inferSchema('{ posts { author @type(name: "User") { id } } }').sdl, /author: User!/);
  let matched = 0;
  for (const p of out.posts) {
    const u = out.users.find((x) => x.id === p.author.id);
    if (u) { assert.equal(json(u), json(p.author)); matched++; }
  }
  const ids = new Set();
  for (let i = 0; i < 60; i++) {
    const r = graceholder('{ posts { author @type(name: "User") { id name } } users { id name } }', { seed: `t${i}` });
    for (const p of r.posts) { const u = r.users.find((x) => x.id === p.author.id); if (u) { assert.equal(json(u), json(p.author)); ids.add(u.id); } }
  }
  assert.ok(ids.size > 0 || matched > 0);
  assert.equal(json(run("{ posts { author { id name } } users { id name } }", { spec: { "posts.author": { type: "User" } } })), json(out));
  assert.equal(json(run("{ posts { author { id name } } users { id name } }", { spec: { "@Author.name": { gen: "word" } } }).users), json(out.users));
});

test("@seed: overrides the seed for a subtree, inner wins, operation level too", () => {
  const base = run("{ users { id name } posts { id title } }");
  const sub = run('{ users @seed(s: "x") { id name } posts { id title } }');
  assert.equal(json(sub.posts), json(base.posts)); // outside the subtree: untouched
  assert.notEqual(json(sub.users), json(base.users));
  assert.equal(json(sub.users), json(graceholder("{ users { id name } }", { seed: "x" }).users));
  // nested: the inner seed wins over the outer one, and the outer applies to siblings of the inner
  const nested = run('{ users @seed(s: "x") { id name posts @seed(s: "y") { id title } comments { id text } } }');
  const yOnly = graceholder("{ users { id posts { id title } } }", { seed: "y" });
  assert.equal(json(nested.users[0].posts), json(yOnly.users[0].posts));
  const xOnly = graceholder("{ users { id name comments { id text } } }", { seed: "x" });
  assert.equal(json(nested.users.map((u) => u.comments)), json(xOnly.users.map((u) => u.comments)));
  // operation level
  assert.equal(json(run('query @seed(s: "z") { users { name } }')), json(graceholder("{ users { name } }", { seed: "z" })));
  // spec form
  assert.equal(json(run("{ users { id name } posts { id title } }", { spec: { users: { seed: "x" } } })), json(sub));
  // a seed override with a numeric value is its string form
  assert.equal(json(run("{ users { name } }", { spec: { users: { seed: 5 } } })), json(graceholder("{ users { name } }", { seed: "5" })));
});

test("directive arguments may be variables", () => {
  const q = "query($n: Int!, $s: String!) { posts @count(n: $n) { id title @pattern(p: $s) } }";
  const out = run(q, { variables: { n: 3, s: "T-##" } });
  assert.equal(out.posts.length, 3);
  assert.match(out.posts[0].title, /^T-\d\d$/);
});

// ---- spec: matching, precedence, options ---------------------------------------------

test("path patterns: literal, *, **, anchoring and @Type.field", () => {
  const m = (pattern, path, type = "T", name = path.split(".").pop()) => matchPath(compileSpec({ [pattern]: {} }).entries[0], path, type, name);
  const table = [
    ["users", "users", true], ["users", "posts", false], ["users", "users.name", false],
    ["users.name", "users.name", true], ["*.name", "users.name", true], ["*.name", "a.b.name", false],
    ["*.name", "name", false], ["**.name", "name", true], ["**.name", "a.b.name", true], ["**.name", "a.b.names", false],
    ["users.**", "users", true], ["users.**", "users.a.b", true], ["**", "anything.at.all", true],
    ["a.**.z", "a.z", true], ["a.**.z", "a.b.c.z", true], ["a.**.z", "b.z", false], ["*", "users", true], ["*", "a.b", false],
  ];
  for (const [pattern, path, expected] of table) assert.equal(m(pattern, path), expected, `${pattern} vs ${path}`);
  assert.equal(m("@User.email", "x.y.email", "User", "email"), true);
  assert.equal(m("@User.email", "x.y.email", "Admin", "email"), false);
  assert.equal(m("@User.email", "x.y.mail", "User", "mail"), false);
});

test("precedence: directive > exact > * > **, per property", () => {
  const q = (d = "") => `{ users { score ${d} } }`;
  const val = (spec, d) => run(q(d), { spec }).users[0].score;
  const lit = (n) => ({ gen: { name: "int", args: { min: n, max: n } } });
  assert.equal(val({ "**.score": lit(1) }), 1);
  assert.equal(val({ "**.score": lit(1), "*.score": lit(2) }), 2);
  assert.equal(val({ "**.score": lit(1), "*.score": lit(2), "users.score": lit(3) }), 3);
  assert.equal(val({ "users.score": lit(3), "*.score": lit(2) }), 3);
  assert.equal(val({ "users.score": lit(3) }, '@gen(name: "int", min: 4, max: 4)'), 4);
  // @Type.field ranks with exact paths but loses to an exact path
  assert.equal(val({ "@User.score": lit(5), "**.score": lit(1) }), 5);
  assert.equal(val({ "@User.score": lit(5), "users.score": lit(3) }), 3);
  // equal rank: the longer literal prefix, then the later declaration, wins
  assert.equal(val({ "users.*": lit(6), "**.score": lit(1) }), 6);
  assert.equal(val({ "*.score": lit(7), "users.*": lit(8) }), 8);
  assert.equal(val({ "users.*": lit(8), "*.score": lit(7) }), 8);
  assert.equal(val({ "*.score": lit(7), "*.*": lit(9) }), 9); // same class and prefix: the later declaration wins
  assert.equal(val({ "*.*": lit(9), "*.score": lit(7) }), 7);
  // properties merge independently
  const mixed = run("{ posts @count(n: 3) { id label } }", { spec: { "posts.label": { gen: { name: "int", args: { min: 9, max: 9 } } }, posts: { count: 6 } } });
  assert.equal(mixed.posts.length, 3);
  assert.ok(mixed.posts.every((p) => p.label === 9));
});

test("decisions carry sources: directive, spec, heuristic, default", () => {
  const { decisions } = inferSchema('{ users @count(n: 2) { id nick @gen(name: "word") city note } }', { "users.city": { gen: "place.city" } });
  const by = (path, kind) => decisions.find((d) => d.path === path && d.kind === kind);
  assert.equal(by("users", "count").source, "directive");
  assert.equal(by("users", "count").value, 2);
  assert.equal(by("users.nick", "scalar").source, "directive");
  assert.equal(by("users.city", "scalar").source, "spec");
  assert.equal(by("users.id", "scalar").source, "heuristic");
  assert.equal(by("users.note", "scalar").source, "default");
  assert.equal(by("users.id", "scalar").rule, "T1");
});

test("unused spec paths are reported (and an error under strict)", () => {
  const spec = { "users.name": { gen: "word" }, "nothing.here": { count: 1 }, "@Ghost.x": { gen: "word" } };
  const { decisions } = inferSchema("{ users { name } }", spec);
  const unused = decisions.filter((d) => d.kind === "unused").map((d) => d.path).sort();
  assert.deepEqual(unused, ["@Ghost.x", "nothing.here"]);
  assert.ok(decisions.filter((d) => d.kind === "unused").every((d) => d.source === "spec" && d.rule === "unused-spec-path"));
  assert.equal(code(() => run("{ users { name } }", { spec, strict: true })), "unused-spec-path");
  assert.doesNotThrow(() => run("{ users { name } }", { spec }));
});

test("$options: poolSize and endlessTotal", () => {
  const out = run("{ posts { author { id } } }", { spec: { $options: { poolSize: 3 } } });
  assert.ok(out.posts.every((p) => Number(p.author.id) >= 1 && Number(p.author.id) <= 3));
  const c = run("{ posts(first: 2) { totalCount edges { node { id } } } }", { spec: { $options: { endlessTotal: 50 } } });
  assert.equal(c.posts.totalCount, 50);
  assert.equal(code(() => run("{ a }", { spec: { $options: { poolSize: 0 } } })), "bad-spec");
});

test("key: composite identifying arguments, order independent", () => {
  const spec = { member: { key: ["orgId", "userId"] } };
  const a = run("{ x: member(orgId: 1, userId: 2) { name } y: member(userId: 2, orgId: 1) { name } z: member(orgId: 2, userId: 1) { name } }", { spec });
  assert.equal(a.x.name, a.y.name);
  assert.notEqual(a.x.name, a.z.name);
  // without the spec these are not identifying arguments, so both are the top-level entity
  const b = run("{ x: member(orgId: 1, userId: 2) { name } z: member(orgId: 2, userId: 1) { name } }");
  assert.equal(b.x.name, b.z.name);
});

test("own: opts a type out of the shared pool; shared: forces it", () => {
  let sharedHit = 0;
  for (let i = 0; i < 80; i++) {
    const q = "{ posts { author { ... on User { id name } } } users { id name } }";
    const shared = graceholder(q, { seed: `h${i}` });
    const own = graceholder(q, { seed: `h${i}`, spec: { "posts.author": { own: true } } });
    assert.equal(json(shared.users), json(own.users));
    for (const p of own.posts) {
      const u = own.users.find((x) => x.id === p.author.id);
      if (u && u.name === p.author.name) sharedHit++;
    }
  }
  assert.equal(sharedHit, 0, "owned authors must not coincide with pool members");
  // `shared: true` on a nested list draws members from the type pool: ids are 1..n, not hashed
  const sh = run("{ users { posts { id } } }", { spec: { "users.posts": { shared: true } } });
  assert.deepEqual(sh.users[0].posts.map((p) => p.id), sh.users[0].posts.map((_, i) => String(i + 1)));
  assert.ok(inferSchema("{ posts { author { id } } comments { author { id } } }", { "posts.author": { own: true } }).decisions.filter((d) => d.rule === "E2-shared").length < 2);
});

test("count.of follows the declared count of the sibling", () => {
  const out = run("{ posts { commentCount comments @count(n: 7) { id } } }").posts;
  for (const p of out) assert.equal(p.commentCount, 7);
});

// ---- errors ----------------------------------------------------------------------------

test("error codes and did-you-mean hints", () => {
  const unknownDir = err(() => run("{ posts @cunt(n: 1) { id } }"));
  assert.equal(unknownDir.code, "unknown-directive");
  assert.match(unknownDir.hint, /@count/);
  const unknownGen = err(() => run('{ posts { x @gen(name: "persn.first") } }'));
  assert.equal(unknownGen.code, "unknown-generator");
  assert.match(unknownGen.hint, /person\.first/);
  assert.equal(err(() => run("{ posts { x } }", { spec: { "posts.x": { gen: "nope" } } })).code, "unknown-generator");
  assert.equal(code(() => run('{ posts { x @gen(name: "int", min: 5, max: 1) } }')), "bad-generator-args");
  assert.equal(code(() => run("{ posts { x @list @one } }")), "conflicting-overrides");
  assert.equal(code(() => run("{ posts { id } }", { spec: { posts: { list: true, one: true } } })), "conflicting-overrides");
  assert.equal(code(() => run("{ posts { id @list @list } }")), "conflicting-overrides");
  assert.equal(code(() => run("{ posts { x @derive(from: \"x\") } }")), "bad-derive");
  assert.equal(code(() => run('{ posts { a @derive(from: "b") b @derive(from: "a") } }')), "bad-derive");
  assert.equal(code(() => run('{ posts { a @derive(from: "c") b @derive(from: "a") c @derive(from: "b") } }')), "bad-derive");
  assert.equal(code(() => run('{ posts { author @derive(from: "title") { id } title } }')), "conflicting-overrides"); // object field
  assert.equal(code(() => run('{ posts { title @derive(from: "author") author { id } } }')), "bad-derive"); // object source
  assert.equal(code(() => run("{ posts @gen(name: \"int\") { id } }")), "conflicting-overrides");
  // two occurrences of one field that disagree
  assert.equal(code(() => run("{ posts { id @count(n: 1) } posts { id @count(n: 2) } }")), "conflicting-overrides");
});

test("spec validation (bad-spec)", () => {
  const bad = (spec) => code(() => run("{ posts { id } }", { spec }));
  assert.equal(bad({ posts: { nope: 1 } }), "bad-spec");
  assert.equal(bad({ posts: { nullRate: 2 } }), "bad-spec");
  assert.equal(bad({ posts: { count: "x" } }), "bad-spec");
  assert.equal(bad({ posts: { count: [5, 2] } }), "bad-spec");
  assert.equal(bad({ posts: { pattern: 5 } }), "bad-spec");
  assert.equal(bad({ posts: { pick: [] } }), "bad-spec");
  assert.equal(bad({ posts: { derive: "x" } }), "bad-spec");
  assert.equal(bad({ posts: { key: [] } }), "bad-spec");
  assert.equal(bad({ "posts..id": {} }), "bad-spec");
  assert.equal(bad({ "po sts": {} }), "bad-spec");
  assert.equal(bad({ "@User": {} }), "bad-spec");
  assert.equal(bad({ posts: 5 }), "bad-spec");
  assert.equal(bad([]), "bad-spec");
});

test("inferSchema(query, spec): SDL buildSchema accepts, for every golden", () => {
  const dir = new URL("./golden/", import.meta.url).pathname;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const g = JSON.parse(readFileSync(dir + f, "utf8"));
    const { sdl, document } = inferSchema(g.input.query, g.input.spec, { operationName: g.input.options?.operationName });
    assert.doesNotThrow(() => buildSchema(sdl), f);
    assert.equal(document.kind, "Document");
  }
});

test("directives are stripped from the returned document", () => {
  const { document } = inferSchema('query @seed(s: "a") { posts @count(n: 2) @include(if: true) { id @list } }');
  const text = JSON.stringify(document);
  assert.ok(!text.includes('"count"') && !text.includes('"seed"') && !text.includes('"list"'));
  assert.ok(text.includes('"include"'));
});

test("directive and spec forms agree on a larger example", () => {
  const withDirectives = `{
    orders @count(min: 2, max: 4) { code @pattern(p: "ORD-#####") status @pick(values: ["new", "paid"]) items @count(n: 2) { name } }
  }`;
  const spec = { orders: { count: [2, 4] }, "orders.code": { pattern: "ORD-#####" }, "orders.status": { pick: ["new", "paid"] }, "orders.items": { count: 2 } };
  assert.equal(json(run(withDirectives)), json(run("{ orders { code status items { name } } }", { spec })));
});
