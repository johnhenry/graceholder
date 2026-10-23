import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSchema, introspectionFromSchema } from "graphql";
import { graceholder, inferSchema } from "../src/index.js";

const SDL = `
scalar DateTime
scalar Date
scalar URL
scalar Email
scalar UUID
scalar BigInt
scalar JSON
scalar Mystery
enum Role { ADMIN EDITOR VIEWER }
enum Plan { FREE PRO }
interface Node { id: ID! }
interface Animal { name: String! legs: Int! }
type Dog implements Animal { name: String! legs: Int! barks: Boolean! }
type Cat implements Animal { name: String! legs: Int! lives: Int! }
type Bird implements Animal { name: String! legs: Int! }
type User implements Node {
  id: ID!
  name: String!
  role: Role!
  plan: Plan
  tags: [String!]!
  avatar: URL
  homepage: URL!
  contact: Email!
  uid: UUID!
  born: Date!
  createdAt: DateTime!
  deletedAt: DateTime
  bigNumber: BigInt!
  blob: JSON
  mystery: Mystery!
  nickname: String
  age: Int!
  score: Float
  settings: Settings!
  pets: [Animal!]!
  friends: [User!]!
  posts(first: Int = 4, after: String): PostConnection!
}
type Settings { theme: String! notifications: Boolean! }
type Post implements Node { id: ID! title: String! author: User! status: Role! }
union SearchResult = User | Post
type PageInfo { hasNextPage: Boolean! hasPreviousPage: Boolean! startCursor: String endCursor: String }
type PostEdge { cursor: String! node: Post! }
type PostConnection { edges: [PostEdge!]! pageInfo: PageInfo! totalCount: Int! }
type Query {
  user(id: ID!): User!
  users(first: Int = 3, role: Role): [User!]!
  node(id: ID!): Node
  search(q: String!): [SearchResult!]!
  animals: [Animal!]!
  posts(first: Int, after: String): PostConnection!
}
`;

const run = (q, o = {}) => graceholder(q, { seed: "s", schema: SDL, ...o });
const err = (fn) => { try { fn(); } catch (e) { return e; } return null; };
const json = JSON.stringify;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test("enums come from the schema: only declared values appear, and all of them eventually do", () => {
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const out = run("{ users(first: 10) { role plan } }", { seed: `e${i}` });
    for (const u of out.users) {
      assert.ok(["ADMIN", "EDITOR", "VIEWER"].includes(u.role), u.role);
      assert.ok(["FREE", "PRO"].includes(u.plan), u.plan);
      seen.add(u.role);
    }
  }
  assert.deepEqual([...seen].sort(), ["ADMIN", "EDITOR", "VIEWER"]);
});

test("lists, objects and nullability follow the schema, not the field name", () => {
  const out = run("{ user(id: 1) { tags pets { name } settings { theme notifications } friends { id } nickname score deletedAt } }");
  assert.ok(Array.isArray(out.user.tags) && out.user.tags.every((t) => typeof t === "string"));
  assert.ok(Array.isArray(out.user.pets));
  assert.ok(!Array.isArray(out.user.settings), "`settings` is plural-looking but the schema says one object");
  assert.equal(typeof out.user.settings.notifications, "boolean");
  assert.ok(Array.isArray(out.user.friends));
  // nullable fields are not nulled by default (non-null mock data), non-null fields never are
  assert.equal(typeof out.user.nickname, "string");
  assert.equal(typeof out.user.score, "number");
  assert.equal(out.user.deletedAt, null); // nullable, and `deletedAt` is null by default (T10), as without a schema
});

test("a nullable date that the heuristic leaves null stays valid, and a non-null one is never null", () => {
  const out = run("{ users(first: 5) { deletedAt createdAt } }");
  for (const u of out.users) assert.match(u.createdAt, ISO);
  const out2 = graceholder("{ u { deletedAt } }", { schema: "scalar DateTime type Query { u: U! } type U { deletedAt: DateTime! }" });
  assert.match(out2.u.deletedAt, ISO);
});

test("custom scalars are mapped by their name", () => {
  const out = run("{ user(id: 3) { avatar homepage contact uid born createdAt bigNumber blob mystery } }");
  const u = out.user;
  assert.match(u.homepage, /^https:\/\//);
  assert.match(u.avatar, /^https:\/\//);
  assert.match(u.contact, /^[^@\s]+@[^@\s]+$/);
  assert.match(u.uid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(u.born, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(u.createdAt, ISO);
  assert.ok(Number.isInteger(u.bigNumber));
  assert.equal(typeof u.blob, "string");
  assert.equal(typeof u.mystery, "string"); // unknown scalar: the field name decides (T13)
});

test("built-in scalars keep the name heuristics when the type fits, and fall back when it does not", () => {
  const out = run("{ user(id: 2) { name age score id } }");
  assert.match(out.user.name, /\S+ \S+/); // person.full, as without a schema
  assert.ok(out.user.age >= 18 && out.user.age <= 90);
  assert.equal(out.user.id, "2");
  // `status: Role!` on Post is an enum, the "status" vocabulary is not used
  const posts = run("{ posts(first: 3) { edges { node { status title } } } }");
  for (const e of posts.posts.edges) assert.ok(["ADMIN", "EDITOR", "VIEWER"].includes(e.node.status));
  // `age: String` has an Int heuristic, which does not fit String
  const odd = graceholder("{ p { age } }", { schema: "type Query { p: P! } type P { age: String! }" });
  assert.equal(typeof odd.p.age, "string");
});

test("the same entity is the same everywhere: pools are keyed by the schema's type names", () => {
  const out = run("{ user(id: 5) { id name } users(first: 5) { id name } }");
  assert.deepEqual(out.users[4], out.user);
  const viaPost = run("{ posts(first: 2) { edges { node { author { id name } } } } }");
  assert.ok(viaPost.posts.edges.every((e) => /^\d+$/.test(e.node.author.id)));
});

test("arguments (with the schema's defaults) drive identity and paging", () => {
  assert.equal(run("{ users { id } }").users.length, 3); // first: Int = 3
  assert.equal(run("{ users(first: 2) { id } }").users.length, 2);
  const page = run("{ user(id: 1) { posts { edges { cursor node { id } } pageInfo { hasNextPage endCursor } totalCount } } }").user.posts;
  assert.equal(page.edges.length, 4); // first: Int = 4
  assert.equal(page.totalCount, 1000);
  assert.equal(page.pageInfo.hasNextPage, true);
  const next = run(`{ user(id: 1) { posts(after: "${page.pageInfo.endCursor}") { edges { node { id } } } } }`).user.posts;
  const eight = run("{ user(id: 1) { posts(first: 8) { edges { node { id } } } } }").user.posts.edges.map((e) => e.node.id);
  assert.deepEqual(next.edges.map((e) => e.node.id), eight.slice(4));
  // role filter is a different collection
  assert.notDeepEqual(run("{ users(role: ADMIN) { id name } }").users, run("{ users(role: EDITOR) { id name } }").users);
});

test("Relay connections are recognised from the schema's types", () => {
  const out = run("{ posts(first: 2) { totalCount pageInfo { hasNextPage } edges { cursor node { id title } } } }");
  assert.equal(out.posts.edges.length, 2);
  assert.equal(out.posts.pageInfo.hasNextPage, true);
  assert.equal(typeof out.posts.edges[0].cursor, "string");
  const d = inferSchema("{ posts(first: 2) { edges { node { id } } } }", undefined, { schema: SDL }).decisions;
  assert.ok(d.some((x) => x.kind === "type" && x.rule === "S3" && x.source === "schema"));
});

test("interfaces and unions: types come from the schema, fragments select per type", () => {
  const out = run("{ animals { __typename name legs ... on Dog { barks } ... on Cat { lives } } }", { seed: "a" });
  const names = new Set(out.animals.map((a) => a.__typename));
  assert.ok([...names].every((n) => ["Dog", "Cat", "Bird"].includes(n)));
  for (const a of out.animals) {
    assert.equal(typeof a.legs, "number");
    assert.equal("barks" in a, a.__typename === "Dog");
    assert.equal("lives" in a, a.__typename === "Cat");
  }
  // an interface offers every implementing type, even those the query does not mention (Bird)
  const all = new Set();
  for (let i = 0; i < 30; i++) for (const a of run("{ animals { __typename name } }", { seed: `i${i}` }).animals) all.add(a.__typename);
  assert.deepEqual([...all].sort(), ["Bird", "Cat", "Dog"]);
  // a union offers the members the query asks about
  const members = new Set();
  for (let i = 0; i < 20; i++) {
    for (const r of run("{ search(q: \"x\") { __typename ... on User { name } } }", { seed: `u${i}` }).search) members.add(r.__typename);
  }
  assert.deepEqual([...members], ["User"]);
  const both = run("{ search(q: \"x\") { ... on User { id } ... on Post { title } } }", { seed: "b" }).search;
  assert.ok(both.some((r) => "id" in r) && both.some((r) => "title" in r));
  assert.ok(run("{ node(id: 7) { __typename id } }").node.id === "7");
});

test("validation errors from the schema surface as graphql errors", () => {
  const unknown = err(() => run("{ user(id: 1) { nope } }"));
  assert.equal(unknown.code, "graphql");
  assert.match(unknown.message, /Cannot query field "nope" on type "User"/);
  assert.equal(err(() => run("{ user { id } }")).code, "graphql"); // missing required argument
  assert.equal(err(() => run("{ users(role: NOPE) { id } }")).code, "graphql"); // not an enum value
  assert.equal(err(() => run("{ users(first: \"x\") { id } }")).code, "graphql");
  assert.equal(err(() => run("{ animals { barks } }")).code, "graphql"); // not on the interface
  const result = graceholder("{ user(id: 1) { nope } }", { schema: SDL, errors: "result" });
  assert.equal(result.errors.length, 1);
  assert.equal(result.data, undefined);
});

test("directives and spec entries that agree with the schema are fine", () => {
  const out = run('{ user(id: 1) { tags @count(n: 2) @pattern(p: "t-##") age @gen(name: "int", min: 5, max: 6) nickname @nullRate(p: 1) role @pick(values: ["ADMIN"]) friends @type(name: "User") @count(min: 1, max: 1) { id } } }');
  assert.equal(out.user.tags.length, 2);
  assert.ok(out.user.tags.every((t) => /^t-\d\d$/.test(t)));
  assert.ok([5, 6].includes(out.user.age));
  assert.equal(out.user.nickname, null);
  assert.equal(out.user.role, "ADMIN");
  assert.equal(out.user.friends.length, 1);
  const viaSpec = run("{ user(id: 1) { tags age nickname role friends { id } } }", {
    spec: { "user.tags": { count: 2, pattern: "t-##" }, "user.age": { gen: { name: "int", args: { min: 5, max: 6 } } }, "user.nickname": { nullRate: 1 }, "user.role": { pick: ["ADMIN"] }, "user.friends": { type: "User", count: 1 } },
  });
  assert.equal(json(viaSpec), json(out));
});

test("a schema conflict is an error: type, shape, nullability, enum values and generator types", () => {
  const code = (q, o) => err(() => run(q, o))?.code;
  assert.equal(code('{ user(id: 1) { friends @type(name: "Post") { id } } }'), "schema-conflict");
  assert.equal(code("{ user(id: 1) { friends @one { id } } }"), "schema-conflict");
  assert.equal(code("{ user(id: 1) { settings @list { theme } } }"), "schema-conflict");
  assert.equal(code("{ user(id: 1) { name @nullRate(p: 0.5) } }"), "schema-conflict"); // String!
  assert.equal(code('{ user(id: 1) { role @pick(values: ["ADMIN", "ROOT"]) } }'), "schema-conflict");
  assert.equal(code('{ user(id: 1) { role @gen(name: "int") } }'), "schema-conflict");
  assert.equal(code('{ user(id: 1) { name @gen(name: "int") } }'), "schema-conflict");
  assert.equal(code('{ user(id: 1) { age @gen(name: "word") } }'), "schema-conflict");
  assert.equal(code('{ user(id: 1) { age @gen(name: "float") } }'), "schema-conflict");
  assert.equal(code("{ users { id } }", { spec: { "users.name": { gen: "bool" } } }), undefined); // unused path, not selected
  assert.equal(code("{ users { name } }", { spec: { "users.name": { gen: "bool" } } }), "schema-conflict");
  assert.equal(code("{ users { id } }", { spec: { users: { one: true } } }), "schema-conflict");
  assert.equal(code("{ users { id } }", { spec: { users: { type: "Post" } } }), "schema-conflict");
  assert.equal(code("{ user(id: 1) { deletedAt @gen(name: \"time.deleted\") } }"), undefined); // nullable: fine
});

test("a non-null date with a time.deleted generator conflicts; with a nullRate argument it is fine", () => {
  const schema = "scalar DateTime type Query { u: U! } type U { d: DateTime! }";
  assert.equal(err(() => graceholder("{ u { d } }", { schema, spec: { "u.d": { gen: "time.deleted" } } }))?.code, "schema-conflict");
  const ok = graceholder("{ u { d } }", { schema, spec: { "u.d": { gen: { name: "time.deleted", args: { nullRate: 0 } } } } });
  assert.match(ok.u.d, ISO);
});

test("inferSchema reports the schema-sourced decisions", () => {
  const { sdl, decisions } = inferSchema("{ user(id: 1) { role tags settings { theme } nickname } }", { "user.role": { pick: ["ADMIN"] } }, { schema: SDL });
  assert.match(sdl, /enum Role/);
  const at = (path, kind) => decisions.filter((d) => d.path === path && d.kind === kind);
  assert.deepEqual(at("user.tags", "list").map((d) => [d.value, d.source]), [[true, "schema"]]);
  assert.deepEqual(at("user.settings", "list").map((d) => [d.value, d.source]), [[false, "schema"]]);
  assert.deepEqual(at("user.settings", "type").map((d) => [d.value, d.source]), [["Settings", "schema"]]);
  assert.deepEqual(at("user.nickname", "nullable").map((d) => [d.value, d.source]), [[true, "schema"]]);
  assert.deepEqual(at("user.tags", "nullable").map((d) => d.value), [false]);
  assert.deepEqual(at("user.role", "scalar").map((d) => [d.value, d.source]), [["Role", "spec"]]);
  assert.equal(at("user.nickname", "scalar")[0].value, "String");
  assert.equal(at("user.nickname", "scalar")[0].source, "schema");
  assert.ok(decisions.some((d) => d.kind === "arg" && d.value === "id: ID!" && d.source === "schema"));
});

test("SDL, introspection and graphql-js schemas give identical output", () => {
  const q = "{ user(id: 9) { name role tags createdAt friends { id } posts(first: 2) { edges { node { title } } } } animals { __typename name } }";
  const built = buildSchema(SDL);
  const intro = introspectionFromSchema(built);
  const base = json(run(q));
  assert.equal(json(run(q, { schema: intro })), base);
  assert.equal(json(run(q, { schema: { data: intro } })), base);
  assert.equal(json(run(q, { schema: built })), base);
});

test("schema mode keeps the core invariant: other values never change", () => {
  const full = run("{ user(id: 4) { id name role tags age friends { id name } } }").user;
  const some = run("{ user(id: 4) { age friends { name } extra: name } }").user;
  assert.equal(some.age, full.age);
  assert.deepEqual(some.friends.map((f) => f.name), full.friends.map((f) => f.name));
  assert.equal(some.extra, full.name);
  assert.equal(json(run("{ user(id: 4) { name } }")), json(run("{ user(id: 4) { name } }")));
});

test("a bad schema is reported as bad-schema", () => {
  assert.equal(err(() => graceholder("{ a }", { schema: "type Query { a: Nope }" }))?.code, "bad-schema");
  assert.equal(err(() => graceholder("{ a }", { schema: "type Foo { a: Int }" }))?.code, "bad-schema");
  assert.equal(err(() => graceholder("{ a }", { schema: "not sdl at all {" }))?.code, "bad-schema");
  assert.equal(err(() => graceholder("{ a }", { schema: 42 }))?.code, "bad-schema");
  assert.equal(err(() => graceholder("{ a }", { schema: { nope: 1 } }))?.code, "bad-schema");
});

test("a root type with another name works", () => {
  const out = graceholder("{ hello(id: 3) { id title } }", { schema: "schema { query: Root } type Root { hello(id: ID!): Hello! } type Hello { id: ID! title: String! }" });
  assert.equal(out.hello.id, "3");
  assert.equal(typeof out.hello.title, "string");
});

test("without a schema nothing changes: the inferred path ignores all of this", () => {
  const q = "{ users { id name role status } }";
  assert.equal(json(graceholder(q, { seed: "z" })), json(graceholder(q, { seed: "z", schema: undefined })));
  assert.equal(json(inferSchema(q).decisions.map((d) => d.source).filter((s) => s === "schema")), "[]");
});

test("a world accepts a schema: queries run in schema mode and stay consistent with graceholder()", async () => {
  const { createWorld } = await import("../src/index.js");
  const world = createWorld({ seed: "w", schema: SDL });
  const q = "{ user(id: 3) { id role tags settings { theme } } }";
  const a = world.query(q);
  assert.equal(json(a.data), json(graceholder(q, { seed: "w", schema: SDL })));
  assert.ok(["ADMIN", "EDITOR", "VIEWER"].includes(a.data.user.role));
  world.pin("User:3", { name: "Pinned Person" });
  assert.equal(world.query("{ user(id: 3) { name } }").data.user.name, "Pinned Person");
  const bad = world.query("{ user(id: 3) { nope } }");
  assert.ok(bad.errors?.length);
});
