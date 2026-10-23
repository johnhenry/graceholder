import { test } from "node:test";
import assert from "node:assert/strict";
import { stream, graceholder, createWorld, registerPack, GraceholderError } from "../src/index.js";
import geo from "../src/packs/geo.js";
import commerce from "../src/packs/commerce.js";

registerPack(geo);
registerPack(commerce);

const take = (it, n) => {
  const out = [];
  for (const x of it) {
    out.push(x);
    if (out.length >= n) break;
  }
  return out;
};
const same = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);

/** Item k of a stream must be item k of the windowed query (the core property of stream()). */
function checkEquivalence({ selection, field = "users", options = {}, count = 1100, indexes = [0, 1, 2, 7, 63, 64, 99, 100, 101, 499, 500, 501, 999, 1000], run = graceholder, chunkSize }) {
  const s = stream(`{ ${field} { ${selection} } }`, { ...options, count, ...(chunkSize ? { chunkSize } : {}) });
  const items = [...s];
  assert.equal(items.length, count);
  for (const k of indexes.filter((i) => i < count)) {
    const windowed = run(`{ ${field}(offset: ${k}, first: 1) { ${selection} } }`, options);
    const item = (windowed.data ?? windowed)[field][0];
    same(items[k], item, `item ${k}`);
  }
}

test("stream() yields exactly the items of the equivalent windowed query", () => {
  checkEquivalence({ selection: "id name email createdAt posts { id title author { id name } } address { city } tags", options: { seed: "eq" } });
});

test("equivalence holds for every chunk size", () => {
  const reference = [...stream(`{ users { id name posts { id title } } }`, { seed: "c", count: 130, chunkSize: 500 })];
  for (const chunkSize of [1, 2, 7, 64, 129, 130, 131, 10000]) {
    same([...stream(`{ users { id name posts { id title } } }`, { seed: "c", count: 130, chunkSize })], reference, `chunkSize ${chunkSize}`);
  }
});

test("equivalence holds with a spec, packs, realism options, locale, anchorDate and variables", () => {
  const spec = { "users.name": { gen: "person.full" }, "users.plan": { pick: ["free", "pro", "team"] }, "users.score": { nullRate: 0.3 } };
  checkEquivalence({ selection: "id name plan score email", options: { seed: "spec", spec, anchorDate: "2030-06-01T00:00:00Z" }, count: 600 });
  checkEquivalence({ selection: "id name address { city country } price", options: { seed: "packs", packs: ["geo", "commerce"] }, count: 600 });
  checkEquivalence({ selection: "id views likes salesHistory { date value }", options: { seed: "real", distributions: "realistic", images: "svg" }, count: 600 });
});

test("equivalence holds with directives in the query and a variable", () => {
  const sel = "id name nick @gen(name: \"word\") city";
  const s = stream(`query Q($c: Int) { users @count(n: $c) { ${sel} } }`, { seed: "d", variables: { c: 50 } });
  const items = [...s];
  assert.equal(items.length, 50);
  for (const k of [0, 17, 49]) {
    const w = graceholder(`query Q($c: Int) { users(offset: ${k}, first: 1) @count(n: $c) { ${sel} } }`, { seed: "d", variables: { c: 50 } });
    same(items[k], w.users[0]);
  }
});

test("equivalence holds in schema mode, whichever paging arguments the schema declares", () => {
  const body = `
    type User { id: ID! name: String! email: String! role: Role! tags: [String!]! friends: [User!]! }
    enum Role { ADMIN EDITOR VIEWER }`;
  const styles = [
    ["offset: Int, first: Int", "offset: 77, first: 1"],
    ["skip: Int, take: Int", "skip: 77, take: 1"],
    ["offset: Int, limit: Int", "offset: 77, limit: 1"],
  ];
  for (const [args, window] of styles) {
    const schema = `type Query { users(${args}): [User!]! }${body}`;
    const items = [...stream(`{ users { id name role tags friends { id name } } }`, { seed: "sch", schema, count: 120, chunkSize: 50 })];
    assert.equal(items.length, 120, args);
    const w = graceholder(`{ users(${window}) { id name role tags friends { id name } } }`, { seed: "sch", schema });
    same(items[77], w.users[0], args);
  }
  const cursorSchema = `type Query { users(first: Int, after: String): [User!]! }${body}`;
  const a = [...stream(`{ users { id name } }`, { seed: "sch", schema: cursorSchema, count: 30, chunkSize: 7 })];
  const b = [...stream(`{ users { id name } }`, { seed: "sch", schema: cursorSchema, count: 30, chunkSize: 30 })];
  same(a, b);
  assert.equal(a.length, 30);
});

test("a world: stream() reflects pins, creations and deletions exactly like windowed world queries", () => {
  const w = createWorld({ seed: "w" });
  w.pin("User:3", { name: "Pinned Person", email: "pinned@example.org" });
  w.query(`mutation { createUser(input: { name: "Brand New", email: "new@example.org" }) { id } }`);
  w.query(`mutation { deleteUser(id: 5) }`);
  const sel = "id name email";
  const items = [...w.stream(`{ users { ${sel} } }`, { count: 40, chunkSize: 9 })];
  assert.equal(items.length, 40);
  assert.equal(items.find((u) => u.id === "3").name, "Pinned Person");
  assert.ok(!items.some((u) => u.id === "5"));
  for (const k of [0, 2, 3, 4, 5, 39]) {
    same(items[k], w.query(`{ users(offset: ${k}, first: 1) { ${sel} } }`).data.users[0], `item ${k}`);
  }
  // a world with nothing in it streams what graceholder() windows
  const plain = createWorld({ seed: "w" });
  same([...plain.stream(`{ users { ${sel} } }`, { count: 25 })], [...stream(`{ users { ${sel} } }`, { seed: "w", count: 25 })]);
});

test("a world stream with a schema and packs works too", () => {
  const w = createWorld({ seed: "wp", packs: ["geo"] });
  w.pin("User:2", { name: "Ada Pin" });
  const items = [...w.stream(`{ users { id name address { city } } }`, { count: 10 })];
  assert.equal(items[1].name, "Ada Pin");
  same(items[3], w.query(`{ users(offset: 3, first: 1) { id name address { city } } }`).data.users[0]);
});

test("count, offset, declared counts and clipping", () => {
  const q = `{ users { id } }`;
  same([...stream(q, { seed: "o", count: 5, offset: 10 })], [...stream(q, { seed: "o", count: 15 })].slice(10));
  assert.deepEqual([...stream(q, { seed: "o", count: 0 })], []);
  // a declared @count is the default count and the end
  const declared = [...stream(`{ users @count(n: 23) { id } }`, { seed: "o", chunkSize: 10 })];
  assert.equal(declared.length, 23);
  assert.equal([...stream(`{ users @count(n: 23) { id } }`, { seed: "o", count: 100 })].length, 23);
  assert.equal([...stream(`{ users @count(n: 23) { id } }`, { seed: "o", count: 5, offset: 20 })].length, 3);
  assert.equal([...stream(`{ users @count(min: 3, max: 9) { id } }`, { seed: "o" })].length, graceholder(`{ users @count(min: 3, max: 9) { id } }`, { seed: "o" }).users.length);
  // a spec count counts too
  assert.equal([...stream(q, { seed: "o", spec: { users: { count: 12 } } })].length, 12);
});

test("stream() needs a count unless the size is declared, and rejects bad options", () => {
  assert.throws(() => stream(`{ users { id } }`, { seed: "o" }), (e) => e instanceof GraceholderError && e.code === "bad-options" && /count/.test(e.message));
  for (const bad of [{ count: -1 }, { count: 1.5 }, { count: 3, offset: -1 }, { count: 3, chunkSize: 0 }, { count: 3, chunkSize: 10001 }, { count: "3" }]) {
    assert.throws(() => stream(`{ users { id } }`, bad), (e) => e.code === "bad-options", JSON.stringify(bad));
  }
  assert.throws(() => stream(`{ user(id: 1) { id } }`, { count: 3 }), (e) => e.code === "bad-options");
  assert.throws(() => stream(`{ users { id } }`, { count: 3, field: "nope" }), (e) => e.code === "bad-options");
  assert.throws(() => stream(`{ users {`, { count: 3 }), (e) => e.code === "graphql");
  assert.throws(() => stream(`mutation { x }`, { count: 3 }), (e) => e.code === "bad-operation");
});

test("the field option picks the collection, aliases work, other root fields are ignored", () => {
  const q = `{ me: user(id: 1) { id } people: users { id name } posts { id title } }`;
  const first = [...stream(q, { seed: "f", count: 3 })];
  assert.deepEqual(Object.keys(first[0]), ["id", "name"]);
  const posts = [...stream(q, { seed: "f", count: 3, field: "posts" })];
  assert.deepEqual(Object.keys(posts[0]), ["id", "title"]);
  same(posts, graceholder(`{ posts(first: 3) { id title } }`, { seed: "f" }).posts);
});

test("paging arguments written in the query are replaced by the stream's own window", () => {
  same([...stream(`{ users(first: 2, offset: 40) { id name } }`, { seed: "p", count: 4 })], [...stream(`{ users { id name } }`, { seed: "p", count: 4 })]);
});

test("filter arguments on the collection are kept and select a different, repeatable collection", () => {
  const a = [...stream(`{ users(role: "admin") { id name } }`, { seed: "a", count: 20 })];
  const b = [...stream(`{ users(role: "viewer") { id name } }`, { seed: "a", count: 20 })];
  assert.notDeepEqual(a, b);
  same(a, [...stream(`{ users(role: "admin") { id name } }`, { seed: "a", count: 20 })]);
  same(a[11], graceholder(`{ users(role: "admin", offset: 11, first: 1) { id name } }`, { seed: "a" }).users[0]);
});

test("a stream is lazy, re-iterable and also an async iterable", async () => {
  const s = stream(`{ users { id name } }`, { seed: "l", count: 250, chunkSize: 100 });
  same(take(s, 3), take(s, 3));
  const sync = [...s];
  const viaAsync = [];
  for await (const u of s) viaAsync.push(u);
  same(viaAsync, sync);
  assert.equal(sync.length, 250);
  assert.deepEqual([...s.chunks()].map((c) => c.length), [100, 100, 50]);
  // taking three items of a million generates one window, not a million items
  const big = stream(`{ users { id } }`, { seed: "l", count: 1_000_000, chunkSize: 4 });
  assert.equal(take(big, 3).length, 3);
});

test("a Relay connection root streams its nodes", () => {
  const s = [...stream(`{ postsConnection { edges { node { id title } } } }`, { seed: "r", count: 30, chunkSize: 8 })];
  assert.equal(s.length, 30);
  const w = graceholder(`{ postsConnection(offset: 12, first: 1) { edges { node { id title } } } }`, { seed: "r" });
  same(s[12], w.postsConnection.edges[0].node);
  const nodes = [...stream(`{ postsConnection { totalCount nodes { id } } }`, { seed: "r", count: 5 })];
  assert.equal(nodes.length, 5);
  assert.throws(() => [...stream(`{ postsConnection { totalCount pageInfo { hasNextPage } } }`, { seed: "r", count: 5 })], (e) => e.code === "bad-options");
});

test("the core invariant survives streaming: adding, removing and aliasing fields never changes other values", () => {
  const base = [...stream(`{ users { id name email } }`, { seed: "i", count: 40 })];
  const more = [...stream(`{ users { email extra: city name posts { id } id } }`, { seed: "i", count: 40 })];
  for (let k = 0; k < 40; k++) {
    assert.equal(more[k].id, base[k].id);
    assert.equal(more[k].name, base[k].name);
    assert.equal(more[k].email, base[k].email);
  }
});

test("errors from a window surface with their own code", () => {
  assert.throws(() => [...stream(`{ users { id } }`, { seed: "e", count: 3, strict: true, spec: { "nope.x": { gen: "word" } } })], (e) => e.code === "unused-spec-path");
});
