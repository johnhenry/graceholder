import { test } from "node:test";
import assert from "node:assert/strict";
import { graceholder, createWorld, inferSchema, GraceholderError, SCENARIOS } from "../src/index.js";
import { infer } from "../src/infer.js";
import { run } from "../src/execute.js";

const Q = "{ users { id name email age createdAt postCount posts { id title likes } address { city } } }";
const opts = { seed: "scen" };

/** every array in a value, with its path */
function arrays(value, path = [], out = []) {
  if (Array.isArray(value)) {
    out.push([path.join("."), value]);
    value.forEach((v, i) => arrays(v, [...path, "[]"], out));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) arrays(v, [...path, k], out);
  }
  return out;
}

test("no scenario, [] and 'none' are byte-identical to today", () => {
  const plain = JSON.stringify(graceholder(Q, opts));
  assert.equal(JSON.stringify(graceholder(Q, { ...opts, scenario: [] })), plain);
  assert.equal(JSON.stringify(graceholder(Q, { ...opts, scenario: "none" })), plain);
  assert.equal(JSON.stringify(graceholder(Q, { ...opts, scenario: undefined })), plain);
  assert.equal(inferSchema(Q, undefined, { scenario: [] }).sdl, inferSchema(Q).sdl);
});

test("unknown scenarios are rejected, in options and in the spec", () => {
  assert.throws(() => graceholder(Q, { scenario: "chaos" }), (e) => e instanceof GraceholderError && e.code === "bad-options");
  assert.throws(() => graceholder(Q, { scenario: ["empty", 3] }), (e) => e.code === "bad-options");
  assert.throws(() => graceholder(Q, { spec: { "users.posts": { scenario: "chaos" } } }), (e) => e.code === "bad-spec");
  assert.throws(() => graceholder(Q, { scenarioOptions: { errorRate: 2 } }), (e) => e.code === "bad-options");
  assert.deepEqual(SCENARIOS, ["empty", "huge", "nulls", "unicode", "boundary", "errors"]);
});

test("every scenario is deterministic, in any order of combination", () => {
  for (const s of SCENARIOS) {
    const a = JSON.stringify(graceholder(Q, { ...opts, scenario: s, errors: "result" }));
    assert.equal(JSON.stringify(graceholder(Q, { ...opts, scenario: s, errors: "result" })), a, s);
  }
  const ab = graceholder(Q, { ...opts, scenario: ["unicode", "boundary"] });
  const ba = graceholder(Q, { ...opts, scenario: ["boundary", "unicode", "unicode"] });
  assert.deepEqual(ab, ba);
});

test("empty: every list is empty, and counts, connections and order totals agree", () => {
  const data = graceholder(Q, { ...opts, scenario: "empty" });
  assert.deepEqual(data, { users: [] });
  const nested = graceholder("{ user(id: 1) { id postCount posts { id } tags } }", { ...opts, scenario: "empty", spec: { "user.tags": { list: true } } });
  assert.equal(nested.user.id, "1");
  assert.equal(nested.user.postCount, 0);
  assert.deepEqual(nested.user.posts, []);
  assert.deepEqual(nested.user.tags, []);
  const conn = graceholder("{ posts(first: 5) { totalCount pageInfo { hasNextPage hasPreviousPage startCursor endCursor } edges { cursor node { id } } } }", { ...opts, scenario: "empty" });
  assert.deepEqual(conn.posts, { totalCount: 0, pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, edges: [] });
  const order = graceholder("{ order(id: 1) { id subtotal items { price } } }", { ...opts, scenario: "empty" });
  assert.equal(order.order.subtotal, 0);
  assert.deepEqual(order.order.items, []);
});

test("empty, scoped: only the named list is empty and the rest is unchanged", () => {
  const base = graceholder(Q, opts);
  const scoped = graceholder(Q, { ...opts, spec: { "users.posts": { scenario: "empty" } } });
  assert.equal(scoped.users.length, base.users.length);
  scoped.users.forEach((u, i) => {
    assert.deepEqual(u.posts, []);
    // postCount counts the (now empty) posts, so it agrees with them
    assert.equal(u.postCount, 0);
    const { posts: _p, postCount: _c, ...rest } = u;
    const { posts: _q, postCount: _d, ...baseRest } = base.users[i];
    assert.deepEqual(rest, baseRest);
  });
  // the scope does not reach the other lists
  assert.ok(base.users.length > 0);
});

test("scenario in the spec replaces the global one for that field; 'none' opts out", () => {
  const data = graceholder(Q, { ...opts, scenario: "empty", spec: { users: { scenario: "none" }, "users.posts": { scenario: "empty" } } });
  assert.deepEqual(data, graceholder(Q, { ...opts, spec: { "users.posts": { scenario: "empty" } } }));
  const sub = graceholder(Q, { ...opts, spec: { "users.**": { scenario: "boundary" } } });
  assert.ok(sub.users.every((u) => u.createdAt === "1970-01-01T00:00:00.000Z" || ["2038-01-19T03:14:07.000Z", "9999-12-31T23:59:59.999Z", "0001-01-01T00:00:00.000Z"].includes(u.createdAt)));
});

test("huge: lists are large (smaller when nested), connections have a huge total", () => {
  const data = graceholder("{ users { id posts { id } } }", { ...opts, scenario: "huge" });
  assert.equal(data.users.length, 100);
  assert.ok(data.users.every((u) => u.posts.length === 15));
  const conn = graceholder("{ posts(first: 2) { totalCount edges { node { id } } pageInfo { hasNextPage } } }", { ...opts, scenario: "huge" });
  assert.equal(conn.posts.totalCount, 100000);
  assert.equal(conn.posts.edges.length, 2);
  assert.equal(conn.posts.pageInfo.hasNextPage, true);
  // declared counts yield to huge
  assert.equal(graceholder("{ users { id } }", { ...opts, scenario: "huge", spec: { users: { count: 2 } } }).users.length, 100);
  // counts agree with the list they count
  const c = graceholder("{ user(id: 1) { postCount posts { id } } }", { ...opts, scenario: "huge" });
  assert.equal(c.user.postCount, c.user.posts.length);
});

test("nulls: every nullable field is null except ids and the operation root", () => {
  const { sdl } = inferSchema(Q, undefined, { scenario: "nulls" });
  assert.match(sdl, /users: \[User!\]!/);
  assert.match(sdl, /id: ID!/);
  assert.match(sdl, /name: String\n/);
  assert.match(sdl, /posts: \[Post!\]\n/);
  const data = graceholder(Q, { ...opts, scenario: "nulls" });
  assert.ok(data.users.length > 0);
  for (const u of data.users) {
    assert.equal(typeof u.id, "string");
    for (const k of Object.keys(u)) if (k !== "id") assert.equal(u[k], null, k);
  }
  // a nested level
  const nested = graceholder("{ user(id: 3) { id posts { id title } } }", { ...opts, scenario: "nulls", spec: { "user.posts": { scenario: "none" }, "user.posts.*": { scenario: "none" } } });
  assert.ok(nested.user.posts.every((p) => typeof p.id === "string" && typeof p.title === "string"));
});

test("nulls, scoped: only the named field is null", () => {
  const base = graceholder(Q, opts);
  const data = graceholder(Q, { ...opts, spec: { "users.address": { scenario: "nulls" } } });
  data.users.forEach((u, i) => {
    assert.equal(u.address, null);
    assert.deepEqual({ ...u, address: 0 }, { ...base.users[i], address: 0 });
  });
});

test("nulls honour nullRate-style nullability that is already in the SDL", () => {
  const data = graceholder("{ users { id deletedAt } }", { ...opts, scenario: "nulls" });
  assert.ok(data.users.every((u) => u.deletedAt === null));
});

test("unicode: text fields become edge-case strings, ids, numbers and dates stay", () => {
  const base = graceholder(Q, opts);
  const data = graceholder(Q, { ...opts, scenario: "unicode" });
  data.users.forEach((u, i) => {
    assert.equal(u.id, base.users[i].id);
    assert.equal(u.age, base.users[i].age);
    assert.equal(u.createdAt, base.users[i].createdAt);
    assert.equal(u.email, base.users[i].email);
  });
  const all = data.users.flatMap((u) => [u.name, ...u.posts.map((p) => p.title)]);
  assert.ok(all.some((s) => /[֐-ۿ]/.test(s)), "right-to-left text");
  assert.ok(all.some((s) => /\p{Extended_Pictographic}/u.test(s)), "emoji");
  assert.ok(all.some((s) => /[̀-ͯ]/.test(s)), "combining marks");
  const long = graceholder("{ users(first: 40) { name } }", { ...opts, scenario: "unicode" }).users.map((u) => u.name);
  assert.ok(long.some((s) => s.length > 2000), "a very long string");
});

test("boundary: numbers at their limits, dates at epoch and far future", () => {
  const data = graceholder(Q, { ...opts, scenario: "boundary" });
  const dates = new Set(["1970-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z", "0001-01-01T00:00:00.000Z", "2038-01-19T03:14:07.000Z"]);
  const ints = new Set([0, 1, -1, 2147483647, -2147483648]);
  for (const u of data.users) {
    assert.ok(dates.has(u.createdAt), u.createdAt);
    assert.ok(ints.has(u.age), String(u.age));
    assert.equal(typeof u.id, "string");
    for (const p of u.posts) assert.ok(ints.has(p.likes));
  }
  const seen = new Set(graceholder("{ users(first: 60) { age createdAt } }", { ...opts, scenario: "boundary" }).users.flatMap((u) => [u.age, u.createdAt]));
  assert.ok(seen.has(2147483647) && seen.has(-2147483648) && seen.has("1970-01-01T00:00:00.000Z") && seen.has("9999-12-31T23:59:59.999Z"));
  const floats = new Set(graceholder("{ products(first: 40) { price } }", { ...opts, scenario: "boundary" }).products.map((p) => p.price));
  assert.ok([...floats].every((x) => Number.isFinite(x)));
});

test("errors: partial data with paths, deterministic from the key", () => {
  const res = graceholder(Q, { ...opts, scenario: "errors", errors: "result" });
  assert.ok(res.errors.length > 0);
  for (const e of res.errors) {
    assert.equal(typeof e.message, "string");
    assert.ok(Array.isArray(e.path) && e.path.length >= 2);
    assert.ok(e.locations?.length);
    assert.equal(e.extensions.scenario, "errors");
    assert.ok(["INTERNAL_SERVER_ERROR", "SERVICE_UNAVAILABLE", "FORBIDDEN", "TIMEOUT"].includes(e.extensions.code));
    // the value at the error's path is null in the data
    let at = res.data;
    for (const k of e.path) at = at?.[k];
    assert.equal(at, null, e.path.join("."));
  }
  const again = graceholder(Q, { ...opts, scenario: "errors", errors: "result" });
  assert.equal(JSON.stringify(again), JSON.stringify(res));
  const base = graceholder(Q, opts);
  // wherever there is no error, the value is the unchanged one
  res.data.users.forEach((u, i) => {
    for (const [k, v] of Object.entries(u)) if (v !== null && k !== "posts" && k !== "address") assert.deepEqual(v, base.users[i][k], k);
  });
});

test("errors: which fields fail does not depend on the other selected fields", () => {
  const small = graceholder("{ users { id name } }", { ...opts, scenario: "errors", errors: "result" });
  const big = graceholder("{ users { id email name age posts { id } } }", { ...opts, scenario: "errors", errors: "result" });
  const failing = (r) => new Set(r.errors.filter((e) => e.path.at(-1) === "name").map((e) => e.path.join(".")));
  assert.ok(failing(small).size > 0);
  assert.deepEqual([...failing(small)].sort(), [...failing(big)].sort());
});

test("errors: scenarioOptions.errorRate 0 fails nothing, 1 fails every eligible field", () => {
  const none = graceholder("{ users { id name } }", { ...opts, scenario: "errors", scenarioOptions: { errorRate: 0 }, errors: "result" });
  assert.equal(none.errors, undefined);
  assert.deepEqual(none.data, graceholder("{ users { id name } }", opts));
  const all = graceholder("{ users { id name } }", { ...opts, scenario: "errors", scenarioOptions: { errorRate: 1 }, errors: "result" });
  assert.equal(all.data.users, null === all.data.users ? null : all.data.users);
  assert.ok(all.errors.length >= 1);
  assert.ok(all.errors.every((e) => e.path.at(-1) === "users" || e.path.at(-1) === "name"));
});

test("errors: result mode returns { data, errors }; throw mode throws with the partial data", () => {
  const o = { ...opts, scenario: "errors", scenarioOptions: { errorRate: 0.5 } };
  const res = graceholder(Q, { ...o, errors: "result" });
  assert.ok(res.data && res.errors.length);
  assert.throws(
    () => graceholder(Q, o),
    (e) => {
      assert.ok(e instanceof GraceholderError);
      assert.equal(e.code, "graphql");
      assert.deepEqual(e.errors, res.errors);
      assert.deepEqual(e.data, res.data);
      return true;
    },
  );
  // genuine failures (bad arguments) are untouched by the scenario
  assert.throws(() => graceholder("{ posts(first: 1, last: 1) { id } }", { ...o, scenarioOptions: { errorRate: 0 } }), (e) => e.code === "bad-arguments");
  assert.equal(graceholder("{ users { id } }", { ...opts, scenario: "errors", scenarioOptions: { errorRate: 0 } }).users.length > 0, true);
});

test("errors follow GraphQL null propagation when the schema says a field is non-null", () => {
  const query = "{ users { id name } }";
  const inferred = infer(query, { scenario: ["errors"] });
  // as a schema would have it: name is non-null and users is nullable
  const sdl = inferred.sdl.replace("name: String\n", "name: String!\n").replace("users: [User!]!", "users: [User!]");
  assert.notEqual(sdl, inferred.sdl);
  const result = run({ ...inferred, sdl }, { seed: "scen", anchorMs: 0, errorRate: 1 });
  assert.equal(result.data.users, null);
  assert.ok(result.errors.length >= 1);
  assert.ok(result.errors.every((e) => e.path[0] === "users"));
  // with a nullable list item type, only the user is dropped
  const kept = infer(query, { scenario: ["errors"], spec: { users: { scenario: "none" } } });
  const sdl2 = kept.sdl.replace("name: String\n", "name: String!\n").replace("users: [User!]!", "users: [User]!");
  const r2 = run({ ...kept, sdl: sdl2 }, { seed: "scen", anchorMs: 0, errorRate: 0.5 });
  assert.ok(Array.isArray(r2.data.users));
  assert.ok(r2.data.users.some((u) => u === null));
  for (const e of r2.errors) assert.equal(r2.data.users[e.path[1]], null);
});

test("scenarios combine: nulls and unicode, empty with errors", () => {
  const data = graceholder(Q, { ...opts, scenario: ["unicode", "nulls"], spec: { "users.name": { scenario: "unicode" } } });
  assert.ok(data.users.every((u) => typeof u.name === "string" && u.email === null && u.age === null));
  const res = graceholder(Q, { ...opts, scenario: ["empty", "errors"], scenarioOptions: { errorRate: 1 }, errors: "result" });
  assert.ok(res.errors.length > 0);
});

test("scenarios keep the core invariant: extra or reordered fields never change another value", () => {
  for (const s of ["empty", "huge", "nulls", "unicode", "boundary"]) {
    const a = graceholder("{ users { name email } }", { ...opts, scenario: s });
    const b = graceholder("{ users { email other: name extra age } }", { ...opts, scenario: s });
    a.users.forEach((u, i) => {
      assert.deepEqual(u.name, b.users[i].other, s);
      assert.deepEqual(u.email, b.users[i].email, s);
    });
  }
});

test("a world takes the scenario option, runs every query under it, and exports it", () => {
  const world = createWorld({ seed: "scen", scenario: ["unicode"] });
  assert.deepEqual(world.query(Q).data, graceholder(Q, { ...opts, scenario: "unicode" }));
  const exported = world.export();
  assert.deepEqual(exported.scenario, ["unicode"]);
  assert.deepEqual(createWorld(exported).query(Q).data, world.query(Q).data);
  assert.throws(() => createWorld({ scenario: "nope" }), (e) => e.code === "bad-options");
  const errs = createWorld({ seed: "scen", scenario: "errors", scenarioOptions: { errorRate: 0.5 } }).query(Q);
  assert.ok(errs.data && errs.errors.length > 0);
  assert.equal(errs.errors[0].extensions.scenario, "errors");
  // a plain world is exported without any scenario key
  assert.equal("scenario" in createWorld({ seed: "x" }).export(), false);
});

test("a world's pinned values win over unicode and boundary, and scenarios work with a spec path", () => {
  const world = createWorld({ seed: "scen", scenario: ["unicode"] });
  world.pin("User:1", { name: "Pinned Name" });
  assert.equal(world.query("{ user(id: 1) { name } }").data.user.name, "Pinned Name");
});

const SCHEMA = `
  type Query { users: [User!]! user(id: ID!): User }
  type User { id: ID! name: String! nickname: String bio: String age: Int posts: [Post!]! tags: [String!] }
  type Post { id: ID! title: String! }
`;

test("schema mode: nulls nulls exactly the nullable fields, errors propagate through non-null ones", () => {
  const q = "{ users { id name nickname bio age tags posts { id title } } }";
  const data = graceholder(q, { ...opts, schema: SCHEMA, scenario: "nulls" });
  assert.ok(data.users.length > 0);
  for (const u of data.users) {
    assert.equal(typeof u.id, "string");
    assert.equal(typeof u.name, "string"); // non-null in the schema
    assert.ok(Array.isArray(u.posts) && u.posts.every((p) => typeof p.title === "string"));
    assert.equal(u.nickname, null);
    assert.equal(u.bio, null);
    assert.equal(u.age, null);
    assert.equal(u.tags, null);
  }
  assert.equal(inferSchema(q, undefined, { schema: SCHEMA, scenario: "nulls" }).sdl, inferSchema(q, undefined, { schema: SCHEMA }).sdl);
  // errors: User.name is non-null, so its failure drops the user, whose slot in [User!]! is non-null, so users fails; users is non-null, so data is null
  const res = graceholder(q, { ...opts, schema: SCHEMA, scenario: "errors", scenarioOptions: { errorRate: 1 }, errors: "result" });
  assert.equal(res.data, null);
  assert.ok(res.errors.length >= 1 && res.errors[0].path[0] === "users");
  const none = graceholder(q, { ...opts, schema: SCHEMA, scenario: "errors", scenarioOptions: { errorRate: 0 }, errors: "result" });
  assert.equal(none.errors, undefined);
  assert.deepEqual(none.data, graceholder(q, { ...opts, schema: SCHEMA }));
});
