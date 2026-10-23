# API reference

```js
import { graceholder, inferSchema, suggestSpec, buildSuggestPrompt, GraceholderError, KEY_SCHEME } from "@johnhenry/graceholder";
```

## `graceholder(query, options?)`

`query` is a string or a graphql-js `DocumentNode`. Returns the `data` of the operation, synchronously, as plain JSON-compatible objects (dates are ISO strings). Throws a [`GraceholderError`](#errors) on failure, unless `errors: "result"`.

| Option | Default | Meaning |
|---|---|---|
| `seed` | `"graceholder"` | A string or number (stringified). Part of every key. |
| `variables` | none | Variables for the operation; also usable as directive arguments. |
| `operationName` | none | Required when the document has several operations. Only `query` operations are supported. |
| `spec` | none | A [side-car spec](#side-car-spec). |
| `strict` | `false` | A spec path that matches no field throws `unused-spec-path` instead of being reported. |
| `locale` | `"en"` | The only bundled locale is `en`; anything else throws `unknown-locale`. |
| `anchorDate` | `"2025-01-01T00:00:00.000Z"` | ISO string or `Date`. All dates are generated relative to it; the clock is never read. |
| `errors` | `"throw"` | `"result"` returns `{ data }` on success and `{ errors }` for GraphQL parse, validation and execution errors (other graceholder errors always throw). |

## `inferSchema(query, spec?, options?)`

Returns `{ sdl, decisions, document }` without generating data. `sdl` is accepted by graphql-js `buildSchema`. `document` is the selected operation and the fragments it uses with graceholder's directives removed. `options` takes `operationName`, `variables` and `strict`.

Each decision is `{ path, field, kind, value, source, rule? }`:

- `kind`: `list`, `type`, `scalar`, `arg`, `count`, `object` (pool sharing), `null`, `key`, `seed`, `unused`.
- `source`: `directive`, `spec`, `heuristic` or `default`.
- `rule`: the inference rule, for example `L3` (plural name), `N3` (type name), `T8` (integer by name), `S3` (connection), `S4` (union/interface), `E2-shared`, `L1`/`N1` (overridden), `C-count`, `unused-spec-path`.

```js
import { inferSchema } from "@johnhenry/graceholder";

const { decisions } = inferSchema(
  "{ users @count(n: 2) { id nick @gen(name: \"word\") city note } }",
  { "users.city": { gen: "place.city" } },
);
console.log(decisions.filter((d) => d.kind === "scalar").map((d) => [d.path, d.source, d.rule]));
```

```json
[
  [
    "users.id",
    "heuristic",
    "T1"
  ],
  [
    "users.nick",
    "directive",
    "gen"
  ],
  [
    "users.city",
    "spec",
    "gen"
  ],
  [
    "users.note",
    "default",
    "T13"
  ]
]
```

## How a query is read

| Query shape | Result |
|---|---|
| a field with a selection | an object type named from the singularised, PascalCased field name (`blogPosts` -> `BlogPost`) |
| a plural name, a paging argument, `items`, `list`, `all*`, an `ids` argument | a list (`people`, `children` and other irregular plurals included) |
| `... on X` fragments | the type `X`; several different types make a union (no common fields) or an interface (common fields) |
| `edges { node }`, `pageInfo`, or `nodes` with `totalCount` | a Relay connection (`PostConnection`, `PostEdge`, `PageInfo`) |
| no selection | a scalar chosen by name (`id`, `email`, `*Url`, `is*`, `*Count`, `price`, `*At`, `city`, `status`, ...), otherwise two words |

Run `inferSchema` on your query to see every decision and the rule behind it.

## Identity, arguments and pagination

- **Identity.** Objects with the same type name and key are the same entity everywhere. Top-level lists are the shared pool of their type (`1..n`); nested lists belong to their parent; a nested single object is a reference into the pool of its type (`1..100`, see `$options.poolSize`).
- **Identifying arguments** (priority order): `id`, `key`, `slug`, `uuid`, `email`, `username`, `handle`, `sku`. `5` and `"5"` are the same key. `ids: [..]` on a list selects exactly those entities. Spec `key` names other (composite) arguments.
- **Filters.** Any other argument is a filter: `tickets(status: "OPEN")` and `tickets(status: "CLOSED")` are different collections.
- **Windows over an endless collection.** `page` + `pageSize`/`perPage`; `offset`/`skip` + `limit`/`take`; `first` + `after`; `last` + `before`. `last` without `before` takes the end of the finite collection. Cursors are opaque (`base64url("gc1:<index>")`).
- **Counts.** A list has 3 to 10 items, keyed by its collection. `@count` / spec `count` fixes or ranges it and also declares the total, so a paged list or connection then ends. A connection without a declared count is endless: `totalCount` is 1000 (`$options.endlessTotal`) and `hasNextPage` is always true.

## Directives

Directives go on fields (`@seed` also on the operation) and are removed before execution. Arguments may be variables.

| Directive | Spec property | Meaning |
|---|---|---|
| `@list` / `@one` | `list: true` / `one: true` | force a list / a single value |
| `@count(n: 5)`, `@count(min: 2, max: 8)` | `count: 5`, `[2, 8]`, `{min, max}` | size (and declared total) of a list |
| `@gen(name: "int", min: 1, max: 9)` | `gen: "int"` or `{ name, args }` | a named [generator](#generators) for a scalar |
| `@pattern(p: "ORD-#####")` | `pattern` | `#` digit, `?` lowercase, `A` uppercase, `*` letter or digit, `\` escapes |
| `@pick(values: ["a", "b"])`, weighted `[{value, weight}]` | `pick` | choose from a fixed set |
| `@nullRate(p: 0.2)` | `nullRate` | probability of `null` (the field becomes nullable) |
| `@derive(from: "title")` | `derive: { from }` | derive from another field of the same entity (`slug`, `username` and `email` fields are shaped; others copy) |
| `@type(name: "User")` | `type` | set the type name, and therefore the shared pool |
| `@seed(s: "x")` | `seed` | a different seed for this subtree; the innermost wins |
| | `key: ["orgId", "userId"]` | identifying argument names (composite) |
| | `own: true` / `shared: true` | do not draw from / draw nested members from the type pool |

## Side-car spec

A spec is an object keyed by path pattern. Paths use schema field names, never aliases, from the root field: `users.name`; `*` is exactly one segment; `**` is zero or more; `@User.email` is the field on that type wherever it appears. `$options` takes `poolSize` (default 100) and `endlessTotal` (default 1000).

Precedence, per property: directive on that field > exact path or `@Type.field` (an exact path wins) > patterns with `*` > patterns with `**` > heuristic > default. Ties go to the longer literal prefix, then the later declaration. Properties merge independently. A spec path matches a field if it matches any path by which the field is reached.

## Generators

Generators are pure. Names are used by `@gen` and spec `gen`; an unknown name throws `unknown-generator` with a "did you mean" hint.

| Group | Names |
|---|---|
| ids | `id.key`, `id.uuid`, `id.int` |
| number | `int`, `float`, `money`, `percent`, `bool` |
| text | `word`, `words`, `sentence`, `sentences`, `paragraph`, `title`, `slug`, `lorem` |
| person | `person.first`, `person.last`, `person.full`, `person.username`, `person.email`, `person.phone`, `person.jobTitle`, `person.bio`, `person.age` |
| company and product | `company.name`, `company.domain`, `company.industry`, `product.name` |
| place | `place.city`, `place.state`, `place.country`, `place.zip`, `place.street`, `place.address`, `place.lat`, `place.lng` |
| web | `url`, `imageUrl`, `ip`, `hex`, `color` |
| time | `datetime`, `time.created`, `time.updated`, `time.published`, `time.deleted`, `time.birthday` |
| choice | `oneOf`, `pattern` |
| graph | `count.of`, `order.subtotal`, `order.tax`, `order.total` (computed from the entity graph) |

## `suggestSpec(query, { llm, spec? })`

An authoring-time helper. `llm` is `(prompt: string) => Promise<string>`. It builds a prompt (`buildSuggestPrompt(query, spec?)`) with the query, the inferred SDL and decisions, the spec grammar and the generator names, parses the reply (a bare JSON object, a fenced block or prose around a JSON object), and validates it: Spec schema, generator names, path syntax, conflicts, and paths that match no field. On failure it re-prompts once with the problems; then it throws `bad-suggestion` (`hint` lists the problems). The prompt wording is versioned (`SUGGEST_PROMPT_VERSION`) and is not part of the output-stability guarantee. `suggestSpec` is never called by generation.

## Errors

`GraceholderError` has `code`, optional `path` and `hint`, and for GraphQL problems `cause` and `errors`.

| Code | When |
|---|---|
| `graphql` | parse, validation or execution errors from graphql-js |
| `bad-operation` | missing or ambiguous operation, or not a query |
| `bad-options` | invalid `anchorDate`, `query` or `llm` |
| `unknown-locale` | locale other than `en` |
| `unknown-directive`, `bad-directive` | not a graceholder directive; malformed directive arguments |
| `unknown-generator`, `bad-generator-args` | unknown name (with hint); `min > max`, bad pattern, ... |
| `bad-spec`, `unused-spec-path` | malformed spec; unused path under `strict` |
| `conflicting-overrides`, `conflicting-shape` | `@list` with `@one`, different values in two places; a field used as both scalar and object |
| `bad-derive` | cycle, self-derive or non-scalar source |
| `bad-cursor`, `bad-arguments` | undecodable cursor; negative or non-integer sizes, `page < 1`, windows over 10000 |
| `bad-suggestion` | `suggestSpec` reply still invalid after the repair round |
| `unsupported` | several concrete types where one is required |
| `internal` | a bug |

## Stability

`KEY_SCHEME` is `"gh1"`. See [../STABILITY.md](../STABILITY.md).
