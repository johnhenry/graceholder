// explain(query, path, options): snapshot tests of the explanation for each mode, plus the invariants
// that matter more than any snapshot: explaining never changes an output, and the value an
// explanation reports is the value in the output.
// Update the snapshots with UPDATE_SNAPSHOTS=1 node --test test/explain.test.js and review the diff.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { explain, graceholder, createWorld, registerPack, GraceholderError, KEY_SCHEME } from "../src/index.js";
import { geo } from "../src/packs/index.js";
import { keyString } from "../src/key.js";

registerPack(geo);
const SNAP = (name) => fileURLToPath(new URL(`./snapshots/explain/${name}.json`, import.meta.url));
const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";

function snapshot(name, actual) {
  const text = JSON.stringify(actual, null, 2) + "\n";
  if (UPDATE || !existsSync(SNAP(name))) writeFileSync(SNAP(name), text);
  assert.equal(text, readFileSync(SNAP(name), "utf8"), `snapshot ${name} (run with UPDATE_SNAPSHOTS=1 to rewrite)`);
}

const USERS = `{ users(first: 5) { id name email age createdAt tags posts(first: 2) { title author { name } } postCount } }`;

const world = createWorld({ seed: "w" });
world.pin("User:2", { email: "pinned@example.com", firstName: "Zed" });
world.pin("User:3", { name: "Pinned Name" });

const WORLD_Q = `{ users(first: 3) { id email firstName lastName handle @derive(from: "firstName") } }`;

const CASES = [
  { name: "plain-scalar", query: USERS, path: "users.3.email", options: { seed: "s" } },
  { name: "plain-persona-name", query: USERS, path: "users.3.name", options: { seed: "s" } },
  { name: "plain-int-by-name", query: USERS, path: "users.0.age", options: { seed: "s" } },
  { name: "plain-count-of-sibling", query: USERS, path: "users.1.postCount", options: { seed: "s" } },
  { name: "plain-scalar-list-element", query: USERS, path: "users.0.tags.1", options: { seed: "s" } },
  { name: "plain-scalar-list", query: USERS, path: "users.0.tags", options: { seed: "s" } },
  { name: "plain-list", query: USERS, path: "users", options: { seed: "s" } },
  { name: "plain-list-item", query: USERS, path: "users.2", options: { seed: "s" } },
  { name: "plain-nested-owned-list", query: USERS, path: "users.2.posts", options: { seed: "s" } },
  { name: "plain-shared-reference", query: USERS, path: "users.2.posts.1.author", options: { seed: "s" } },
  { name: "plain-shared-reference-field", query: USERS, path: "users.2.posts.1.author.name", options: { seed: "s" } },
  { name: "plain-alias", query: `{ first: users(first: 2) { who: name } }`, path: "first.1.who", options: { seed: "s" } },
  { name: "plain-argument-selected-entity", query: `{ user(id: 42) { name email } }`, path: "user.email", options: { seed: "s" } },
  { name: "plain-order-aggregate", query: `{ order(id: 7) { total subtotal tax items { name price qty } } }`, path: "order.total", options: { seed: "s" } },
  { name: "plain-connection-node-field", query: `{ postsConnection(first: 3) { totalCount edges { cursor node { id title } } } }`, path: "postsConnection.edges.1.node.title", options: { seed: "s" } },
  { name: "plain-connection-total", query: `{ postsConnection(first: 3) { totalCount edges { cursor } } }`, path: "postsConnection.totalCount", options: { seed: "s" } },
  { name: "plain-seed-directive", query: `{ user @seed(s: "other") { name } }`, path: "user.name", options: { seed: "s" } },
  { name: "directive-wins-over-spec", query: `{ user { nick @gen(name: "person.username") } }`, path: "user.nick", options: { seed: "s", spec: { "user.nick": { gen: "word" }, "**.nick": { gen: "color" } } } },
  { name: "spec-exact-beats-wildcards", query: `{ user { nick } }`, path: "user.nick", options: { seed: "s", spec: { "**.nick": { gen: "color" }, "*.nick": { gen: "slug" }, "user.nick": { gen: { name: "int", args: { min: 1, max: 9 } } } } } },
  { name: "spec-type-scoped", query: `{ users(first: 2) { status } }`, path: "users.1.status", options: { seed: "s", spec: { "@User.status": { pick: ["on", "off"] } } } },
  { name: "directive-pattern", query: `{ order { code @pattern(p: "ORD-####") } }`, path: "order.code", options: { seed: "s" } },
  { name: "directive-nullrate", query: `{ users(first: 6) { id city @nullRate(p: 0.5) } }`, path: "users.0.city", options: { seed: "s" } },
  { name: "directive-nullrate-hit", query: `{ users(first: 6) { id city @nullRate(p: 0.5) } }`, path: "users.2.city", options: { seed: "s" } },
  { name: "derive", query: `{ user { firstName handle @derive(from: "firstName") } }`, path: "user.handle", options: { seed: "s" } },
  { name: "schema-enum", query: `{ users { id status } }`, path: "users.0.status", options: { seed: "s", schema: "type Query { users: [User!]! } type User { id: ID! status: Status! } enum Status { ACTIVE DISABLED }" } },
  { name: "schema-list-rule", query: `{ users { id name } }`, path: "users", options: { seed: "s", schema: "type Query { users: [User!]! } type User { id: ID! name: String! }" } },
  { name: "pack-geo", query: `{ place { lon city } }`, path: "place.lon", options: { seed: "s", packs: ["geo"] } },
  { name: "realistic-popularity", query: `{ video { followers } }`, path: "video.followers", options: { seed: "s", distributions: "realistic" } },
  { name: "scenario-unicode", query: `{ users(first: 3) { name } }`, path: "users.0.name", options: { seed: "s", scenario: "unicode" } },
  { name: "scenario-boundary", query: `{ users(first: 3) { age } }`, path: "users.0.age", options: { seed: "s", scenario: "boundary" } },
  { name: "scenario-nulls", query: `{ users(first: 3) { name } }`, path: "users.1.name", options: { seed: "s", scenario: "nulls" } },
  { name: "scenario-errors-field", query: `{ users(first: 3) { id name age } }`, path: "users.0.age", options: { seed: "b", scenario: "errors", scenarioOptions: { errorRate: 0.3 } } },
  { name: "scenario-errors-spared", query: `{ users(first: 3) { id name age } }`, path: "users.1.age", options: { seed: "b", scenario: "errors", scenarioOptions: { errorRate: 0.3 } } },
  { name: "scenario-errors-unavailable", query: `{ users(first: 3) { id name } }`, path: "users.0.name", options: { seed: "q", scenario: "errors", scenarioOptions: { errorRate: 0.9 } } },
  { name: "scenario-empty", query: `{ users(first: 3) { id } }`, path: "users", options: { seed: "s", scenario: "empty" } },
  { name: "scenario-huge", query: `{ users { id } }`, path: "users", options: { seed: "s", scenario: "huge" } },
  { name: "scenario-per-field-spec", query: `{ users(first: 3) { name age } }`, path: "users.0.name", options: { seed: "s", spec: { "users.name": { scenario: "unicode" } } } },
  { name: "world-pinned-field", query: WORLD_Q, path: "users.1.email", options: { world } },
  { name: "world-pinned-persona-first-name", query: WORLD_Q, path: "users.1.lastName", options: { world } },
  { name: "world-derived-from-pin", query: WORLD_Q, path: "users.1.handle", options: { world } },
  { name: "world-unpinned", query: WORLD_Q, path: "users.0.email", options: { world } },
];

for (const c of CASES) {
  test(`explain snapshot: ${c.name}`, () => {
    const ex = explain(c.query, c.path, c.options);
    snapshot(c.name, ex);
    // the value in the explanation is the value in the output
    const opts = c.options.world ? undefined : { ...c.options, errors: "result" };
    const out = c.options.world ? c.options.world.query(c.query) : graceholder(c.query, opts);
    let cur = out.data;
    for (const seg of c.path.split(".")) cur = cur?.[/^\d+$/.test(seg) ? Number(seg) : seg];
    if (ex.kind !== "unavailable" && !ex.error) assert.deepEqual(ex.value, cur === undefined ? undefined : cur);
  });
}

test("explain does not change any output: before, during and after", () => {
  const fixtures = CASES.filter((c) => !c.options.world);
  const before = fixtures.map((c) => JSON.stringify(graceholder(c.query, { ...c.options, errors: "result" })));
  for (const c of CASES) explain(c.query, c.path, c.options);
  const after = fixtures.map((c) => JSON.stringify(graceholder(c.query, { ...c.options, errors: "result" })));
  assert.deepEqual(after, before);
  // and the world's outputs, and its log, are untouched
  const q = WORLD_Q;
  const wBefore = JSON.stringify([world.query(q), world.export()]);
  explain(q, "users.1.email", { world });
  explain(q, "users.2.handle", { world });
  assert.equal(JSON.stringify([world.query(q), world.export()]), wBefore);
});

test("every leaf of every output can be explained, and explains its own value", () => {
  const cases = [
    { q: `{ users(first: 3) { id name email age isActive createdAt tags posts(first: 2) { title author { name } } postCount } }`, o: { seed: "p" } },
    { q: `{ order(id: 3) { id total subtotal tax items { name price qty } } }`, o: { seed: "p" } },
    { q: `{ postsConnection(first: 2) { totalCount pageInfo { hasNextPage endCursor } edges { cursor node { id title } } nodes { id } } }`, o: { seed: "p" } },
    { q: `{ search(first: 4) { __typename ... on User { id name } ... on Post { id title } } }`, o: { seed: "p" } },
    { q: `{ users(first: 3) { id name tags } }`, o: { seed: "p", scenario: ["unicode", "boundary"] } },
    { q: `{ place { lon city country } }`, o: { seed: "p", packs: ["geo"], images: "svg" } },
    { q: WORLD_Q, o: { world } },
  ];
  let leaves = 0;
  for (const { q, o } of cases) {
    const data = o.world ? o.world.query(q).data : graceholder(q, o);
    const walk = (value, path) => {
      if (value !== null && typeof value === "object") {
        for (const [k, v] of Array.isArray(value) ? value.entries() : Object.entries(value)) walk(v, [...path, k]);
        return;
      }
      leaves++;
      const ex = explain(q, path, o);
      assert.deepEqual(ex.value, value, path.join("."));
      assert.equal(typeof ex.summary, "string");
      if (ex.key) {
        // the reported key string is the one the library builds from its parts
        assert.equal(ex.key.string, ex.key.parts.join("\x1f"), path.join("."));
        assert.equal(ex.key.parts[0], KEY_SCHEME);
      }
    };
    walk(data, []);
  }
  assert.ok(leaves > 100, `${leaves} leaves`);
});

test("the key in an explanation is the key string of the value", () => {
  const ex = explain(USERS, "users.3.email", { seed: "s" });
  assert.equal(ex.key.string, keyString({ seed: "s", scope: "e", typeName: "User", entityKey: "4", fieldName: "email" }));
  assert.match(ex.key.hash, /^0x[0-9a-f]{16}$/);
  assert.equal(ex.entity.identity, "User:4");
});

test("the explained value moves with the seed and nothing else", () => {
  const a = explain(USERS, "users.3.email", { seed: "s" });
  const b = explain(USERS, "users.3.email", { seed: "t" });
  assert.notEqual(a.value, b.value);
  assert.notEqual(a.key.string, b.key.string);
  assert.deepEqual([a.generator, a.rule, a.precedence, a.field, a.entity.identity], [b.generator, b.rule, b.precedence, b.field, b.entity.identity]);
});

test("adding a field to the query does not change the key or the value of another", () => {
  const a = explain(`{ users(first: 5) { email } }`, "users.3.email", { seed: "s" });
  const b = explain(`{ users(first: 5) { id name email extra } }`, "users.3.email", { seed: "s" });
  assert.equal(a.value, b.value);
  assert.deepEqual(a.key, b.key);
});

test("paths: dotted, bracketed and array forms agree", () => {
  const a = explain(USERS, "users.3.email", { seed: "s" });
  assert.deepEqual(explain(USERS, "users[3].email", { seed: "s" }), a);
  assert.deepEqual(explain(USERS, ["users", 3, "email"], { seed: "s" }), a);
});

test("bad paths throw bad-path with a hint", () => {
  for (const p of ["users.9.email", "users.0.nope", "nope", "", "users.0.email.x", "users.-1"]) {
    assert.throws(() => explain(USERS, p, { seed: "s" }), (e) => e instanceof GraceholderError && e.code === "bad-path", p);
  }
  assert.throws(() => explain(USERS, 5, {}), (e) => e instanceof GraceholderError && e.code === "bad-path");
});

test("explain rejects what graceholder rejects", () => {
  assert.throws(() => explain("{ users { id }", "users", {}), (e) => e.code === "graphql");
  assert.throws(() => explain("mutation { a }", "a", {}), (e) => e.code === "bad-operation");
  assert.throws(() => explain(USERS, "users.0.id", { locale: "xx" }), (e) => e.code === "unknown-locale");
});

test("world.explain and explain({ world }) are the same", () => {
  assert.deepEqual(world.explain(WORLD_Q, "users.1.email"), explain(WORLD_Q, "users.1.email", { world }));
});

test("a deleted entity explains the null it leaves behind", () => {
  const w = createWorld({ seed: "d" });
  const q = `{ posts(first: 3) { id author { name } } }`;
  const before = w.query(q).data;
  assert.ok(before.posts[0].author);
  const key = explain(q, "posts.0.author", { world: w }).entity.key;
  w.query(`mutation { deleteAuthor(id: ${JSON.stringify(key)}) { id } }`);
  const ex = explain(q, "posts.0.author.name", { world: w });
  assert.equal(ex.kind, "unavailable");
  assert.match(ex.because, /deleted/);
  snapshot("world-deleted-unavailable", ex);
});
