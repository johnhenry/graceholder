# Cookbook

## Stable fixtures for tests

Pick a seed per test (or per suite) and your fixtures never move. Changing one query does not change the data of another.

```js
import { graceholder } from "@johnhenry/graceholder";

const fixture = (name) => graceholder("{ user(id: 1) { id fullName email } }", { seed: name });
console.log({ a: fixture("test-a").user.email, again: fixture("test-a").user.email, b: fixture("test-b").user.email });
```

```json
{
  "a": "ines.hartley86@example.org",
  "again": "ines.hartley86@example.org",
  "b": "yara.novak@mail.example.com"
}
```

## A paginated API stub

Serve any page from one function: the pages line up, with no state.

```js
import { graceholder } from "@johnhenry/graceholder";

const page = (n, size = 3) => graceholder(`{ posts(page: ${n}, pageSize: ${size}) { id title } }`, { seed: "api" }).posts;
console.log({ page1: page(1).map((p) => p.id), page2: page(2).map((p) => p.id), all: page(1, 6).map((p) => p.id) });
```

```json
{
  "page1": [
    "1",
    "2",
    "3"
  ],
  "page2": [
    "4",
    "5",
    "6"
  ],
  "all": [
    "1",
    "2",
    "3",
    "4",
    "5",
    "6"
  ]
}
```

## Linking records

An author and a listed user are the same person when they have the same type name and key. Give the type name with a type condition, `@type`, or a spec entry.

```js
import { graceholder } from "@johnhenry/graceholder";

const data = graceholder(
  "{ posts(first: 3) { id author @type(name: \"User\") { id name } } users(first: 3) { id name } }",
  { seed: "links", spec: { $options: { poolSize: 3 } } },
);
const byId = Object.fromEntries(data.users.map((u) => [u.id, u.name]));
console.log(data.posts.map((p) => ({ post: p.id, author: p.author.name, sameAsListedUser: byId[p.author.id] === p.author.name })));
```

```json
[
  {
    "post": "1",
    "author": "Bruno Castillo",
    "sameAsListedUser": true
  },
  {
    "post": "2",
    "author": "Zoë Łukasik",
    "sameAsListedUser": true
  },
  {
    "post": "3",
    "author": "Zoë Łukasik",
    "sameAsListedUser": true
  }
]
```

## Realistic counts and values

Heuristics give 3 to 10 items and generic values. Say what you know.

```js
import { graceholder } from "@johnhenry/graceholder";

const data = graceholder(
  `{
    invoices @count(n: 2) {
      number @pattern(p: "INV-####")
      state @pick(values: ["draft", "sent", "paid"])
      lines @count(min: 1, max: 3) { description quantity price }
      subtotal tax total
    }
  }`,
  { seed: "billing" },
);
console.log(data.invoices.map((i) => ({ number: i.number, lines: i.lines.length, total: i.total })));
```

```json
[
  {
    "number": "INV-9895",
    "lines": 2,
    "total": 780.15
  },
  {
    "number": "INV-6176",
    "lines": 3,
    "total": 4217.64
  }
]
```

## One spec for the whole app

Keep overrides in one file next to your queries and pass it to every call. Patterns apply across queries: `**.createdAt` matches any `createdAt`.

```js
import { graceholder } from "@johnhenry/graceholder";

const spec = {
  "**.status": { pick: ["open", "closed"] },
  "@User.email": { gen: "person.email" },
  $options: { poolSize: 20 },
};
console.log(graceholder("{ tickets @count(n: 3) { id status } }", { seed: "app", spec }));
```

```json
{
  "tickets": [
    {
      "id": "1",
      "status": "open"
    },
    {
      "id": "2",
      "status": "open"
    },
    {
      "id": "3",
      "status": "open"
    }
  ]
}
```

## Snapshot testing

Golden snapshots are safe because output is frozen within a major version. Compare `JSON.stringify` output, and review any diff after upgrading the package: a changed golden is an output change.

```js
import { graceholder } from "@johnhenry/graceholder";
import { createHash } from "node:crypto";

const out = JSON.stringify(graceholder("{ posts(first: 3) { id title author { ... on User { name } } } }", { seed: "snap" }));
console.log(createHash("sha256").update(out).digest("hex").slice(0, 16));
```

```json
"89e38df182d7c2c0"
```

## Making the arithmetic visible

Aggregates such as `subtotal`, `tax`, `total` and `xCount` are computed from latent values: every item has a quantity whether or not you select it, so adding or removing fields never changes a total. If you select only `price`, the prices need not add up to `subtotal`; select `quantity` as well to see why.

```js
import { graceholder } from "@johnhenry/graceholder";

const order = graceholder("{ orders(first: 1) { subtotal items { price quantity } } }", { seed: "demo" }).orders[0];
const hidden = graceholder("{ orders(first: 1) { subtotal items { price } } }", { seed: "demo" }).orders[0];
const cents = (x) => Math.round(x * 100);
console.log({
  subtotal: order.subtotal,
  sumOfPriceTimesQuantity: order.items.reduce((s, i) => s + cents(i.price) * i.quantity, 0) / 100,
  sameSubtotalWithoutQuantity: hidden.subtotal === order.subtotal,
});
```

```json
{
  "subtotal": 5452.87,
  "sumOfPriceTimesQuantity": 5452.87,
  "sameSubtotalWithoutQuantity": true
}
```

## Different data for one subtree

`@seed` changes the data of a subtree and nothing else.

```js
import { graceholder } from "@johnhenry/graceholder";

const q = (directive) => `{ users(first: 2) ${directive} { id name } posts(first: 2) { id title } }`;
const a = graceholder(q(""), { seed: "s" });
const b = graceholder(q('@seed(s: "other")'), { seed: "s" });
console.log({ usersChanged: a.users[0].name !== b.users[0].name, postsUnchanged: JSON.stringify(a.posts) === JSON.stringify(b.posts) });
```

```json
{
  "usersChanged": true,
  "postsUnchanged": true
}
```

## A fake backend that remembers

A world keeps pins and mutations across queries, so a test can create something and read it back. Created ids depend only on the seed and the order of mutations; `export()` and `createWorld(exported)` reproduce the state.

```js
import { createWorld } from "@johnhenry/graceholder";

const world = createWorld({ seed: "shop", spec: { todos: { count: 3 } } });
const added = world.query(`mutation { addTodo(input: { title: "Write tests" }) { id title } }`).data.addTodo;
world.query(`mutation { updateTodo(id: ${added.id}, input: { title: "Write more tests" }) { id } }`);
world.query(`mutation { deleteTodo(id: 1) }`);
const todos = () => world.query("{ todos { id title } }").data.todos;

const copy = createWorld(world.export());
console.log({ ids: todos().map((t) => t.id), last: todos().at(-1).title, sameAfterReplay: JSON.stringify(copy.query("{ todos { id title } }")) === JSON.stringify(world.query("{ todos { id title } }")) });
```

```json
{
  "ids": [
    "2",
    "3",
    "7209805"
  ],
  "last": "Write more tests",
  "sameAfterReplay": true
}
```

## Learning a spec from real responses

Save one or more real responses (as `data`) next to the query and let `specFromSamples` turn them into a spec. Nothing is copied but formats and statistics; commit the result and review it.

```js
import { specFromSamples, analyzeSamples, graceholder } from "@johnhenry/graceholder";

const query = "{ users { name email active plan createdAt tags } }";
const real = { users: [
  { name: "Ada Lovelace", email: "ada@analytical.example", active: true, plan: "pro", createdAt: "2021-03-04T10:00:00Z", tags: ["math", "poetry"] },
  { name: "Alan Turing", email: "alan@bletchley.example", active: false, plan: "free", createdAt: "2022-07-19T12:30:00Z", tags: [] },
  { name: "Grace Hopper", email: "grace@navy.example", active: true, plan: "pro", createdAt: "2023-01-30T08:15:00Z", tags: ["cobol"] },
  { name: "Edsger Dijkstra", email: "edsger@tue.example", active: true, plan: "pro", createdAt: "2024-05-02T17:45:00Z", tags: ["graphs", "proofs", "go-to"] },
] };

const { spec, notes } = analyzeSamples(query, real);
console.log({ spec, withheld: notes.filter((n) => n.kind === "withheld").map((n) => n.path) });
```

```json
{
  "spec": {
    "users": {
      "count": 4
    },
    "users.email": {
      "gen": "person.email"
    },
    "users.active": {
      "gen": {
        "name": "bool",
        "args": {
          "p": 0.75
        }
      }
    },
    "users.tags": {
      "count": [
        0,
        3
      ],
      "gen": {
        "name": "text",
        "args": {
          "min": 4,
          "max": 6
        }
      }
    }
  },
  "withheld": [
    "users.plan"
  ]
}
```

`plan` is an enumeration, so its values were withheld. Opt in per field (or with `allowValues: true`) when that is fine, then generate:

```js
import { specFromSamples, graceholder } from "@johnhenry/graceholder";

const query = "{ users { name email active plan createdAt tags } }";
const real = { users: [
  { name: "Ada Lovelace", email: "ada@analytical.example", active: true, plan: "pro", createdAt: "2021-03-04T10:00:00Z", tags: ["math", "poetry"] },
  { name: "Alan Turing", email: "alan@bletchley.example", active: false, plan: "free", createdAt: "2022-07-19T12:30:00Z", tags: [] },
  { name: "Grace Hopper", email: "grace@navy.example", active: true, plan: "pro", createdAt: "2023-01-30T08:15:00Z", tags: ["cobol"] },
  { name: "Edsger Dijkstra", email: "edsger@tue.example", active: true, plan: "pro", createdAt: "2024-05-02T17:45:00Z", tags: ["graphs", "proofs", "go-to"] },
] };
const spec = specFromSamples(query, real, { allowValues: ["users.plan"] });
const fake = graceholder(query, { spec, seed: "ci" });
console.log({ plans: [...new Set(fake.users.map((u) => u.plan))].sort(), users: fake.users.length, copiedNames: JSON.stringify(spec).includes("Lovelace") });
```

```json
{
  "plans": [
    "free",
    "pro"
  ],
  "users": 4,
  "copiedNames": false
}
```

## Generating against your real schema

Pass the schema (SDL, an introspection result or a graphql-js schema) and the query is validated against it; enums, nullability, lists, custom scalars and unions come from the schema. The same `schema` option makes `specFromSamples` use the schema's enum values and frequencies.

```js
import { graceholder, specFromSamples } from "@johnhenry/graceholder";

const schema = `
  scalar DateTime
  enum Status { OPEN CLOSED }
  type Ticket { id: ID! title: String! status: Status! closedAt: DateTime assignee: String }
  type Query { tickets: [Ticket!]! }
`;
const query = "{ tickets { id status closedAt } }";
const spec = specFromSamples(query, { tickets: [
  { id: "1", status: "OPEN", closedAt: null },
  { id: "2", status: "OPEN", closedAt: null },
  { id: "3", status: "CLOSED", closedAt: "2024-12-01T00:00:00Z" },
] }, { schema });
const out = graceholder(query, { schema, spec, seed: "t" });
console.log({ spec, statuses: [...new Set(out.tickets.map((t) => t.status))].sort() });
```

```json
{
  "spec": {
    "tickets": {
      "count": 3
    },
    "tickets.status": {
      "pick": [
        {
          "value": "OPEN",
          "weight": 2
        },
        {
          "value": "CLOSED",
          "weight": 1
        }
      ]
    },
    "tickets.closedAt": {
      "nullRate": 0.667,
      "gen": {
        "name": "datetime",
        "args": {
          "minDaysAgo": 31,
          "maxDaysAgo": 31
        }
      }
    }
  },
  "statuses": [
    "OPEN"
  ]
}
```

## Using suggestSpec with a real model

`suggestSpec` takes any async function. With a fetch-based client it looks like this (not run here because it needs a network):

```sh
# pseudo-code
const spec = await suggestSpec(query, { llm: async (prompt) => (await client.complete(prompt)).text });
# commit JSON.stringify(spec, null, 2) next to the query; generation never calls the model again
```

Because the reply is validated against the query before it is returned, a bad suggestion fails loudly (`bad-suggestion`) instead of producing silently wrong data.

## Realistic data

Pick the realism you want; everything is off by default and every value is still a function of its key.

Coherent places: city, region, country, time zone, postal code, phone and coordinates come from one row.

```js
import { graceholder } from "@johnhenry/graceholder";
import { geo } from "@johnhenry/graceholder/packs/geo";

const { users } = graceholder("{ users(first: 3) { city country zip timezone phone address { city latitude longitude } } }", { packs: [geo], seed: "demo" });
console.log(users);
```

```json
[
  {
    "city": "Montreal",
    "country": "Canada",
    "zip": "H2Y 5Q3",
    "timezone": "America/Toronto",
    "phone": "+1 514-555-0120",
    "address": {
      "city": "Montreal",
      "latitude": 45.5282,
      "longitude": -73.6064
    }
  },
  {
    "city": "San Diego",
    "country": "United States",
    "zip": "92191",
    "timezone": "America/Los_Angeles",
    "phone": "+1 619-555-0171",
    "address": {
      "city": "San Diego",
      "latitude": 32.639,
      "longitude": -117.173
    }
  },
  {
    "city": "Houston",
    "country": "United States",
    "zip": "77003",
    "timezone": "America/Chicago",
    "phone": "+1 713-555-0142",
    "address": {
      "city": "Houston",
      "latitude": 29.8382,
      "longitude": -95.4092
    }
  }
]
```

Heavy-tailed popularity and a price history with trend and seasonality:

```js
import { graceholder } from "@johnhenry/graceholder";

const out = graceholder("{ video { views likes priceHistory(first: 4) { date value } } }", { distributions: "realistic", seed: "demo" });
console.log(out);
```

```json
{
  "video": {
    "views": 168,
    "likes": 108,
    "priceHistory": [
      {
        "date": "2024-12-02T00:00:00.000Z",
        "value": 510.34
      },
      {
        "date": "2024-12-03T00:00:00.000Z",
        "value": 649.01
      },
      {
        "date": "2024-12-04T00:00:00.000Z",
        "value": 820.15
      },
      {
        "date": "2024-12-05T00:00:00.000Z",
        "value": 951.57
      }
    ]
  }
}
```

Placeholder images that need no network and show the user's own initials:

```js
import { graceholder } from "@johnhenry/graceholder";

const { user } = graceholder("{ user(id: 2) { fullName avatar } }", { images: "svg", seed: "demo" });
console.log({ name: user.fullName, svg: decodeURIComponent(user.avatar.split(",")[1]).match(/>([^<]+)<\/text>/)[1] });
```

```json
{
  "name": "Hector Østergaard",
  "svg": "HØ"
}
```

Account data with valid checksums (IBAN mod 97, Luhn card numbers) that agrees with the user's country:

```js
import { graceholder } from "@johnhenry/graceholder";
import { geo } from "@johnhenry/graceholder/packs/geo";
import { finance } from "@johnhenry/graceholder/packs/finance";

console.log(graceholder("{ user(id: 5) { country iban currency cardNumber } }", { packs: [geo, finance], seed: "demo" }).user);
```

```json
{
  "country": "Canada",
  "iban": "ES8646327987591789769386",
  "currency": "CAD",
  "cardNumber": "4576526188713879"
}
```

## In the browser

The package is plain ES modules with no Node built-ins; any bundler works. The test suite bundles it with esbuild and checks that a browser-like VM and headless Chromium reproduce every golden byte for byte.

```sh
npx esbuild src/index.js --bundle --format=iife --global-name=Graceholder --minify --outfile=graceholder.js
```
