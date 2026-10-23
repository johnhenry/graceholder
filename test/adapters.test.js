import { test } from "node:test";
import assert from "node:assert/strict";
import { ApolloClient, InMemoryCache, gql } from "@apollo/client";
import { Client, cacheExchange, fetchExchange } from "@urql/core";
import { graceholder, createWorld } from "../src/index.js";
import { GraceholderLink } from "../src/adapters/apollo.js";
import { graceholderExchange } from "../src/adapters/urql.js";
import { createFetch } from "../src/adapters/fetch.js";

const SPEC = { users: { count: 3 } };
const QUERY = `query Users { users { id name email } }`;
const OPTS = { seed: "adapters", spec: SPEC };

const apollo = (link) => new ApolloClient({ link, cache: new InMemoryCache() });
// Apollo adds __typename to every selection set; the world answers it like any field.
const noTypename = (v) => JSON.parse(JSON.stringify(v), (k, x) => (k === "__typename" ? undefined : x));
const urqlClient = (exchange, extra = []) => new Client({ url: "http://x.test/graphql", exchanges: [cacheExchange, exchange, ...extra], fetch: () => assert.fail("network used") });

// ---------- Apollo ----------
test("apollo: a real client resolves the same data as graceholder() for the same seed", async () => {
  const client = apollo(new GraceholderLink(OPTS));
  const { data } = await client.query({ query: gql(QUERY) });
  assert.deepEqual(noTypename(data), graceholder(QUERY, OPTS));
  assert.equal(data.users[0].__typename, "User");
});

test("apollo: variables and operationName reach the world", async () => {
  const q = `query One($id: ID!) { user(id: $id) { id name } }`;
  const seen = [];
  const link = new GraceholderLink(OPTS);
  const original = link.world.query.bind(link.world);
  link.world.query = (doc, o) => (seen.push(o), original(doc, o));
  const { data } = await apollo(link).query({ query: gql(q), variables: { id: 2 } });
  assert.equal(data.user.id, "2");
  assert.deepEqual(noTypename(data), graceholder(q, { ...OPTS, variables: { id: 2 } }));
  assert.deepEqual(seen, [{ variables: { id: 2 }, operationName: "One" }]);
});

test("apollo: a mutation, then a query, shows the created entity (shared world)", async () => {
  const world = createWorld({ seed: "m", spec: { todos: { count: 2 } } });
  const client = apollo(new GraceholderLink({ world }));
  const m = await client.mutate({ mutation: gql(`mutation { addTodo(input: { title: "Ship it" }) { id title } }`) });
  assert.equal(m.data.addTodo.title, "Ship it");
  const { data } = await client.query({ query: gql(`{ todos { id title } }`), fetchPolicy: "network-only" });
  assert.ok(data.todos.some((t) => t.id === m.data.addTodo.id && t.title === "Ship it"));
  assert.deepEqual(noTypename(data), world.query(`{ todos { id title } }`).data);
});

test("apollo: world options create a world internally, exposed as link.world", async () => {
  const link = new GraceholderLink(OPTS);
  assert.equal(typeof link.world.query, "function");
  assert.deepEqual(link.world.query(QUERY).data, graceholder(QUERY, OPTS));
});

test("apollo: request errors surface as GraphQL errors", async () => {
  const client = apollo(new GraceholderLink(OPTS));
  const res = await client.query({ query: gql(`{ users(first: 1, last: 1) { id } }`), errorPolicy: "all" }).catch((e) => e);
  assert.ok(res.error || res instanceof Error || res.errors?.length, "an error is reported");
});

test("apollo: latency is deterministic from the seed and injectable", async () => {
  const waits = [];
  const delay = (ms) => void waits.push(ms);
  const mk = (seed) => new GraceholderLink({ seed, spec: SPEC, latency: [50, 500], delay });
  await apollo(mk("a")).query({ query: gql(QUERY) });
  await apollo(mk("a")).query({ query: gql(QUERY) });
  await apollo(mk("b")).query({ query: gql(QUERY) });
  assert.equal(waits[0], waits[1]);
  assert.ok(waits.every((w) => w >= 50 && w <= 500));
  assert.notEqual(waits[0], waits[2]);
});

test("apollo: unsubscribing before the delay elapses cancels the answer", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const link = new GraceholderLink({ ...OPTS, latency: 10, delay: () => gate });
  let seen = 0;
  const sub = link.request({ query: gql(QUERY), variables: {}, operationName: "Users" }).subscribe(() => seen++);
  sub.unsubscribe();
  release();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(seen, 0);
});

// ---------- urql ----------
test("urql: a real client resolves the same data as graceholder() for the same seed", async () => {
  const client = urqlClient(graceholderExchange(OPTS));
  const res = await client.query(QUERY, {}).toPromise();
  assert.equal(res.error, undefined);
  assert.deepEqual(noTypename(res.data), graceholder(QUERY, OPTS));
});

test("urql: variables are passed", async () => {
  const q = `query One($id: ID!) { user(id: $id) { id name } }`;
  const client = urqlClient(graceholderExchange(OPTS));
  const res = await client.query(q, { id: 4 }).toPromise();
  assert.deepEqual(noTypename(res.data), graceholder(q, { ...OPTS, variables: { id: 4 } }));
});

test("urql: a mutation, then a query, shows the created entity", async () => {
  const world = createWorld({ seed: "m", spec: { todos: { count: 2 } } });
  const client = urqlClient(graceholderExchange({ world }));
  const m = await client.mutation(`mutation { addTodo(input: { title: "Ship it" }) { id title } }`, {}).toPromise();
  assert.equal(m.data.addTodo.title, "Ship it");
  const res = await client.query(`{ todos { id title } }`, {}, { requestPolicy: "network-only" }).toPromise();
  assert.ok(res.data.todos.some((t) => t.id === m.data.addTodo.id));
});

test("urql: GraphQL errors become a CombinedError", async () => {
  const client = urqlClient(graceholderExchange(OPTS));
  const res = await client.query(`{ users(first: 1, last: 1) { id } }`, {}).toPromise();
  assert.ok(res.error);
  assert.equal(res.error.graphQLErrors[0].extensions.code, "bad-arguments");
});

test("urql: placed before fetchExchange it answers and fetchExchange never runs; after the cache it is hit once", async () => {
  let calls = 0;
  const client = new Client({
    url: "http://x.test/graphql",
    exchanges: [cacheExchange, graceholderExchange(OPTS), fetchExchange],
    fetch: () => (calls++, assert.fail("fetchExchange must not see queries")),
  });
  const a = await client.query(QUERY, {}).toPromise();
  const b = await client.query(QUERY, {}).toPromise();
  assert.deepEqual(a.data, b.data);
  assert.equal(calls, 0);
});

test("urql: latency is deterministic and injectable", async () => {
  const waits = [];
  const delay = (ms) => void waits.push(ms);
  for (let i = 0; i < 2; i++) await urqlClient(graceholderExchange({ ...OPTS, latency: { min: 10, max: 900 }, delay })).query(QUERY, {}).toPromise();
  assert.equal(waits.length, 2);
  assert.equal(waits[0], waits[1]);
});

// ---------- fetch ----------
const post = (f, body, url = "http://x.test/graphql", headers = { "content-type": "application/json" }) =>
  f(url, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

test("fetch: POST with a JSON body returns a real Response", async () => {
  const f = createFetch(OPTS);
  const res = await post(f, { query: QUERY });
  assert.ok(res instanceof Response);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/json/);
  assert.deepEqual(await res.json(), { data: graceholder(QUERY, OPTS) });
});

test("fetch: variables and operationName", async () => {
  const q = `query One($id: ID!) { user(id: $id) { id } } query Two { users { id } }`;
  const f = createFetch(OPTS);
  const res = await (await post(f, { query: q, variables: { id: 3 }, operationName: "One" })).json();
  assert.equal(res.data.user.id, "3");
});

test("fetch: GET with query, variables and operationName in the URL", async () => {
  const f = createFetch(OPTS);
  const q = `query One($id: ID!) { user(id: $id) { id } }`;
  const url = `http://x.test/graphql?query=${encodeURIComponent(q)}&variables=${encodeURIComponent('{"id":7}')}&operationName=One`;
  const res = await f(url);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.user.id, "7");
});

test("fetch: a mutation over GET is refused with 405", async () => {
  const f = createFetch(OPTS);
  const res = await f(`http://x.test/graphql?query=${encodeURIComponent('mutation { addTodo(input: {title: "x"}) { id } }')}`);
  assert.equal(res.status, 405);
});

test("fetch: a mutation then a query shows the created entity", async () => {
  const f = createFetch({ seed: "m", spec: { todos: { count: 2 } } });
  const m = await (await post(f, { query: `mutation { addTodo(input: { title: "Ship it" }) { id title } }` })).json();
  const q = await (await post(f, { query: `{ todos { id title } }` })).json();
  assert.ok(q.data.todos.some((t) => t.id === m.data.addTodo.id && t.title === "Ship it"));
});

test("fetch: GraphQL errors are status 200 with errors; malformed requests are 400", async () => {
  const f = createFetch(OPTS);
  const gqlErr = await post(f, { query: `{ users(first: 1, last: 1) { id } }` });
  assert.equal(gqlErr.status, 200);
  assert.equal((await gqlErr.json()).errors[0].extensions.code, "bad-arguments");
  const syntax = await post(f, { query: `{ users ` });
  assert.equal(syntax.status, 200);
  assert.ok((await syntax.json()).errors.length);
  assert.equal((await post(f, "not json")).status, 400);
  assert.equal((await post(f, { variables: {} })).status, 400);
  assert.equal((await post(f, { query: QUERY, variables: [1] })).status, 400);
  assert.equal((await post(f, [])).status, 400);
  assert.equal((await f("http://x.test/graphql", { method: "PUT", body: "{}" })).status, 405);
});

test("fetch: non-matching requests go to the fallback, or to globalThis.fetch", async () => {
  const seen = [];
  const fallback = async (input, init) => (seen.push([String(input), init?.method]), new Response("plain", { status: 201 }));
  const f = createFetch({ ...OPTS, fallback });
  const res = await f("http://x.test/api/users", { method: "POST" });
  assert.equal(res.status, 201);
  assert.deepEqual(seen, [["http://x.test/api/users", "POST"]]);

  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response("global");
  try {
    assert.equal(await (await createFetch(OPTS)("http://x.test/other")).text(), "global");
  } finally {
    globalThis.fetch = real;
  }
});

test("fetch: match as string, RegExp and function; the default accepts a trailing slash and a relative URL", async () => {
  const fallback = async () => new Response("fb");
  const hit = async (f, url) => (await (await post(f, { query: "{ users { id } }" }, url)).headers.get("content-type"))?.includes("json");
  assert.ok(await hit(createFetch({ ...OPTS, fallback, match: "/api/gql" }), "http://x.test/api/gql"));
  assert.ok(await hit(createFetch({ ...OPTS, fallback, match: /\/gql$/ }), "http://x.test/gql"));
  assert.ok(await hit(createFetch({ ...OPTS, fallback, match: (u) => u.searchParams.has("g") }), "http://x.test/any?g=1"));
  assert.ok(!(await hit(createFetch({ ...OPTS, fallback, match: "/api/gql" }), "http://x.test/graphql")));
  assert.ok(await hit(createFetch({ ...OPTS, fallback }), "http://x.test/v1/graphql/"));
  assert.ok(await hit(createFetch({ ...OPTS, fallback }), "/graphql"));
});

test("fetch: accepts a Request and an application/graphql body", async () => {
  const f = createFetch(OPTS);
  const viaRequest = await f(new Request("http://x.test/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: QUERY }) }));
  assert.deepEqual((await viaRequest.json()).data, graceholder(QUERY, OPTS));
  const raw = await post(f, QUERY, "http://x.test/graphql", { "content-type": "application/graphql" });
  assert.deepEqual((await raw.json()).data, graceholder(QUERY, OPTS));
});

test("fetch: a batched array gets an array of results", async () => {
  const f = createFetch(OPTS);
  const out = await (await post(f, [{ query: QUERY }, { query: `{ users(first: 1, last: 1) { id } }` }, { variables: {} }])).json();
  assert.equal(out.length, 3);
  assert.deepEqual(out[0].data, graceholder(QUERY, OPTS));
  assert.equal(out[1].errors[0].extensions.code, "bad-arguments");
  assert.ok(out[2].errors);
});

test("fetch: latency is seed-deterministic, via an injected delay or fake timers", async (t) => {
  const waits = [];
  const delay = (ms) => void waits.push(ms);
  const f = createFetch({ ...OPTS, latency: [100, 2000], delay });
  await post(f, { query: QUERY });
  await post(f, { query: QUERY });
  await post(createFetch({ ...OPTS, seed: "other", latency: [100, 2000], delay }), { query: QUERY });
  assert.equal(waits[0], waits[1]);
  assert.notEqual(waits[0], waits[2]);

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const g = createFetch({ ...OPTS, latency: 300 });
  let done = false;
  const p = post(g, { query: QUERY }).then((r) => ((done = true), r));
  await Promise.resolve();
  t.mock.timers.tick(299);
  await Promise.resolve();
  assert.equal(done, false);
  t.mock.timers.tick(1);
  assert.equal((await p).status, 200);
});

test("fetch: an aborted signal rejects while waiting", async () => {
  const f = createFetch({ ...OPTS, latency: 10, delay: () => new Promise(() => {}) });
  const ctl = new AbortController();
  const p = f("http://x.test/graphql", { method: "POST", body: JSON.stringify({ query: QUERY }), signal: ctl.signal });
  setTimeout(() => ctl.abort(), 1);
  await assert.rejects(p, /abort/i);
});

test("fetch: the shared world is exposed, and three adapters on one world agree", async () => {
  const world = createWorld({ seed: "one", spec: SPEC });
  const f = createFetch({ world });
  assert.equal(f.world, world);
  await post(f, { query: `mutation { addTodo(input: { title: "T" }) { id } }` });
  const viaApollo = await apollo(new GraceholderLink({ world })).query({ query: gql(`{ todos { id title } }`) });
  const viaUrql = await urqlClient(graceholderExchange({ world })).query(`{ todos { id title } }`, {}).toPromise();
  assert.deepEqual(noTypename(viaApollo.data), noTypename(viaUrql.data));
  assert.ok(viaUrql.data.todos.some((x) => x.title === "T"));
});

test("latency options are validated when a request is made", async () => {
  const f = createFetch({ ...OPTS, latency: [5, 1] });
  await assert.rejects(post(f, { query: QUERY }), RangeError);
  assert.throws(() => createFetch({ ...OPTS, world: {} }), TypeError);
});
