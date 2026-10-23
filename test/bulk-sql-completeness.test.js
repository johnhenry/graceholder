// toSQL must write exactly the distinct entities and child rows present in the stream (plus referenced
// pool entities), whichever place an entity is first met: as a root item or as a reference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stream, toSQL, sqlWriter } from "../src/index.js";

const DatabaseSync = await import("node:sqlite").then((m) => m.DatabaseSync, () => null);
const sqliteTest = DatabaseSync ? test : test.skip;
const join = (it) => [...it].join("");

const REPRO = 'query { users { id name email posts(first: 2) { title author @type(name: "User") { id name } } } }';

/** The entities a stream of REPRO-shaped queries contains, keyed like the SQL primary keys. */
function expected(items, { authorPosts = false } = {}) {
  const users = new Map();
  const posts = new Map();
  const put = (map, key, value, what) => {
    if (map.has(key)) assert.deepEqual(map.get(key), value, `${what} ${key} has two different values in the stream`);
    map.set(key, value);
  };
  const addPost = (userId, i, p) => {
    put(posts, `${userId}.posts.${i + 1}`, { title: p.title }, "post");
    if (p.author) addAuthor(p.author);
  };
  const addAuthor = (a) => {
    put(users, a.id, { name: a.name }, "user");
    if (authorPosts && a.posts) a.posts.forEach((p, i) => addPost(a.id, i, p));
  };
  for (const u of items) {
    put(users, u.id, { name: u.name }, "user");
    u.posts.forEach((p, i) => addPost(u.id, i, p));
  }
  return { users, posts };
}

function load(source, options = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(join(toSQL(source, { dialect: "sqlite", ...options })));
  return db;
}

function check(db, { users, posts }, label) {
  const gotUsers = new Map(db.prepare("select id, name from user").all().map((r) => [String(r.id), { name: r.name }]));
  assert.deepEqual([...gotUsers.keys()].sort(), [...users.keys()].sort(), `${label}: users`);
  for (const [id, v] of users) assert.deepEqual(gotUsers.get(id), v, `${label}: user ${id}`);
  const gotPosts = new Map(db.prepare("select _key, title from post").all().map((r) => [r._key, { title: r.title }]));
  assert.deepEqual([...gotPosts.keys()].sort(), [...posts.keys()].sort(), `${label}: posts`);
  for (const [k, v] of posts) assert.deepEqual(gotPosts.get(k), v, `${label}: post ${k}`);
  assert.deepEqual(db.prepare("pragma foreign_key_check").all(), [], `${label}: foreign keys`);
}

sqliteTest("regression: a user first met as a post author still gets its own posts when it arrives as a root item", () => {
  const q = REPRO;
  const items = [...stream(q, { seed: "demo", count: 50 })];
  const want = expected(items);
  assert.equal(want.posts.size, 100);
  assert.ok(want.users.size > 50, "some authors are not streamed users");
  const db = load(stream(q, { seed: "demo", count: 50 }));
  assert.equal(db.prepare("select count(*) n from post").get().n, 100);
  assert.equal(db.prepare("select count(*) n from user").get().n, want.users.size);
  check(db, want, "repro");
  db.close();
});

sqliteTest("property: the tables hold exactly the stream's entities, for many seeds, counts and chunk sizes", () => {
  for (const seed of ["demo", "a", "b", "c", "zz9"]) {
    for (const [count, chunkSize] of [[1, 500], [7, 3], [30, 8], [60, 500], [120, 25]]) {
      const items = [...stream(REPRO, { seed, count })];
      const db = load(stream(REPRO, { seed, count, chunkSize }));
      check(db, expected(items), `${seed}/${count}/${chunkSize}`);
      db.close();
    }
  }
});

sqliteTest("property: authors selected with their own posts, in every order of first meeting", () => {
  const q = 'query { users { id name posts(first: 2) { title author @type(name: "User") { id name posts(first: 2) { title } } } } }';
  for (const seed of ["demo", "p", "q"]) {
    for (const count of [5, 40, 90]) {
      const items = [...stream(q, { seed, count })];
      const db = load(stream(q, { seed, count, chunkSize: 11 }));
      check(db, expected(items, { authorPosts: true }), `${seed}/${count}`);
      db.close();
    }
  }
});

sqliteTest("a root entity first met as a reference in an earlier chunk is completed in a later chunk", () => {
  // chunkSize 5: user 40 is a post author in the first windows and a root item in a later one
  const items = [...stream(REPRO, { seed: "demo", count: 60, chunkSize: 5 })];
  const firstRef = items.findIndex((u) => u.posts.some((p) => Number(p.author.id) > 40 && Number(p.author.id) <= 60));
  assert.ok(firstRef >= 0 && firstRef < 35);
  const db = load(stream(REPRO, { seed: "demo", count: 60, chunkSize: 5 }));
  check(db, expected(items), "later chunk");
  db.close();
});

sqliteTest("a reference met first without a nested reference is completed by a later richer one (UPDATE of the foreign key)", () => {
  // authors are selected plain on the first posts' authors; friend is only selected on root users
  const q = 'query { users { id name friend @type(name: "User") { id name } posts(first: 2) { title author @type(name: "User") { id name } } } }';
  const db = load(stream(q, { seed: "demo", count: 60 }));
  const items = [...stream(q, { seed: "demo", count: 60 })];
  for (const u of items) {
    const row = db.prepare("select friend_id from user where id = ?").get(Number(u.id));
    assert.equal(row.friend_id, Number(u.friend.id), `friend of user ${u.id}`);
  }
  assert.deepEqual(db.prepare("pragma foreign_key_check").all(), []);
  db.close();
});

test("chunked SQL equals a single run, including entities met first as references", () => {
  const opts = { seed: "demo", count: 120, chunkSize: 9, dialect: "sqlite" };
  const single = join(toSQL(REPRO, opts));
  const w = sqlWriter(REPRO, opts);
  assert.equal(w.header() + join(w.rows(0, 40)) + join(w.rows(40, 85)) + join(w.rows(85, 120)) + w.footer(), single);
  const late = sqlWriter(REPRO, opts);
  const first = sqlWriter(REPRO, opts);
  assert.equal(first.header() + join(first.rows(0, 40)) + join(late.rows(40, 120)) + first.footer(), single);
  assert.equal(join(toSQL(REPRO, { ...opts, chunkSize: 500 })), single);
});
