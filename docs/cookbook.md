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

## Using suggestSpec with a real model

`suggestSpec` takes any async function. With a fetch-based client it looks like this (not run here because it needs a network):

```sh
# pseudo-code
const spec = await suggestSpec(query, { llm: async (prompt) => (await client.complete(prompt)).text });
# commit JSON.stringify(spec, null, 2) next to the query; generation never calls the model again
```

Because the reply is validated against the query before it is returned, a bad suggestion fails loudly (`bad-suggestion`) instead of producing silently wrong data.

## In the browser

The package is plain ES modules with no Node built-ins; any bundler works. The test suite bundles it with esbuild and checks that a browser-like VM and headless Chromium reproduce every golden byte for byte.

```sh
npx esbuild src/index.js --bundle --format=iife --global-name=Graceholder --minify --outfile=graceholder.js
```
