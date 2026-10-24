# graceholder

Consistently repeatable generated data, in any shape you want, from a GraphQL query.

Give it a query and get data back. There is no schema to write and no random stream to keep in order: every value is a pure function of a key (`seed`, type, entity, field), so the same seed, query and options always produce byte-identical output, on Node and in the browser. Reordering fields, adding siblings or changing aliases never changes another value.

- **Query-only.** The schema is inferred from the query: shapes from field names (`posts` is a list of `Post`, `createdAt` a date, `email` an email), then executed with graphql-js.
- **A real entity graph.** `user(id: 5)` is the same person wherever it appears. Lists page consistently (`first`/`after`, `offset`/`limit`, `page`), Relay connections are inferred from the query, unions and interfaces work.
- **Coherent records.** Names, usernames and emails agree; `createdAt <= updatedAt <= anchorDate`; `total = subtotal + tax`; `commentCount` equals the size of `comments`.
- **Overrides when heuristics are wrong.** Inline directives (`@count`, `@pick`, `@pattern`, ...) or a side-car spec keyed by path, with documented precedence.
- **Library only.** ESM, TypeScript types, Node >= 22 and browsers. `graphql` is the only runtime dependency. No network, no clock, no `Math.random`.

> Status: pre-1.0 and not yet published to npm. See [STABILITY.md](STABILITY.md) for what will be frozen at 1.0.0.

## Install

```sh
npm install @johnhenry/graceholder graphql
```

## Quick start

```js
import { graceholder } from "@johnhenry/graceholder";

const data = graceholder("{ users(first: 2) { id fullName email createdAt } }", { seed: "demo" });
console.log(data);
```

```json
{
  "users": [
    {
      "id": "1",
      "fullName": "Ines Olsen",
      "email": "inesolsen@example.org",
      "createdAt": "2024-01-18T11:34:49.272Z"
    },
    {
      "id": "2",
      "fullName": "Hector Østergaard",
      "email": "hector.ostergaard@example.net",
      "createdAt": "2021-04-21T05:15:43.261Z"
    }
  ]
}
```

`graceholder()` is synchronous and returns plain JSON-compatible objects. The default seed is `"graceholder"`.

## Repeatable by construction

```js
import { graceholder } from "@johnhenry/graceholder";

const plain = graceholder("{ posts { id title author { ... on User { name } } } }", { seed: 1 });
const fancy = graceholder(
  "{ articles: posts { writer: author { ... on User { who: name } } headline: title key: id body tags } }",
  { seed: 1 },
);
console.log({
  sameCall: JSON.stringify(plain) === JSON.stringify(graceholder("{ posts { id title author { ... on User { name } } } }", { seed: 1 })),
  aliasesReorderedAndExtraFields: plain.posts.every(
    (p, i) => p.title === fancy.articles[i].headline && p.id === fancy.articles[i].key && p.author.name === fancy.articles[i].writer.who,
  ),
  otherSeed: JSON.stringify(plain) !== JSON.stringify(graceholder("{ posts { id title author { ... on User { name } } } }", { seed: 2 })),
});
```

```json
{
  "sameCall": true,
  "aliasesReorderedAndExtraFields": true,
  "otherSeed": true
}
```

## Entities, arguments and pagination

Arguments such as `id`, `key`, `slug`, `email` select an entity: the same `Type:key` is identical everywhere. Paging arguments select a window of an endless collection, so page 2 of `first: 5` is items 6 to 10 of `first: 10`. Cursors are opaque and stable.

```js
import { graceholder } from "@johnhenry/graceholder";

const query = `query Page($after: String) {
  me: user(id: 5) { id fullName }
  posts(first: 2, after: $after) {
    edges { cursor node { id title } }
    pageInfo { hasNextPage endCursor }
    totalCount
  }
}`;
const first = graceholder(query, { seed: "demo" });
const next = graceholder(query, { seed: "demo", variables: { after: first.posts.pageInfo.endCursor } });
console.log({
  me: first.me,
  firstPage: first.posts.edges.map((e) => e.node.id),
  nextPage: next.posts.edges.map((e) => e.node.id),
  totalCount: first.posts.totalCount,
  hasNextPage: next.posts.pageInfo.hasNextPage,
});
```

```json
{
  "me": {
    "id": "5",
    "fullName": "Keiko Petrov"
  },
  "firstPage": [
    "1",
    "2"
  ],
  "nextPage": [
    "3",
    "4"
  ],
  "totalCount": 1000,
  "hasNextPage": true
}
```

## Overriding the heuristics

Inline directives are stripped before execution. The same properties can live in a side-car spec keyed by path (`users.name`, `*.status`, `**.createdAt`, `@User.email`). A directive beats a spec entry; an exact path beats `*`, which beats `**`.

```js
import { graceholder } from "@johnhenry/graceholder";

const data = graceholder(
  `{
    orders @count(n: 2) {
      code @pattern(p: "ORD-#####")
      status @pick(values: [{ value: "new", weight: 3 }, { value: "paid", weight: 1 }])
      note
      total
    }
  }`,
  { seed: "demo", spec: { "orders.note": { nullRate: 0.5 } } },
);
console.log(data);
```

```json
{
  "orders": [
    {
      "code": "ORD-60441",
      "status": "new",
      "note": "natus eu",
      "total": 5943.63
    },
    {
      "code": "ORD-17295",
      "status": "new",
      "note": null,
      "total": 4317.75
    }
  ]
}
```

Directives: `@list`, `@one`, `@count`, `@gen`, `@pattern`, `@pick`, `@nullRate`, `@derive`, `@type`, `@seed`. Everything is documented in [docs/api.md](docs/api.md); recipes are in [docs/cookbook.md](docs/cookbook.md).

## See what was inferred

```js
import { inferSchema } from "@johnhenry/graceholder";

const { sdl, decisions } = inferSchema("{ posts(first: 3) { id title createdAt tags } }");
console.log({ sdl, titleDecision: decisions.find((d) => d.path === "posts.title" && d.kind === "scalar") });
```

```json
{
  "sdl": "scalar DateTime\n\ntype Query {\n  posts(first: Int): [Post!]!\n}\n\ntype Post {\n  id: ID!\n  title: String!\n  createdAt: DateTime!\n  tags: [String!]!\n}\n",
  "titleDecision": {
    "path": "posts.title",
    "field": "title",
    "kind": "scalar",
    "value": "String",
    "source": "heuristic",
    "rule": "T11"
  }
}
```

## Learn from real data

`specFromSamples(query, samples, options?)` reads one or more real responses and writes a spec: list sizes, null rates, number ranges, boolean ratios, date ranges, ID formats (`SKU-####`), string lengths and, only when you allow it, enum-like value sets. It needs no LLM and never copies free text. See [docs/api.md](docs/api.md#specfromsamplesquery-samples-options) for the rules and [docs/cookbook.md](docs/cookbook.md#learning-a-spec-from-real-responses) for a worked example.

```js
import { specFromSamples } from "@johnhenry/graceholder";

const spec = specFromSamples("{ users { id age active } }", { users: [
  { id: "7", age: 31, active: true },
  { id: "9", age: 45, active: false },
  { id: "12", age: 38, active: true },
] });
console.log(spec);
```

```json
{
  "users": {
    "count": 3
  },
  "users.age": {
    "gen": {
      "name": "int",
      "args": {
        "min": 31,
        "max": 45
      }
    }
  },
  "users.active": {
    "gen": {
      "name": "bool",
      "args": {
        "p": 0.667
      }
    }
  }
}
```

## Use your real schema

Pass `schema` (SDL, an introspection result or a graphql-js schema) and the query is validated against it. Enums, nullability, lists, custom scalars, connections and unions/interfaces then come from the schema instead of from name heuristics; the entity graph and the determinism guarantee are unchanged. Without `schema`, nothing changes.

```js
import { graceholder } from "@johnhenry/graceholder";

const schema = "enum Plan { FREE PRO } type Query { account: Account! } type Account { plan: Plan! seats: Int! }";
console.log(graceholder("{ account { plan seats } }", { schema, seed: "demo" }));
```

```json
{
  "account": {
    "plan": "PRO",
    "seats": 44
  }
}
```

Directives and spec entries that contradict the schema throw `schema-conflict`. Details: [docs/api.md](docs/api.md#schema-mode).

## Suggest a spec with an LLM (authoring time)

`suggestSpec` asks a model you provide to review the inference and return a spec. The core imports no LLM SDK: you pass a function `(prompt) => Promise<string>`. The reply is validated against the query; one repair round is offered; then `bad-suggestion`. Commit the result; generation itself never calls a model.

```js
import { suggestSpec, graceholder } from "@johnhenry/graceholder";

// a stand-in for your model call
const llm = async () => JSON.stringify({ "orders.code": { pattern: "ORD-#####" } });

const query = "{ orders { code total } }";
const spec = await suggestSpec(query, { llm });
console.log({ spec, code: graceholder(query, { spec, seed: "demo" }).orders[0].code });
```

```json
{
  "spec": {
    "orders.code": {
      "pattern": "ORD-#####"
    }
  },
  "code": "ORD-60441"
}
```

## A world that remembers

`createWorld` gives a fake backend: pin specific entities, run mutations (`createUser`, `updateUser`, `deleteUser`, `addX`, `removeX`, ...) and later queries see them. Created ids, positions and counts are deterministic, and the state is an append-only log you can export and replay.

```js
import { createWorld } from "@johnhenry/graceholder";

const world = createWorld({ seed: "readme" });
world.pin("User:1", { name: "Alice Admin" });
world.query(`mutation { deleteUser(id: 2) { id } }`);
const { data } = world.query("{ users { id name email } }");
console.log(data.users.slice(0, 2));
```

```json
[
  {
    "id": "1",
    "name": "Alice Admin",
    "email": "alice.admin@example.net"
  },
  {
    "id": "3",
    "name": "Ines Gupta",
    "email": "ines.gupta@example.net"
  }
]
```

See [docs/api.md](docs/api.md#createworldoptions) for the mutation rules.

## More realistic data (opt-in)

Domain packs, heavy-tailed distributions, time series and SVG placeholders are all off by default, so existing output never moves. Packs are separate imports, so you only ship the ones you use.

```js
import { graceholder } from "@johnhenry/graceholder";
import { geo } from "@johnhenry/graceholder/packs/geo";
import { commerce } from "@johnhenry/graceholder/packs/commerce";

const data = graceholder("{ user(id: 1) { fullName city country timezone phone avatar } product { name category price } }", {
  packs: [geo, commerce],
  images: "svg",
  distributions: "realistic",
});
console.log({ ...data.user, avatar: data.user.avatar.slice(0, 40) + "...", product: data.product });
```

```json
{
  "fullName": "Miles Tanaka",
  "city": "Leeds",
  "country": "United Kingdom",
  "timezone": "Europe/London",
  "phone": "+44 113 496 0314",
  "avatar": "data:image/svg+xml;charset=utf-8,%3Csvg%...",
  "product": {
    "name": "Maplecrest Foldable Whiteboard",
    "category": "Office",
    "price": 165.55
  }
}
```

See [Packs, distributions and images](docs/api.md#packs) in the API reference and the [cookbook](docs/cookbook.md#realistic-data).

## Seed a database, write fixtures files (bulk)

`stream` turns the root collection of a query into a lazy iterable (sync and async) with bounded memory, and `toNDJSON`, `toCSV` and `toSQL` write it out. Item `k` of the stream is exactly item `k` of the windowed query `users(offset: k, first: 1)`, so it works with `schema`, `packs`, `spec` and a world (`world.stream`), and chunked output (rows 0 to 999, then 1000 to 1999) is byte-identical to one run.

```js
import { stream, toNDJSON, toSQL } from "@johnhenry/graceholder";

// stream() is lazy: 100,000 rows cost no more memory than 2
const query = "{ posts { id title author { id name } } }";
console.log([...toNDJSON(stream(query, { seed: "readme", count: 2 }))]);
console.log("run toSQL for a Postgres or SQLite script:", [...toSQL(query, { seed: "readme", count: 1, dialect: "sqlite" })].length > 0);
```

SQL gets one table per entity type, nested lists as child tables with foreign keys, shared references written once, and Postgres or SQLite quoting. See [docs/api.md](docs/api.md#bulk-generation-stream-tondjson-tocsv-tosql) and the cookbook recipe [Seed a staging Postgres identically](docs/cookbook.md#seed-a-staging-postgres-identically).

## Client adapters

Point an existing GraphQL client at a world instead of a backend. Each adapter is its own subpath export; the client libraries are optional peer dependencies, so the core still depends on `graphql` only.

| Import | Gives you | Peer dependencies |
| --- | --- | --- |
| `@johnhenry/graceholder/apollo` | `GraceholderLink` (an `ApolloLink`) | `@apollo/client` |
| `@johnhenry/graceholder/urql` | `graceholderExchange` | `@urql/core`, `wonka` |
| `@johnhenry/graceholder/fetch` | `createFetch` (a `fetch` replacement) | none |

Every adapter takes either a ready `world` or world options (`seed`, `spec`, ...), and an optional `latency` that is deterministic from the seed. Mutations go through the world, so a mutation followed by a query sees the new entity.

```js
import { ApolloClient, InMemoryCache, gql } from "@apollo/client";
import { GraceholderLink } from "@johnhenry/graceholder/apollo";

const client = new ApolloClient({ link: new GraceholderLink({ seed: "readme", spec: { users: { count: 2 } } }), cache: new InMemoryCache() });
const { data } = await client.query({ query: gql`{ users { id name } }` });
console.log(data.users.map((u) => u.name));
```

```json
[
  "Mateo Mbeki",
  "Julia Wright"
]
```

See [docs/api.md](docs/api.md#client-adapters) for the options and [the cookbook](docs/cookbook.md#storybook-with-apollo) for Storybook and Playwright recipes.

## Edge cases, repeatably

`scenario` swaps the output for an edge case, deterministically: `empty`, `huge`, `nulls`, `unicode`, `boundary` and `errors`, alone or combined, for the whole query or one spec path. Without it nothing changes.

```js
import { graceholder } from "@johnhenry/graceholder";

const query = "{ users(first: 2) { id name posts { id } } }";
const spec = { "users.posts": { scenario: "empty" } };
console.log({
  emptyPosts: graceholder(query, { spec }).users.map((u) => u.posts.length),
  nulls: graceholder(query, { scenario: "nulls" }).users[0],
  errors: graceholder("{ user(id: 1) { id name email } }", { scenario: "errors", scenarioOptions: { errorRate: 0.5 }, errors: "result" }).errors.map((e) => e.path.join(".")),
});
```

```json
{
  "emptyPosts": [
    0,
    0
  ],
  "nulls": {
    "id": "1",
    "name": null,
    "posts": null
  },
  "errors": [
    "user.name"
  ]
}
```

`@johnhenry/graceholder/fast-check` turns the same idea into a property-testing arbitrary over seeds and scenario sets, with shrinking. See [Scenarios](docs/api.md#scenarios) and the [cookbook](docs/cookbook.md#test-your-ui-against-every-edge-case).

## Determinism and stability

The key scheme, hash (XXH64), generator (SplitMix64), vocabulary and inference rules are frozen at 1.0.0; see [STABILITY.md](STABILITY.md). Golden files in `test/golden` pin the output, are checked on Node 22 and 24, and are reproduced in a browser-like VM and in headless Chromium.

## Size

The whole library with `graphql` bundled, minified, is about 213 kB (about 62 kB gzipped). `graphql` is the bulk of it; graceholder itself is a small part. The vocabulary packs are separate modules (minified and gzipped: `geo` 5.0 kB, `commerce` 2.1 kB, `finance` 2.3 kB, `health` 1.4 kB) that are only included when imported.

## Development

```sh
npm ci
npm run check        # banned-token lint, typecheck, tests (including the browser-like bundle test)
npm run test:browser # headless Chromium smoke test (needs a Chromium, see test/browser.test.js)
npm run golden:update  # rewrite golden files: any change is an output change, review it
npm run docs:update    # re-run the README and docs examples and refresh their output blocks
```

The design is in [docs/design.md](docs/design.md). MIT licensed.
