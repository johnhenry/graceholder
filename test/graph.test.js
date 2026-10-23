import { test } from "node:test";
import assert from "node:assert/strict";
import { graceholder, inferSchema } from "../src/index.js";
import { encodeCursor, decodeCursor } from "../src/cursor.js";

const run = (q, o) => graceholder(q, { seed: "g", ...o });
const json = (v) => JSON.stringify(v);
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

// ---- identity -----------------------------------------------------------------

test("user(id: 5) is identical wherever it appears and across aliases", () => {
  const out = run("{ a: user(id: 5) { id name email createdAt } b: user(id: 5) { email name id createdAt } c: user(id: 6) { id name email createdAt } }");
  assert.equal(out.a.id, "5");
  assert.equal(json(out.a), json({ id: out.b.id, name: out.b.name, email: out.b.email, createdAt: out.b.createdAt }));
  assert.equal(out.c.id, "6");
  assert.notEqual(out.a.name, out.c.name);
  // the same through a different parent
  const nested = run("{ team { lead: user(id: 5) { name email } } user(id: 5) { name email } }");
  assert.equal(json(nested.team.lead), json(nested.user));
  // string ids are keys too, and 5 and "5" are the same entity
  assert.equal(run("{ user(id: \"5\") { name } }").user.name, run("{ user(id: 5) { name } }").user.name);
});

test("user(id: 5) is the fifth member of the shared users pool", () => {
  let checked = 0;
  for (let i = 0; i < 40 && checked < 5; i++) {
    const out = graceholder("{ users { id name email } user(id: 5) { id name email } }", { seed: `p${i}` });
    if (out.users.length >= 5) {
      assert.equal(json(out.users[4]), json(out.user));
      checked++;
    }
  }
  assert.ok(checked >= 5);
});

test("references resolve into the same pool as lists of the same type name", () => {
  // `author` is typed User by its type condition (N2), so it shares the User pool with `users`
  let matched = 0;
  for (let i = 0; i < 80; i++) {
    const out = graceholder("{ posts { author { ... on User { id name email } } } users { id name email } }", { seed: `r${i}` });
    for (const p of out.posts) {
      const u = out.users.find((x) => x.id === p.author.id);
      if (u) {
        assert.equal(json(u), json(p.author));
        matched++;
      }
      assert.ok(Number(p.author.id) >= 1 && Number(p.author.id) <= 100);
    }
  }
  assert.ok(matched > 0, "expected at least one author to land in the listed users");
});

test("same type name, same key, same entity (singular fields)", () => {
  // two different fields typed Author share the Author pool
  let found = false;
  for (let i = 0; i < 200 && !found; i++) {
    const out = graceholder("{ posts { author { id name } } comments { author { id name } } }", { seed: `s${i}` });
    for (const p of out.posts) for (const c of out.comments) if (p.author.id === c.author.id) {
      assert.equal(json(p.author), json(c.author));
      found = true;
    }
  }
  assert.ok(found);
});

test("different arguments give different entities and different collections", () => {
  const out = run("{ one: user(id: 1) { name } two: user(id: 2) { name } open: tickets(status: \"OPEN\") { id title } closed: tickets(status: \"CLOSED\") { id title } }");
  assert.notEqual(out.one.name, out.two.name);
  assert.notEqual(json(out.open), json(out.closed));
  // filter arguments are part of the collection; paging arguments are not
  const a = run("{ tickets(status: \"OPEN\") { id title } }").tickets;
  assert.equal(json(a), json(out.open));
});

test("identifying arguments: key, slug, uuid, email, username, handle, sku", () => {
  for (const arg of ["key: \"k1\"", "slug: \"hello\"", "uuid: \"u-1\"", "email: \"a@b.c\"", "username: \"bob\"", "handle: \"bob\"", "sku: \"S1\""]) {
    const [name] = arg.split(":");
    const a = run(`{ x: widget(${arg}) { title } y: widget(${arg}) { title } }`);
    assert.equal(a.x.title, a.y.title, name);
    const b = run(`{ widget(${name}: "other") { title } }`);
    assert.notEqual(a.x.title, b.widget.title, name);
  }
});

test("ids: a list argument selects exactly those entities", () => {
  const out = run("{ people(ids: [3, 9, 4]) { id name } }");
  assert.deepEqual(out.people.map((p) => p.id), ["3", "9", "4"]);
  const single = run("{ person(id: 9) { name } }");
  assert.equal(out.people[1].name, single.person.name);
});

// ---- paging -------------------------------------------------------------------

const ids = (list) => list.map((x) => x.id);
const Q = (args) => `{ posts(${args}) { id title } }`;

test("first/after windows: page 2 of first:10 equals items 11-20 of first:20", () => {
  const big = run(Q("first: 20")).posts;
  assert.equal(big.length, 20);
  assert.deepEqual(ids(big), Array.from({ length: 20 }, (_, i) => String(i + 1)));
  const p1 = run(Q("first: 10")).posts;
  const p2 = run(Q(`first: 10, after: "${encodeCursor(10)}"`)).posts;
  assert.equal(json([...p1, ...p2]), json(big));
  assert.equal(json(p2), json(big.slice(10)));
});

test("offset/limit, skip/take, page/pageSize/perPage", () => {
  const big = run(Q("first: 30")).posts;
  assert.equal(json(run(Q("offset: 10, limit: 10")).posts), json(big.slice(10, 20)));
  assert.equal(json(run(Q("skip: 5, take: 4")).posts), json(big.slice(5, 9)));
  assert.equal(json(run(Q("limit: 3")).posts), json(big.slice(0, 3)));
  assert.equal(json(run(Q("page: 2, pageSize: 10")).posts), json(big.slice(10, 20)));
  assert.equal(json(run(Q("page: 3, perPage: 5")).posts), json(big.slice(10, 15)));
  assert.equal(json(run(Q("page: 1, pageSize: 7")).posts), json(big.slice(0, 7)));
});

test("last/before and last without before", () => {
  const big = run(Q("first: 30")).posts;
  assert.equal(json(run(Q(`last: 5, before: "${encodeCursor(11)}"`)).posts), json(big.slice(5, 10)));
  assert.equal(json(run(Q(`last: 50, before: "${encodeCursor(4)}"`)).posts), json(big.slice(0, 3))); // clipped at the start
  assert.equal(json(run(Q(`first: 3, before: "${encodeCursor(3)}"`)).posts), json(big.slice(0, 2)));
  // last without before takes the end of the finite collection
  const all = run("{ posts { id } }").posts;
  const lastTwo = run(Q("last: 2")).posts;
  assert.deepEqual(ids(lastTwo), ids(all.slice(-2)));
  assert.equal(json(lastTwo), json(run("{ posts { id title } }").posts.slice(-2)));
});

test("paging property: consecutive pages of random sizes concatenate to one big page", () => {
  const big = run(Q("first: 200")).posts;
  let seed = 12345;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), (seed >> 8) % n);
  for (const style of ["after", "offset", "page"]) {
    for (let trial = 0; trial < 6; trial++) {
      const got = [];
      const size = 1 + rnd(25);
      let at = 0;
      while (got.length < 100) {
        const args =
          style === "after" ? `first: ${size}, after: "${encodeCursor(at)}"` :
          style === "offset" ? `offset: ${at}, limit: ${size}` :
          `page: ${Math.floor(at / size) + 1}, pageSize: ${size}`;
        const page = run(Q(args)).posts;
        assert.equal(page.length, size);
        got.push(...page);
        at += size;
      }
      assert.equal(json(got), json(big.slice(0, got.length)), `${style} size ${size}`);
    }
  }
});

test("paging arguments do not change the collection, filters do", () => {
  const a = run("{ posts(status: \"x\", first: 3) { id title } }").posts;
  const b = run("{ posts(status: \"x\", first: 5) { id title } }").posts;
  assert.equal(json(a), json(b.slice(0, 3)));
  const c = run("{ posts(status: \"y\", first: 3) { id title } }").posts;
  assert.notEqual(json(a), json(c));
});

test("variables drive paging", () => {
  const q = "query($n: Int!, $c: String) { posts(first: $n, after: $c) { id } }";
  assert.deepEqual(ids(run(q, { variables: { n: 2 } }).posts), ["1", "2"]);
  assert.deepEqual(ids(run(q, { variables: { n: 2, c: encodeCursor(2) } }).posts), ["3", "4"]);
});

test("paging errors: bad cursor, negative or non-integer sizes, absurd sizes", () => {
  assert.equal(code(() => run(Q('first: 3, after: "garbage"'))), "bad-cursor");
  assert.equal(code(() => run(Q('last: 3, before: "garbage"'))), "bad-cursor");
  assert.equal(code(() => run(Q("first: -1"))), "bad-arguments");
  assert.equal(code(() => run(Q("page: 0, pageSize: 3"))), "bad-arguments");
  assert.equal(code(() => run(Q("first: 1000000"))), "bad-arguments");
  assert.deepEqual(run(Q("first: 0")).posts, []);
});

test("a paged list is endless: far windows exist", () => {
  const far = run(Q("offset: 500, limit: 3")).posts;
  assert.deepEqual(ids(far), ["501", "502", "503"]);
});

// ---- relay connections --------------------------------------------------------

const CONN = "{ posts(first: 3) { edges { cursor node { id title } } pageInfo { hasNextPage hasPreviousPage startCursor endCursor } totalCount } }";

test("connections are inferred from the query shape", () => {
  const { sdl } = inferSchema(CONN);
  assert.match(sdl, /posts\(first: Int\): PostConnection!/);
  assert.match(sdl, /type PostConnection \{\n  edges: \[PostEdge!\]!\n  pageInfo: PageInfo!\n  totalCount: Int!\n\}/);
  assert.match(sdl, /type PostEdge \{\n  cursor: String!\n  node: Post!\n\}/);
  assert.match(sdl, /type PageInfo \{\n  hasNextPage: Boolean!\n  hasPreviousPage: Boolean!\n  startCursor: String\n  endCursor: String\n\}/);
  assert.match(sdl, /type Post \{\n  id: ID!\n  title: String!\n\}/);
  const alt = inferSchema("{ postsConnection { nodes { id } totalCount } }").sdl;
  assert.match(alt, /postsConnection: PostConnection!/);
  assert.match(alt, /nodes: \[Post!\]!/);
});

test("connection: edges, cursors, pageInfo and totalCount", () => {
  const c = run(CONN).posts;
  assert.equal(c.edges.length, 3);
  assert.deepEqual(c.edges.map((e) => e.node.id), ["1", "2", "3"]);
  assert.deepEqual(c.edges.map((e) => decodeCursor(e.cursor)), [1, 2, 3]);
  assert.equal(c.pageInfo.startCursor, c.edges[0].cursor);
  assert.equal(c.pageInfo.endCursor, c.edges[2].cursor);
  assert.equal(c.pageInfo.hasNextPage, true); // endless without a declared count
  assert.equal(c.pageInfo.hasPreviousPage, false);
  assert.equal(c.totalCount, 1000);
});

test("connection: following endCursor continues with no gaps or overlaps", () => {
  const q = (after) => `{ posts(first: 4${after ? `, after: "${after}"` : ""}) { edges { cursor node { id title } } pageInfo { endCursor hasPreviousPage } } }`;
  let after = null;
  const seen = [];
  for (let page = 0; page < 5; page++) {
    const c = run(q(after)).posts;
    assert.equal(c.pageInfo.hasPreviousPage, page > 0);
    seen.push(...c.edges.map((e) => e.node));
    after = c.pageInfo.endCursor;
  }
  assert.deepEqual(seen.map((n) => n.id), Array.from({ length: 20 }, (_, i) => String(i + 1)));
  assert.equal(json(seen), json(run("{ posts(first: 20) { id title } }").posts));
});

test("connection: edges and nodes agree, and totalCount is stable", () => {
  const c = run("{ posts(first: 3) { edges { node { id title } } nodes { id title } totalCount } }").posts;
  assert.equal(json(c.edges.map((e) => e.node)), json(c.nodes));
});

test("connection: last without before is finite and ends the collection", () => {
  const c = run("{ posts(last: 2) { edges { node { id } } pageInfo { hasNextPage hasPreviousPage } totalCount } }").posts;
  const n = c.totalCount;
  assert.ok(n >= 3 && n <= 10);
  assert.deepEqual(c.edges.map((e) => e.node.id), [String(n - 1), String(n)]);
  assert.equal(c.pageInfo.hasNextPage, false);
  assert.equal(c.pageInfo.hasPreviousPage, true);
  assert.equal(run("{ posts { id } }").posts.length, n);
});

test("connection: last/before pages backwards", () => {
  const c = run(`{ posts(last: 3, before: "${encodeCursor(8)}") { edges { node { id } } pageInfo { hasNextPage hasPreviousPage } } }`).posts;
  assert.deepEqual(c.edges.map((e) => e.node.id), ["5", "6", "7"]);
  assert.equal(c.pageInfo.hasNextPage, true);
});

test("connection: empty window has null cursors", () => {
  const c = run("{ posts(first: 0) { edges { cursor } pageInfo { startCursor endCursor } } }").posts;
  assert.deepEqual(c, { edges: [], pageInfo: { startCursor: null, endCursor: null } });
});

test("connection node values equal plain list values (shared pool)", () => {
  const c = run("{ posts(first: 3) { edges { node { id title author { ... on User { name } } } } } }").posts.edges;
  const l = run("{ posts(first: 3) { id title author { ... on User { name } } } }").posts;
  assert.equal(json(c.map((e) => e.node)), json(l));
});

test("nested connections are owned by their parent", () => {
  const out = run("{ users(first: 2) { id posts(first: 2) { edges { node { id } } } } }");
  assert.equal(out.users.length, 2);
  assert.notDeepEqual(out.users[0].posts, out.users[1].posts);
});

// ---- unions and interfaces ----------------------------------------------------

test("union: __typename is chosen per entity and stable", () => {
  const q = "{ results { __typename ... on Post { id title } ... on User { id name } } }";
  const { sdl } = inferSchema(q);
  assert.match(sdl, /union ResultUnion = Post \| User/);
  assert.match(sdl, /results: \[ResultUnion!\]!/);
  const a = run(q).results;
  assert.equal(json(a), json(run(q).results));
  const types = new Set(a.map((x) => x.__typename));
  assert.ok([...types].every((t) => t === "Post" || t === "User"));
  for (const x of a) assert.ok(x.__typename === "Post" ? "title" in x : "name" in x);
  // across seeds both types show up
  const seen = new Set();
  for (let i = 0; i < 20; i++) for (const x of graceholder(q, { seed: `u${i}` }).results) seen.add(x.__typename);
  assert.deepEqual([...seen].sort(), ["Post", "User"]);
  // adding fields to a branch changes nothing else
  const more = run("{ results { __typename ... on Post { id title body } ... on User { id name } } }").results;
  assert.equal(json(more.map((x) => x.__typename)), json(a.map((x) => x.__typename)));
  assert.equal(json(more.filter((x) => x.__typename === "Post").map(({ id, title }) => ({ id, title }))), json(a.filter((x) => x.__typename === "Post").map(({ id, title }) => ({ id, title }))));
});

test("union members are the same entities as the typed lists", () => {
  let hit = false;
  for (let i = 0; i < 40 && !hit; i++) {
    const out = graceholder("{ results { ... on Post { id title } } posts { id title } }", { seed: `m${i}` });
    for (const x of out.results) if (x.title !== undefined) {
      const p = out.posts.find((y) => y.id === x.id);
      if (p) { assert.equal(p.title, x.title); hit = true; }
    }
  }
  assert.ok(hit);
});

test("interface: shared fields plus per-type fields via fragments", () => {
  const q = "{ entries { __typename id ... on Post { title } ... on Video { duration: length } } }";
  const { sdl } = inferSchema(q);
  assert.match(sdl, /interface Entry \{\n  id: ID!\n\}/);
  assert.match(sdl, /type Post implements Entry \{/);
  assert.match(sdl, /type Video implements Entry \{/);
  const out = run(q).entries;
  for (const x of out) {
    assert.ok(typeof x.id === "string");
    assert.ok(x.__typename === "Post" ? "title" in x : "duration" in x);
  }
  assert.equal(json(out), json(run(q).entries));
});

test("named fragments with different type conditions form a union", () => {
  const q = "{ results { __typename ...P ...U } } fragment P on Post { title } fragment U on User { name }";
  const out = run(q).results;
  for (const x of out) assert.ok(x.__typename === "Post" ? "title" in x : "name" in x);
});

test("a single type condition still names the field's type (N2)", () => {
  assert.match(inferSchema("{ posts { author { ...U } } } fragment U on User { name }").sdl, /author: User!/);
});

// ---- decisions ----------------------------------------------------------------

test("inferSchema reports pool sharing and connection decisions", () => {
  const { decisions } = inferSchema("{ posts { author { name } } comments { author { name } } feed(first: 2) { edges { node { id } } } }");
  const shared = decisions.filter((d) => d.rule === "E2-shared");
  assert.deepEqual(shared.map((d) => d.path).sort(), ["comments.author", "posts.author"]);
  assert.ok(decisions.some((d) => d.rule === "S3" && d.path === "feed" && d.value === "FeedConnection"));
});
