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
      "total": 1648.59
    },
    {
      "code": "ORD-17295",
      "status": "new",
      "note": null,
      "total": 600.17
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

## Determinism and stability

The key scheme, hash (XXH64), generator (SplitMix64), vocabulary and inference rules are frozen at 1.0.0; see [STABILITY.md](STABILITY.md). Golden files in `test/golden` pin the output, are checked on Node 22 and 24, and are reproduced in a browser-like VM and in headless Chromium.

## Size

The whole library with `graphql` bundled, minified, is about 200 kB (about 58 kB gzipped). `graphql` is the bulk of it; graceholder itself is a small part.

## Development

```sh
npm ci
npm run check        # banned-token lint, typecheck, tests (including the browser-like bundle test)
npm run test:browser # headless Chromium smoke test (needs a Chromium, see test/browser.test.js)
npm run golden:update  # rewrite golden files: any change is an output change, review it
npm run docs:update    # re-run the README and docs examples and refresh their output blocks
```

The design is in [docs/design.md](docs/design.md). MIT licensed.
