import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, graceholder, GraceholderError } from "../src/index.js";
import { classifyMutation } from "../src/world.js";
import { compileSpec } from "../src/spec.js";

const LIST = `{ users { id name email } }`;
const ids = (r, field = "users") => r.data[field].map((u) => u.id);

// ---- equivalence with graceholder() ------------------------------------------------------

test("without pins or mutations a world answers exactly like graceholder()", () => {
  const queries = [
    [`{ users { id name email createdAt } }`, {}],
    [`{ user(id: 7) { id name email posts { id title } } }`, {}],
    [`query A($n: Int) { users(first: $n) { id } } query B { orders { id items { price quantity } subtotal total } }`, { operationName: "A", variables: { n: 5 } }],
    [`{ postsConnection(first: 3) { totalCount pageInfo { hasNextPage endCursor } edges { cursor node { id title } } } }`, {}],
    [`{ products(page: 2, pageSize: 4) { id name price } }`, {}],
    [`{ user(id: 3) { postCount posts { id } } }`, {}],
  ];
  for (const seed of ["graceholder", "other"]) {
    const w = createWorld({ seed });
    for (const [q, o] of queries) {
      assert.deepEqual(w.query(q, o), { data: graceholder(q, { seed, ...o }) }, q);
      assert.equal(JSON.stringify(w.query(q, o).data), JSON.stringify(graceholder(q, { seed, ...o })));
    }
  }
});

test("the world honours seed, spec, anchorDate and locale like graceholder()", () => {
  const spec = { "users": { count: 3 }, "@User.name": { pick: ["Ann", "Bob"] } };
  const w = createWorld({ seed: 42, spec, anchorDate: "2030-06-01T00:00:00.000Z" });
  const q = `{ users { id name createdAt } }`;
  assert.deepEqual(w.query(q).data, graceholder(q, { seed: 42, spec, anchorDate: "2030-06-01T00:00:00.000Z" }));
  assert.throws(() => createWorld({ locale: "xx" }), (e) => e.code === "unknown-locale");
  assert.throws(() => createWorld({ anchorDate: "nope" }), (e) => e.code === "bad-options");
  assert.throws(() => createWorld({ spec: { "users": { count: -1 } } }), (e) => e.code === "bad-spec");
});

test("query errors come back as a GraphQL result instead of throwing", () => {
  const w = createWorld();
  const parse = w.query(`{ users { id `);
  assert.equal(parse.data, undefined);
  assert.ok(parse.errors[0].message);
  const bad = w.query(`{ users(first: -1) { id } }`);
  assert.equal(bad.errors[0].extensions.code, "bad-arguments");
  const noOp = w.query(`query A { users { id } } query B { users { id } }`);
  assert.equal(noOp.errors[0].extensions.code, "bad-operation");
  assert.equal(w.query(`subscription S { users { id } }`).errors[0].extensions.code, "bad-operation");
});

// ---- pins ------------------------------------------------------------------------------

test("pin overrides the named fields of one entity and nothing else", () => {
  const w = createWorld({ seed: "p" });
  const before = w.query(`{ users { id name role status } }`).data.users;
  w.pin("User:2", { name: "Alice Admin", role: "ADMIN" });
  const after = w.query(`{ users { id name role status } }`).data.users;
  assert.equal(after[1].name, "Alice Admin");
  assert.equal(after[1].role, "ADMIN");
  assert.equal(after[1].status, before[1].status);
  for (const i of [0, 2, 3]) if (after[i]) assert.deepEqual(after[i], before[i]);
  assert.deepEqual(w.query(`{ user(id: 2) { id name } }`).data.user, { id: "2", name: "Alice Admin" });
});

test("a pinned entity is the same wherever it appears, and aliasing does not matter", () => {
  const w = createWorld();
  w.pin("User:5", { name: "Pat Pinned" });
  const r = w.query(`{ a: user(id: 5) { name } b: user(id: 5) { who: name } posts { author { id name } } }`).data;
  assert.equal(r.a.name, "Pat Pinned");
  assert.equal(r.b.who, "Pat Pinned");
  assert.equal(w.query(`{ user(id: "5") { name } }`).data.user.name, "Pat Pinned");
  const refs = r.posts.filter((p) => p.author.id === "5");
  for (const p of refs) assert.equal(p.author.name, "Pat Pinned");
});

test("pinned values may be null, numbers, booleans and scalar lists, and beat nullRate", () => {
  const spec = { "@User.nickname": { nullRate: 1 } };
  const w = createWorld({ spec });
  w.pin("User:1", { nickname: "Nick", age: 99, active: false, middleName: null, emails: ["a@x.io", "b@x.io"] });
  const u = w.query(`{ user(id: 1) { nickname age active middleName emails } }`).data.user;
  assert.deepEqual(u, { nickname: "Nick", age: 99, active: false, middleName: null, emails: ["a@x.io", "b@x.io"] });
});

test("pin coherence: a pinned full name drives first, last, username and email", () => {
  const w = createWorld({ seed: "coh" });
  w.pin("User:1", { name: "Alice Admin" });
  const u = w.query(`{ user(id: 1) { name firstName lastName username email } }`).data.user;
  assert.equal(u.name, "Alice Admin");
  assert.equal(u.firstName, "Alice");
  assert.equal(u.lastName, "Admin");
  assert.match(u.username, /^(aadmin|alice\.admin|alice\d\d)$/);
  assert.match(u.email, /^(alice\.admin|aliceadmin|alice\.admin\d{1,2})@[a-z.]+$/);
  // the same entity without the pin has a different name but keeps its other persona slots
  const plain = graceholder(`{ user(id: 1) { name phone } }`, { seed: "coh" }).user;
  assert.notEqual(plain.name, "Alice Admin");
  assert.equal(w.query(`{ user(id: 1) { phone } }`).data.user.phone, plain.phone);
});

test("pin coherence: pinning only a first or last name, and an explicit email wins", () => {
  const w = createWorld({ seed: "coh2" });
  const base = graceholder(`{ user(id: 3) { firstName lastName name } }`, { seed: "coh2" }).user;
  w.pin("User:3", { firstName: "Zelda" });
  const u = w.query(`{ user(id: 3) { firstName lastName name email } }`).data.user;
  assert.equal(u.firstName, "Zelda");
  assert.equal(u.lastName, base.lastName);
  assert.equal(u.name, `Zelda ${base.lastName}`);
  assert.match(u.email, /^zelda/);
  w.pin("User:3", { email: "zelda@hyrule.example" });
  assert.equal(w.query(`{ user(id: 3) { email } }`).data.user.email, "zelda@hyrule.example");
});

test("pin coherence: derived fields follow the pinned source", () => {
  const spec = { "@User.handle": { derive: { from: "name" }, gen: "person.username" } };
  const w = createWorld({ spec });
  w.pin("User:1", { name: "Dee Rive" });
  assert.equal(w.query(`{ user(id: 1) { handle } }`).data.user.handle, "deerive");
});

test("pins to a deleted entity, bad references and bad fields are rejected", () => {
  const w = createWorld();
  for (const bad of ["User", ":1", "User:", "1:2", 5]) assert.throws(() => w.pin(bad, {}), (e) => e.code === "bad-options", String(bad));
  assert.throws(() => w.pin("User:1", [1]), (e) => e.code === "bad-options");
  w.query(`mutation { deleteUser(id: 4) { id } }`);
  assert.throws(() => w.pin("User:4", { name: "x" }), (e) => e.code === "not-found");
});

// ---- create ----------------------------------------------------------------------------

test("create appends to a finite list, with a deterministic id, and later queries see it", () => {
  const w = createWorld({ seed: "c" });
  const before = ids(w.query(LIST));
  const r = w.query(`mutation { createUser(input: { name: "New Person", email: "np@x.io" }) { id name email createdAt updatedAt } }`);
  assert.equal(r.errors, undefined);
  const made = r.data.createUser;
  assert.equal(made.name, "New Person");
  assert.equal(made.email, "np@x.io");
  assert.equal(made.createdAt, "2025-01-01T00:00:00.000Z");
  assert.equal(made.updatedAt, "2025-01-01T00:00:00.000Z");
  assert.deepEqual(ids(w.query(LIST)), [...before, made.id]);
  assert.deepEqual(w.query(`{ user(id: "${made.id}") { id name email } }`).data.user, { id: made.id, name: "New Person", email: "np@x.io" });
  assert.deepEqual(w.query(`{ user(id: ${made.id}) { name } }`).data.user, { name: "New Person" });
});

test("created ids are a function of the seed, the type and the log position only", () => {
  const make = (seed, pre = 0) => {
    const w = createWorld({ seed });
    for (let i = 0; i < pre; i++) w.pin("User:1", { name: `n${i}` });
    return w.query(`mutation { createUser(input: { name: "x" }) { id } }`).data.createUser.id;
  };
  assert.equal(make("s"), make("s"));
  assert.notEqual(make("s"), make("t"));
  assert.notEqual(make("s"), make("s", 1));
  assert.match(make("s"), /^[1-9][0-9]{6}$/);
  const w = createWorld({ seed: "s" });
  const a = w.query(`mutation { a: createUser(input: {name: "a"}) { id } b: createUser(input: {name: "b"}) { id } c: createPost(input: {title: "c"}) { id } }`).data;
  assert.equal(new Set([a.a.id, a.b.id, a.c.id]).size, 3);
});

test("a client-supplied id is used, and a duplicate is an error", () => {
  const w = createWorld();
  assert.equal(w.query(`mutation { createUser(input: { id: "u-100", name: "Given" }) { id name } }`).data.createUser.id, "u-100");
  assert.deepEqual(w.query(`{ user(id: "u-100") { name } }`).data.user, { name: "Given" });
  const dup = w.query(`mutation { createUser(input: { id: "u-100" }) { id } }`);
  assert.equal(dup.data.createUser, null);
  assert.equal(dup.errors[0].extensions.code, "bad-mutation");
  assert.deepEqual(dup.errors[0].path, ["createUser"]);
});

test("input may come from the arguments, other input names, and add/insert verbs", () => {
  const w = createWorld();
  const a = w.query(`mutation { addTodo(title: "Buy milk", isDone: false) { id title isDone } }`).data.addTodo;
  assert.equal(a.title, "Buy milk");
  assert.equal(a.isDone, false);
  const b = w.query(`mutation { insertTodo(data: { title: "Walk" }) { title } }`).data.insertTodo;
  assert.equal(b.title, "Walk");
  assert.deepEqual(w.query(`{ todos { title } }`).data.todos.slice(-2).map((t) => t.title), ["Buy milk", "Walk"]);
});

test("a mutation with no selection returns the id (create, update) or true (delete)", () => {
  const w = createWorld();
  const id = w.query(`mutation { createUser(input: { name: "A" }) }`).data.createUser;
  assert.match(id, /^[0-9]+$/);
  assert.equal(w.query(`mutation { updateUser(id: "${id}", input: { name: "B" }) }`).data.updateUser, id);
  assert.equal(w.query(`mutation { deleteUser(id: "${id}") }`).data.deleteUser, true);
});

test("created entities go to the end of finite lists and the start of endless ones", () => {
  const w = createWorld({ seed: "pos" });
  const finite = ids(w.query(`{ users { id } }`));
  const endless = w.query(`{ users(first: 3) { id } }`).data.users.map((u) => u.id);
  const conn = w.query(`{ usersConnection(first: 3) { totalCount edges { node { id } } } }`).data.usersConnection;
  assert.equal(conn.totalCount, 1000);
  const id1 = w.query(`mutation { createUser(input: {name: "One"}) { id } }`).data.createUser.id;
  const id2 = w.query(`mutation { createUser(input: {name: "Two"}) { id } }`).data.createUser.id;
  assert.deepEqual(ids(w.query(`{ users { id } }`)), [...finite, id1, id2]);
  // endless: the collection is now 1002 long, newest first
  assert.deepEqual(w.query(`{ users(first: 3) { id } }`).data.users.map((u) => u.id), [id2, id1, endless[0]]);
  const c2 = w.query(`{ usersConnection(first: 3) { totalCount edges { node { id } } } }`).data.usersConnection;
  assert.equal(c2.totalCount, 1002);
  assert.deepEqual(c2.edges.map((e) => e.node.id), [id2, id1, conn.edges[0].node.id]);
  // the whole thing is one sequence: the last item is the old last item
  assert.equal(w.query(`{ usersConnection(last: 1) { edges { node { id } } } }`).data.usersConnection.edges[0].node.id, w.query(`{ usersConnection(first: 1, offset: 1001) { edges { node { id } } } }`).data.usersConnection.edges[0].node.id);
});

test("spec position overrides where created entities go", () => {
  const w = createWorld({ seed: "pos", spec: { $mutations: { position: "start" } } });
  const before = ids(w.query(`{ users { id } }`));
  const id = w.query(`mutation { createUser(input: {name: "One"}) { id } }`).data.createUser.id;
  assert.deepEqual(ids(w.query(`{ users { id } }`)), [id, ...before]);
});

test("filtered collections do not gain created entities; the same pool entity is the same everywhere", () => {
  const w = createWorld();
  const id = w.query(`mutation { createUser(input: {name: "F"}) { id } }`).data.createUser.id;
  assert.ok(!ids(w.query(`{ users(role: "ADMIN") { id } }`)).includes(id));
  assert.deepEqual(w.query(`{ a: user(id: ${id}) { name } b: user(id: ${id}) { name } }`).data, { a: { name: "F" }, b: { name: "F" } });
  assert.deepEqual(w.query(`{ user(id: "${id}") { name } }`).data, { user: { name: "F" } });
});

test("counts and totals adjust: declared totals, xCount and connection totals", () => {
  const w = createWorld({ spec: { users: { count: 5 }, usersConnection: { count: 5 } } });
  const total = () => w.query(`{ usersConnection(first: 2) { totalCount pageInfo { hasNextPage } edges { node { id } } } }`).data.usersConnection;
  assert.equal(total().totalCount, 5);
  const w2 = createWorld({ spec: { users: { count: 5 }, usersConnection: { count: 5 } } });
  w2.query(`mutation { createUser(input: {name: "x"}) { id } deleteUser(id: 1) { id } deleteUser2: deleteUser(id: 2) { id } }`);
  assert.equal(w2.query(`{ usersConnection(first: 2) { totalCount edges { node { id } } } }`).data.usersConnection.totalCount, 4);
  assert.equal(w2.query(`{ users { id } }`).data.users.length, 4);
});

test("relations: a created post joins its owner's collection and the owner's count", () => {
  const w = createWorld({ seed: "rel" });
  const q = `{ user(id: 1) { postCount posts { id title } } user2: user(id: 2) { postCount } }`;
  const before = w.query(q).data;
  const made = w.query(`mutation { createPost(input: { userId: 1, title: "Mine" }) { id title userId } }`).data.createPost;
  assert.equal(made.title, "Mine");
  assert.equal(made.userId, "1");
  const after = w.query(q).data;
  assert.equal(after.user.postCount, before.user.postCount + 1);
  assert.deepEqual(after.user.posts, [...before.user.posts, { id: made.id, title: "Mine" }]);
  assert.equal(after.user2.postCount, before.user2.postCount);
  // the post is also in the shared pool
  assert.ok(ids(w.query(`{ posts { id } }`), "posts").includes(made.id));
});

test("relations can be named in the spec", () => {
  const w = createWorld({ seed: "rel", spec: { $mutations: { relations: { "Post.authorId": "User" } } } });
  const before = w.query(`{ user(id: 1) { posts { id } } }`).data.user.posts;
  const made = w.query(`mutation { createPost(input: { authorId: 1, title: "A" }) { id } }`).data.createPost;
  assert.deepEqual(w.query(`{ user(id: 1) { posts { id } } }`).data.user.posts, [...before, { id: made.id }]);
});

// ---- update ----------------------------------------------------------------------------

test("update changes only the given fields and shows in every later query", () => {
  const w = createWorld({ seed: "u" });
  const orig = w.query(`{ user(id: 3) { id name email role } }`).data.user;
  const r = w.query(`mutation { updateUser(id: 3, input: { role: "OWNER" }) { id name role updatedAt } }`).data.updateUser;
  assert.equal(r.role, "OWNER");
  assert.equal(r.name, orig.name);
  assert.equal(r.updatedAt, "2025-01-01T00:00:00.000Z");
  assert.deepEqual(w.query(`{ user(id: 3) { id name email role } }`).data.user, { ...orig, role: "OWNER" });
  assert.equal(w.query(`{ users { id role } }`).data.users.find((u) => u.id === "3").role, "OWNER");
  // update through the arguments, and the id inside the input
  assert.equal(w.query(`mutation { editUser(input: { id: 3, role: "Y" }) { role } }`).data.editUser.role, "Y");
  assert.equal(w.query(`mutation { updateUser(id: 3, role: "Z") { role } }`).data.updateUser.role, "Z");
});

test("update needs an identifying argument and a live entity", () => {
  const w = createWorld();
  const noId = w.query(`mutation { updateUser(input: { name: "x" }) { id } }`);
  assert.equal(noId.errors[0].extensions.code, "bad-mutation");
  w.query(`mutation { deleteUser(id: 3) { id } }`);
  const gone = w.query(`mutation { updateUser(id: 3, input: { name: "x" }) { id } }`);
  assert.equal(gone.errors[0].extensions.code, "not-found");
});

test("updating a pinned entity wins over the pin, and a later pin wins over the update", () => {
  const w = createWorld();
  w.pin("User:1", { name: "Pinned" });
  w.query(`mutation { updateUser(id: 1, input: { name: "Updated" }) { id } }`);
  assert.equal(w.query(`{ user(id: 1) { name } }`).data.user.name, "Updated");
  w.pin("User:1", { name: "Repinned" });
  assert.equal(w.query(`{ user(id: 1) { name } }`).data.user.name, "Repinned");
});

// ---- delete ----------------------------------------------------------------------------

test("delete returns the entity as it was, then it vanishes everywhere", () => {
  const w = createWorld({ seed: "d" });
  const before = w.query(`{ users { id name } }`).data.users;
  const r = w.query(`mutation { deleteUser(id: 2) { id name } }`).data.deleteUser;
  assert.deepEqual(r, before[1]);
  assert.deepEqual(w.query(`{ users { id name } }`).data.users, [before[0], ...before.slice(2)]);
  assert.equal(w.query(`{ user(id: 2) { id name } }`).data.user, null);
  const again = w.query(`mutation { deleteUser(id: 2) { id } }`);
  assert.equal(again.errors[0].extensions.code, "not-found");
  assert.equal(again.data.deleteUser, null);
});

test("deleting a referenced entity makes the reference null", () => {
  const w = createWorld({ seed: "ref", spec: { "@Post.author": { type: "User" } } });
  const posts = w.query(`{ posts { id author { id } } }`).data.posts;
  const victim = posts[0].author.id;
  w.query(`mutation { deleteUser(id: ${victim}) { id } }`);
  const after = w.query(`{ posts { id author { id } } }`).data.posts;
  for (const [i, p] of after.entries()) assert.deepEqual(p.author, posts[i].author.id === victim ? null : posts[i].author);
});

test("remove is a delete verb, and a deleted pool member can be created again", () => {
  const w = createWorld();
  w.query(`mutation { removeUser(id: 1) }`);
  assert.equal(w.query(`{ user(id: 1) { id } }`).data.user, null);
  w.query(`mutation { createUser(input: { id: 1, name: "Back" }) { id } }`);
  assert.deepEqual(w.query(`{ user(id: 1) { id name } }`).data.user, { id: "1", name: "Back" });
});

// ---- pagination ------------------------------------------------------------------------

function pages(w, size) {
  const out = [];
  let after;
  for (let i = 0; i < 400; i++) {
    const c = w.query(`query($after: String) { usersConnection(first: ${size}, after: $after) { pageInfo { hasNextPage endCursor } edges { node { id } } } }`, { variables: { after } }).data.usersConnection;
    out.push(...c.edges.map((e) => e.node.id));
    if (!c.pageInfo.hasNextPage) break;
    after = c.pageInfo.endCursor;
  }
  return out;
}

test("pagination after inserts and deletes is one consistent sequence", () => {
  const w = createWorld({ seed: "pg", spec: { users: { count: 23 }, usersConnection: { count: 23 } } });
  for (let i = 0; i < 4; i++) w.query(`mutation { createUser(input: { name: "n${i}" }) { id } }`);
  for (const id of [1, 5, 6, 23]) w.query(`mutation { deleteUser(id: ${id}) { id } }`);
  const all = w.query(`{ users { id } }`).data.users.map((u) => u.id);
  assert.equal(all.length, 23 + 4 - 4);
  for (const size of [1, 4, 7, 100]) assert.deepEqual(pages(w, size), all, `size ${size}`);
  const total = w.query(`{ usersConnection { totalCount edges { node { id } } } }`).data.usersConnection.totalCount;
  assert.equal(total, all.length);
  // offset windows and last
  assert.deepEqual(w.query(`{ users(first: 3, offset: 5) { id } }`).data.users.map((u) => u.id), all.slice(5, 8));
  assert.deepEqual(w.query(`{ usersConnection(last: 2) { edges { node { id } } } }`).data.usersConnection.edges.map((e) => e.node.id), all.slice(-2));
  assert.deepEqual(w.query(`{ users(page: 2, pageSize: 10) { id } }`).data.users.map((u) => u.id), all.slice(10, 20));
});

test("endless collections: paging through a deleted range skips it", () => {
  const w = createWorld({ seed: "pe" });
  const first = w.query(`{ users(first: 8) { id } }`).data.users.map((u) => u.id);
  w.query(`mutation { deleteUser(id: 2) { id } deleteUser(id: 3) { id } }`);
  const after = w.query(`{ users(first: 8) { id } }`).data.users.map((u) => u.id);
  assert.deepEqual(after, [...first.slice(0, 1), ...first.slice(3), "9", "10"].slice(0, 8).map(String));
  assert.deepEqual(w.query(`{ usersConnection { totalCount edges { node { id } } } }`).data.usersConnection.totalCount, 998);
});

// ---- order aggregates ------------------------------------------------------------------

test("deleting an item adjusts the order's item count and subtotal; created items count too", () => {
  const w = createWorld({ seed: "ord", spec: { "@Order.items": { shared: true } } });
  const q = `{ order(id: 1) { itemCount subtotal items { id price quantity } } }`;
  const sum = (o) => Math.round(o.items.reduce((s, i) => s + Math.round(i.price * 100) * i.quantity, 0)) / 100;
  const o1 = w.query(q).data.order;
  assert.equal(o1.itemCount, o1.items.length);
  assert.equal(o1.subtotal, sum(o1));
  w.query(`mutation { deleteItem(id: "${o1.items[0].id}") { id } }`);
  const o2 = w.query(q).data.order;
  assert.equal(o2.items.length, o1.items.length - 1);
  assert.equal(o2.itemCount, o2.items.length);
  assert.equal(o2.subtotal, sum(o2));
  assert.notEqual(o2.subtotal, o1.subtotal);
  w.query(`mutation { createItem(input: { orderId: 1, price: 10, quantity: 3 }) { id } }`);
  const o3 = w.query(q).data.order;
  assert.equal(o3.items.length, o2.items.length + 1);
  assert.equal(o3.subtotal, sum(o3));
  assert.equal(o3.items.at(-1).price, 10);
});

// ---- replay, export, reset -------------------------------------------------------------

function script(w) {
  w.pin("User:1", { name: "Alice Admin", role: "ADMIN" });
  w.query(`mutation { a: createUser(input: { name: "A" }) { id } b: createUser(input: { name: "B" }) { id } }`);
  w.query(`mutation { createPost(input: { userId: 1, title: "T" }) { id } updateUser(id: 2, input: { role: "X" }) { id } deleteUser(id: 3) { id } }`);
}
const PROBES = [LIST, `{ user(id: 1) { name email postCount posts { id title } } }`, `{ usersConnection(first: 5) { totalCount edges { node { id name } } } }`, `{ posts { id title } }`];

test("export/createWorld replays to the identical state", () => {
  const w = createWorld({ seed: "replay", spec: { users: { count: 6 } }, anchorDate: "2031-01-01T00:00:00Z" });
  script(w);
  const exported = JSON.parse(JSON.stringify(w.export()));
  assert.equal(exported.seed, "replay");
  assert.deepEqual(exported.spec, { users: { count: 6 } });
  assert.equal(exported.log.length, 1 + 2 + 3);
  assert.deepEqual(exported.log.map((e) => e.op), ["pin", "create", "create", "create", "update", "delete"]);
  const w2 = createWorld(exported);
  for (const p of PROBES) assert.equal(JSON.stringify(w2.query(p)), JSON.stringify(w.query(p)), p);
  assert.deepEqual(w2.export(), exported);
  // a replayed world keeps going exactly like the original
  const next = `mutation { createUser(input: { name: "Z" }) { id } }`;
  assert.deepEqual(w2.query(next), w.query(next));
});

test("export is a copy, and the log is append-only", () => {
  const w = createWorld();
  w.pin("User:1", { name: "A" });
  const e1 = w.export();
  e1.log.push({ op: "delete", type: "User", key: "1" });
  e1.log[0].fields.name = "hacked";
  assert.equal(w.query(`{ user(id: 1) { name } }`).data.user.name, "A");
  w.query(`mutation { createUser(input: {name: "x"}) { id } }`);
  const e2 = w.export();
  assert.equal(e2.log.length, 2);
  assert.deepEqual(e2.log[0], { op: "pin", type: "User", key: "1", fields: { name: "A" } });
});

test("reset clears pins and mutations", () => {
  const w = createWorld({ seed: "rs" });
  const fresh = PROBES.map((p) => JSON.stringify(w.query(p)));
  script(w);
  assert.notDeepEqual(PROBES.map((p) => JSON.stringify(w.query(p))), fresh);
  w.reset();
  assert.deepEqual(PROBES.map((p) => JSON.stringify(w.query(p))), fresh);
  assert.deepEqual(w.export().log, []);
  // ids restart with the log position
  const a = createWorld({ seed: "rs" }).query(`mutation { createUser(input: {name: "q"}) { id } }`);
  assert.deepEqual(w.query(`mutation { createUser(input: {name: "q"}) { id } }`), a);
});

test("replay rejects a malformed log", () => {
  for (const log of [[1], [{ op: "nope", type: "U", key: "1" }], [{ op: "pin", type: "U", key: "1" }], [{ op: "delete", type: "U" }]]) {
    assert.throws(() => createWorld({ log }), (e) => e.code === "bad-options");
  }
  assert.throws(() => createWorld({ log: "x" }), (e) => e.code === "bad-options");
});

test("two worlds with the same inputs never influence each other", () => {
  const a = createWorld({ seed: "iso" });
  const b = createWorld({ seed: "iso" });
  a.query(`mutation { deleteUser(id: 1) { id } }`);
  assert.deepEqual(b.query(LIST), { data: graceholder(LIST, { seed: "iso" }) });
});

// ---- the core invariant ----------------------------------------------------------------

test("fields added or removed never change other values, with a mutated world", () => {
  const w = createWorld({ seed: "inv" });
  script(w);
  const narrow = w.query(`{ users { id name } user(id: 1) { email } }`).data;
  const wide = w.query(`{ users { phone createdAt id role name status } user(id: 1) { postCount email age } }`).data;
  assert.deepEqual(wide.users.map(({ id, name }) => ({ id, name })), narrow.users);
  assert.equal(wide.user.email, narrow.user.email);
});

test("a pin or mutation on one type leaves other types byte-identical", () => {
  const w = createWorld({ seed: "typ" });
  script(w);
  const q = `{ products { id name price } orders { id total } }`;
  assert.equal(JSON.stringify(w.query(q).data), JSON.stringify(graceholder(q, { seed: "typ" })));
});

// ---- operations ------------------------------------------------------------------------

test("mutations take variables, defaults, aliases, fragments and @skip/@include", () => {
  const w = createWorld();
  const r = w.query(
    `mutation Make($name: String = "Dflt", $skip: Boolean = false, $withEmail: Boolean!) {
       first: createUser(input: { name: $name }) { ...F email @include(if: $withEmail) }
       second: createUser(input: { name: "Second" }) @skip(if: $skip) { ...F }
       third: createUser(input: { name: "Third" }) @skip(if: true) { ...F }
       __typename
     }
     fragment F on User { id name }`,
    { variables: { withEmail: true } },
  );
  assert.equal(r.errors, undefined);
  assert.equal(r.data.first.name, "Dflt");
  assert.equal(typeof r.data.first.email, "string");
  assert.equal(r.data.second.name, "Second");
  assert.equal(r.data.third, undefined);
  assert.equal(r.data.__typename, "Mutation");
  assert.deepEqual(Object.keys(r.data), ["first", "second", "__typename"]);
});

test("mutation fields run in order and an error in one leaves the others", () => {
  const w = createWorld();
  const r = w.query(`mutation { a: createUser(input: { name: "A" }) { id } b: login(x: 1) { id } c: createUser(input: { name: "C" }) { name } }`);
  assert.equal(r.data.b, null);
  assert.equal(r.data.c.name, "C");
  assert.equal(r.errors.length, 1);
  assert.deepEqual(r.errors[0].path, ["b"]);
  assert.equal(w.export().log.length, 2);
});

test("operationName selects among several operations, mutations included", () => {
  const w = createWorld();
  const doc = `query Q { users { id } } mutation M { createUser(input: {name: "x"}) { name } }`;
  assert.equal(w.query(doc, { operationName: "M" }).data.createUser.name, "x");
  assert.ok(Array.isArray(w.query(doc, { operationName: "Q" }).data.users));
});

test("the mutation selection can reach nested data of the affected entity", () => {
  const w = createWorld();
  const r = w.query(`mutation { createUser(input: { name: "N" }) { id name posts { id title } } }`).data.createUser;
  const same = w.query(`{ user(id: ${r.id}) { posts { id title } } }`).data.user.posts;
  assert.deepEqual(r.posts, same);
});

// ---- mutation inference ----------------------------------------------------------------

test("classifyMutation: verbs and entity types from the field name", () => {
  const m = compileSpec({}).mutations;
  const c = (n, mm = m) => { const x = classifyMutation(n, mm); return `${x.op} ${x.type} ${x.read}`; };
  assert.equal(c("createUser"), "create User user");
  assert.equal(c("addBlogPost"), "create BlogPost blogPost");
  assert.equal(c("insertOrderItem"), "create OrderItem orderItem");
  assert.equal(c("updateUser"), "update User user");
  assert.equal(c("editPost"), "update Post post");
  assert.equal(c("setUserProfile"), "update UserProfile userProfile");
  assert.equal(c("deleteComment"), "delete Comment comment");
  assert.equal(c("removeCategory"), "delete Category category");
  assert.equal(c("deleteUsers"), "delete User user");
  assert.equal(c("create_user"), "create User user");
  assert.throws(() => c("login"), (e) => e.code === "bad-mutation" && /verbs/.test(e.hint));
  assert.throws(() => c("create"), (e) => e.code === "bad-mutation");
});

test("spec: extra verbs and per-field configuration", () => {
  const w = createWorld({
    spec: {
      $mutations: {
        verbs: { archive: "delete", rename: "update" },
        fields: { signUp: { op: "create", type: "User" }, closeAccount: { op: "delete", type: "User", idArg: "userId" }, saveProfile: { op: "update", type: "User", input: "profile", idArg: "uid" } },
      },
    },
  });
  const id = w.query(`mutation { signUp(input: { name: "S" }) { id name } }`).data.signUp.id;
  assert.equal(w.query(`{ user(id: ${id}) { name } }`).data.user.name, "S");
  assert.equal(w.query(`mutation { renameUser(id: ${id}, name: "R") { name } }`).data.renameUser.name, "R");
  assert.equal(w.query(`mutation { saveProfile(uid: ${id}, profile: { name: "P" }) { name } }`).data.saveProfile.name, "P");
  assert.equal(w.query(`mutation { closeAccount(userId: ${id}) { name } }`).data.closeAccount.name, "P");
  assert.equal(w.query(`{ user(id: ${id}) { name } }`).data.user, null);
  assert.equal(w.query(`mutation { archiveUser(id: 1) }`).data.archiveUser, true);
});

test("spec: a type that differs from its read field name, and the explicit input mode", () => {
  const w = createWorld({ spec: { "$mutations": { fields: { makePerson: { op: "create", type: "Person", input: "args" } } } } });
  const r = w.query(`mutation { makePerson(name: "Pat", input: "kept as a field") { id name input } }`);
  assert.equal(r.errors, undefined);
  assert.equal(r.data.makePerson.name, "Pat");
  assert.equal(r.data.makePerson.input, "kept as a field");
  assert.ok(w.query(`{ people { id } }`).data.people.some((p) => p.id === r.data.makePerson.id));
});

test("$mutations is validated", () => {
  const bad = [
    { $mutations: [] },
    { $mutations: { nope: 1 } },
    { $mutations: { verbs: { Bad: "create" } } },
    { $mutations: { verbs: { run: "explode" } } },
    { $mutations: { position: "middle" } },
    { $mutations: { relations: { Post: "User" } } },
    { $mutations: { fields: { x: { op: "create", wat: 1 } } } },
    { $mutations: { fields: { x: { op: "nope" } } } },
    { $mutations: { fields: { "a-b": { op: "create" } } } },
  ];
  for (const spec of bad) assert.throws(() => createWorld({ spec }), (e) => e instanceof GraceholderError && e.code === "bad-spec", JSON.stringify(spec));
  assert.doesNotThrow(() => graceholder(`{ users { id } }`, { spec: { $mutations: { position: "end" } } }));
});
