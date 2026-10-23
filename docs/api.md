# API reference

```js
import { graceholder, createWorld, inferSchema, specFromSamples, analyzeSamples, registerPack, suggestSpec, buildSuggestPrompt, GraceholderError, KEY_SCHEME } from "@johnhenry/graceholder";
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
| `packs` | none | [Vocabulary packs](#packs): names of registered packs or objects imported from `@johnhenry/graceholder/packs/<name>`. |
| `images` | `"url"` | `"svg"` returns deterministic [inline SVG data URIs](#images) for image fields. |
| `distributions` | `"uniform"` | `"realistic"` makes popularity fields heavy-tailed and turns `...History`/`...Series` fields into [time series](#distributions-and-time-series). |
| `schema` | none | [Schema mode](#schema-mode): SDL, an introspection result or a graphql-js schema. Without it the schema is inferred from the query. |
| `errors` | `"throw"` | `"result"` returns `{ data }` on success and `{ errors }` for GraphQL parse, validation and execution errors (other graceholder errors always throw). |

## `inferSchema(query, spec?, options?)`

Returns `{ sdl, decisions, document }` without generating data. `sdl` is accepted by graphql-js `buildSchema`. `document` is the selected operation and the fragments it uses with graceholder's directives removed. `options` takes `operationName`, `variables`, `strict`, `packs`, `images`, `distributions` and `schema` (inference depends on `packs` and `distributions`).

Each decision is `{ path, field, kind, value, source, rule? }`:

- `kind`: `list`, `type`, `scalar`, `arg`, `count`, `object` (pool sharing), `null`, `key`, `seed`, `unused`, `nullable` (schema mode).
- `source`: `directive`, `spec`, `heuristic`, `default` or `schema`.
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
| text | `word`, `words`, `text` (`min`, `max`: length in characters), `sentence`, `sentences`, `paragraph`, `title`, `slug`, `lorem` |
| person | `person.first`, `person.last`, `person.full`, `person.username`, `person.email`, `person.phone`, `person.jobTitle`, `person.bio`, `person.age` |
| company and product | `company.name`, `company.domain`, `company.industry`, `product.name` |
| place | `place.city`, `place.state`, `place.country`, `place.zip`, `place.street`, `place.address`, `place.lat`, `place.lng` |
| web | `url`, `imageUrl`, `ip`, `hex`, `color` |
| images | `image.avatar` (initials on a coloured square, `size` 16-1024), `image.geometric` (`width`, `height`): inline SVG data URIs, see [Images](#images) |
| series | `series.date`, `series.value` (see [time series](#distributions-and-time-series)) |
| time | `datetime` (`minDaysAgo`, `maxDaysAgo`, `format`: `"datetime"` or `"date"`), `time.created`, `time.updated`, `time.published`, `time.deleted`, `time.birthday` |
| choice | `oneOf`, `pattern` |
| graph | `count.of`, `order.subtotal`, `order.tax`, `order.total` (computed from the entity graph) |

## `createWorld(options?)`

A persistent, deterministic world shared across queries: pinned entities, and mutations that change what later queries see. Options: `seed`, `spec`, `anchorDate`, `locale`, `strict`, `schema`, `packs`, `images`, `distributions` (as for `graceholder`) and `log` (a previous `export().log`). With no pins and no mutations it answers exactly like `graceholder` with the same options.

- `world.query(query, { variables, operationName })` runs a query or a mutation and returns a GraphQL result, `{ data }` or `{ data?, errors }`; it does not throw for a bad request (the graceholder code is in `errors[i].extensions.code`).
- `world.pin("Type:key", { field: value })` overrides fields of one entity; `name`, `firstName` or `lastName` pins keep `email`, `username` and the other name fields coherent. Returns the world.
- `world.export()` returns `{ seed, spec, anchorDate, locale, log }`; `createWorld(exported)` replays it to the identical state.
- `world.reset()` clears every pin and mutation.

Mutations have no schema, so they are read from the name and arguments: the first word of the field is the verb (`create`/`add`/`insert`, `update`/`edit`/`set`, `delete`/`remove`), the rest is the entity type (`createBlogPost` -> `BlogPost`), the fields come from `input` (or the arguments), the selection is the affected entity. Override with the spec's `$mutations` block: `verbs` (`{ archive: "delete" }`), `fields` (`{ signUp: { op: "create", type: "User" } }` with optional `idArg`, `input`, `read`), `relations` (`{ "Post.authorId": "User" }`) and `position` (`"start"` or `"end"`). The full rules are in the design document (section 16, World).

```js
import { createWorld } from "@johnhenry/graceholder";

const world = createWorld({ seed: "demo", spec: { users: { count: 3 } } });
world.pin("User:1", { name: "Alice Admin" });
const made = world.query(`mutation { createUser(input: { name: "Bo Builder" }) { id name } }`);
world.query(`mutation { deleteUser(id: 2) { id } }`);
const { data } = world.query("{ users { id name email } }");
console.log({ created: made.data.createUser.name, users: data.users.map((u) => [u.name, u.email]) });
```

```json
{
  "created": "Bo Builder",
  "users": [
    [
      "Alice Admin",
      "aliceadmin@example.org"
    ],
    [
      "Bruno Marsh",
      "bruno.marsh@example.org"
    ],
    [
      "Bo Builder",
      "bo.builder7@example.org"
    ]
  ]
}
```

## Distributions and time series

`int`, `float` and `money` take a `dist` argument. Each value is sampled from its own per-value stream, so a value never depends on any other value, and sampling is bounded to `[min, max]`.

| `dist` | Shape | Arguments |
|---|---|---|
| `uniform` (default) | flat | none |
| `normal` | Box-Muller, truncated to `[min, max]` by rejection | `mean` (midpoint), `sd` (range / 6) |
| `lognormal` | `ln(x - min + 1)` is normal, truncated to the support | `mu` (0.35 `ln(range + 1)`), `sigma` (`ln(range + 1)` / 6.5) |
| `powerlaw` | density proportional to `y^-alpha` for `y = x - min + 1`, inverse CDF | `alpha` (2) |
| `zipf` | integers; rank `k` has probability proportional to `k^(1-s) - (k+1)^(1-s)`, value `min + k - 1`, inverse CDF | `s` (1.1) |

Only `+ - * /`, `sqrt` and the series in `src/detmath.js` are used (never `Math.exp`/`log`/`pow`/`sin`/`cos`, which engines may round differently), so the output is byte-identical on every runtime.

```js
import { graceholder } from "@johnhenry/graceholder";

const spec = { "videos.views": { gen: { name: "int", args: { min: 0, max: 1000000, dist: "lognormal" } } } };
console.log(graceholder("{ videos(first: 5) { id views } }", { spec, seed: "dist" }).videos.map((v) => v.views));
```

```json
[
  57,
  1526,
  651,
  1829,
  5
]
```

With `distributions: "realistic"` (opt-in, because it changes existing output):

- popularity fields are heavy-tailed integers: `views`, `impressions`, `plays`, `reads`, `clicks`, `likes`, `shares` (lognormal), `followers`, `subscribers`, `stars`, `downloads` (powerlaw) and `sales` (zipf), including `viewCount`, `likeCount`, `totalLikes` and the like. A scalar `followers` or `sales` is a number, not a list of words. Rule `T8` in the decisions.
- a field whose name ends in `history`, `series`, `timeline` or `trend` and that selects an object (`salesHistory { date value }`) is a list (rule `L7`) of 14 to 60 daily points. In its element type, `date`, `day`, `at`, `time`, `timestamp`, `month`, `week` get `series.date` (ascending, the last point is the anchor day) and `value`, `amount`, `count`, `total`, `price`, `balance`, `volume`, `sales`, `revenue`, `views`, ... get `series.value` (rule `T14`): a base level with a linear trend, a weekly/biweekly/monthly seasonal wave and noise, all keyed by the owning entity and field, so a series is the same whatever else is selected.

`series.value` arguments: `base`, `trend` (relative change over the series), `season` (relative amplitude), `period` (days), `noise` (relative), and `min`/`max` bounds.

## Images

`images: "svg"` turns the fields that infer to `imageUrl` (`avatar`, `image`, `photo`, `thumbnail`, `picture`, `logo`, and `...Url` forms) into inline `data:image/svg+xml;charset=utf-8,...` URIs: no network, no clock. Fields named `avatar`, `profile`, `headshot` or `portrait` get initials on a coloured square, taken from the same persona slots as the entity's name (organizations use their company name); everything else gets a geometric placeholder of three to five translucent shapes. The markup uses only `rect`, `circle`, `polygon` and `text` (no scripts, images or external references). The default `"url"` keeps the example URLs.

## Packs

Vocabulary packs add domain data that stays coherent per entity. They are separate modules, so an application ships only the ones it imports, and they are off unless you pass them:

```js
import { graceholder } from "@johnhenry/graceholder";
import { geo } from "@johnhenry/graceholder/packs/geo";
import { finance } from "@johnhenry/graceholder/packs/finance";

const { user } = graceholder("{ user(id: 3) { city state country zip timezone phone iban currency } }", { packs: [geo, finance], seed: "packs" });
console.log(user);
```

```json
{
  "city": "Honolulu",
  "state": "Hawaii",
  "country": "United States",
  "zip": "96813",
  "timezone": "Pacific/Honolulu",
  "phone": "+1 808-555-0129",
  "iban": "PL86295177803152611444814766",
  "currency": "USD"
}
```

`import { allPacks } from "@johnhenry/graceholder/packs"` is every pack. Call `registerPack(geo)` once to refer to a pack by name (`packs: ["geo"]`); an unknown name throws `unknown-pack`. Pack names are global, so a different pack under a used name throws `bad-pack`. When two packs define one generator the later pack in the list wins. Pack rules (inference by field name) are reported as rule `P1` and, like every heuristic, lose to directives and the spec; generator names such as `geo.timezone` or `finance.iban` work in `@gen` and in the spec only while the pack is enabled.

| Pack | Field names it recognises | Coherence |
|---|---|---|
| `geo` (about 110 real cities in 18 countries) | `city`, `state`, `country`, `zip`/`postal*`/`postcode`, `street`, `address`, `phone`/`mobile`, `lat`/`latitude`, `lng`/`lon`/`longitude`, `timezone`/`tz`, `region`, `regionCode`, `countryCode`, `callingCode` | One persona slot picks a city, so region, country, coordinates (within 0.1 degrees of the city), IANA time zone, postal code (the country's format starting with the city's prefix) and phone (country calling code and area code) agree. A nested `address`, `location`, `coordinates` or `geo` type shares its parent's place. US and Canadian numbers use `555-01xx`, GB the Ofcom drama ranges and AU `5550 xxxx`; other countries' numbers are well-formed but not guaranteed unassigned. |
| `commerce` | `category`/`department`, `brand`/`manufacturer`, `sku`, `price`, and the `name` of product-like types | Name = brand + adjective + a noun of the category; the SKU prefix and the price band belong to the category. Brands are invented. `price` bands feed order totals exactly as before (aggregates use the same latent values whatever is selected). |
| `finance` | `iban`, `bic`/`swift`, `cardNumber`, `routingNumber`, `accountNumber`, `accountType`, `transactionType`, `merchant`, `currency`, `currencyName`, `currencySymbol` | IBANs have the right length, character classes and valid ISO 13616 mod-97 check digits for 14 countries; card numbers pass Luhn; routing numbers pass the ABA 3-7-1 checksum; the IBAN country and currency agree, and with `geo` enabled they follow the entity's place. National check parts inside an IBAN (FR, IT, ES) are random. Not for testing against real payment systems. |
| `health` | `condition`/`diagnosis`, `medication`/`drug`, `dosage`, `specialty`, `severity`, `mrn` | **Fictional only.** Invented conditions and medications (`Marmalade Fever`, `Jamzolve`) that each carry a `(fictional)` tag (disable with `tag: false`), record numbers start with `FX-`. Medication and specialty belong to the condition. Not medical information. |

Pack generators: `geo` overrides `place.city`, `place.state`, `place.country`, `place.zip`, `place.street`, `place.address`, `place.lat`, `place.lng` and `person.phone`, and adds `geo.region`, `geo.regionCode`, `geo.countryCode`, `geo.callingCode`, `geo.timezone`. `commerce`: `commerce.category`, `commerce.brand`, `commerce.product`, `commerce.sku`, `commerce.price`. `finance`: `finance.iban`, `finance.bic`, `finance.cardNumber`, `finance.routingNumber`, `finance.accountNumber`, `finance.accountType`, `finance.transactionType`, `finance.merchant`, `finance.currency`, `finance.currencyName`, `finance.currencySymbol`. `health`: `health.condition`, `health.medication`, `health.dosage`, `health.specialty`, `health.severity`, `health.recordNumber`.

Vocabulary is hand-written, checksummed in tests and recorded in `src/packs/PROVENANCE.md`; like every table it is frozen at 1.0.0.

## Schema mode

`graceholder(query, { schema })` (also `inferSchema(query, spec, { schema })`) validates the query against a real schema and takes everything the query cannot say from it. `schema` is SDL text, a parsed SDL document, an introspection result (`{ __schema }` or `{ data: { __schema } }`) or a graphql-js `GraphQLSchema`; the four give identical output.

- **From the schema:** object or scalar, list or single value, type names, nullability, enums (values drawn uniformly), custom scalars (mapped by name: `DateTime`, `Date`, `URL`, `Email`, `UUID`, `BigInt`, ...), arguments with their defaults, Relay connections (recognised on the schema's types), and the possible types of unions and interfaces. Plural names, singularising and the list and type rules are not used.
- **Still from the name:** the generator of a built-in scalar, when its type fits the declared one (`email: String!` is an email, `age: Int!` an age). Otherwise a plain generator of the declared type.
- **Pools:** each object type is one pool, so `user(id: 5)` is the same user everywhere. A field of an interface type can be any implementing type; a union field is one of the members the query names in a fragment (all members if it names none).
- **Non-null:** values are not randomly null, even for nullable fields (as without a schema), and a non-null field is never null. `nullRate` on a non-null field is a conflict.
- **Directives and spec entries must agree with the schema.** A `@list`/`@one` that contradicts the schema, a `@type` naming another type, a `nullRate` on a non-null field, a `@gen` whose output does not fit the declared type, or a `@pick` value that is not in the enum throws `schema-conflict` (also from `inferSchema`).
- **Reporting:** `inferSchema` returns the schema's SDL and decisions with `source: "schema"` (kinds `list`, `type`, `scalar`, `arg`, `nullable`).
- Validation problems (unknown field, missing or mistyped argument, bad enum value) throw `graphql`, as without a schema. An unreadable schema is `bad-schema`.

```js
import { graceholder } from "@johnhenry/graceholder";

const schema = `
  enum Role { ADMIN EDITOR VIEWER }
  type User { id: ID! name: String! role: Role! tags: [String!]! settings: Settings! nickname: String }
  type Settings { theme: String! }
  type Query { user(id: ID!): User! }
`;
const { user } = graceholder("{ user(id: 7) { id role tags settings { theme } } }", { schema, seed: "demo" });
console.log({ id: user.id, role: user.role, tagCount: user.tags.length, settings: Object.keys(user.settings) });
```

```json
{
  "id": "7",
  "role": "VIEWER",
  "tagCount": 3,
  "settings": [
    "theme"
  ]
}
```

## `specFromSamples(query, samples, options?)`

Learns a [side-car spec](#side-car-spec) from real responses, so output looks like a real API without a hand-written spec and without an LLM. `samples` is one response or an array of them (each a response's `data`, or `{ data }`). Response keys (aliases) are read from the samples; the spec is written with field names. The result is a plain object to commit; the function is deterministic and does not depend on the order of the samples. `analyzeSamples` returns `{ spec, notes }`, where `notes` explain what was withheld or left to the heuristics (`kind`: `withheld`, `kept-heuristic`, `skipped`).

| Option | Default | Meaning |
|---|---|---|
| `schema` | none | Schema mode: enums (and their frequencies), nullability, list-ness and `Int` vs `Float` come from the schema. A sample that contradicts the schema is `bad-samples`. |
| `allowValues` | `false` | `true`, or an array of field paths: enum-like sets of strings may be copied into `pick`. See privacy. |
| `maxEnum` | `12` | The most distinct values an enum-like set may have. |
| `anchorDate` | the default anchor | Dates are learned as days before this date. |
| `operationName`, `variables` | none | As for `graceholder`. |

What is learned: list sizes (`count`), null rates (`nullRate`), integer and float ranges and precision (`int`, `float` with `min`, `max`, `decimals`), boolean ratios (`bool` with `p`), date ranges (`datetime` with `minDaysAgo`, `maxDaysAgo`, and `format: "date"` for plain dates), formats (`id.uuid`, `person.email`, `url`, `imageUrl`, `ip`, `hex`, `id.int`, or a `pattern` such as `SKU-####`), enum-like value sets (`pick`, only when permitted), string length ranges (`text`), `list`/`one` where the heuristic guesses the wrong shape, and connection sizes from `totalCount`.

**Privacy.** By default no sample string is copied into the spec: only formats and statistics. Enum-like sets are withheld unless `allowValues` allows them; a schema enum is the exception, because its members are already in the schema. Personal-name generators are never copied from, even with `allowValues`. A constant alphabetic prefix of at most 5 letters directly followed by a digit or separator (`SKU-`, `usr_`) is treated as part of an ID format when at least two distinct values share it.

Fields whose value is an identity or an aggregate (`id`, `xId`, counts of a collection, order totals) and fields a directive already configures are not learned. Dates for `createdAt`, `updatedAt` and similar stay coherent when they already lie in the generator's range. Fields are learned independently; correlations are not.

```js
import { specFromSamples, graceholder } from "@johnhenry/graceholder";

const query = "{ orders { code status amount shippedAt note } }";
const response = { orders: [
  { code: "ORD-1041", status: "shipped", amount: 59.9, shippedAt: "2024-11-02T09:30:00Z", note: null },
  { code: "ORD-1042", status: "pending", amount: 12.5, shippedAt: null, note: "leave at the door" },
  { code: "ORD-1087", status: "shipped", amount: 230, shippedAt: "2024-12-12T16:05:00Z", note: null },
  { code: "ORD-1101", status: "shipped", amount: 19.99, shippedAt: "2024-12-20T08:00:00Z", note: null },
] };

const spec = specFromSamples(query, response);              // no values are copied
const withValues = specFromSamples(query, response, { allowValues: ["orders.status"] });
console.log({ spec, status: withValues["orders.status"], sample: graceholder(query, { spec: withValues, seed: "x" }).orders[0] });
```

```json
{
  "spec": {
    "orders": {
      "count": 4
    },
    "orders.code": {
      "pattern": "ORD-####"
    },
    "orders.amount": {
      "gen": {
        "name": "float",
        "args": {
          "min": 12.5,
          "max": 230,
          "decimals": 2
        }
      }
    },
    "orders.shippedAt": {
      "nullRate": 0.25,
      "gen": {
        "name": "datetime",
        "args": {
          "minDaysAgo": 11,
          "maxDaysAgo": 60
        }
      }
    },
    "orders.note": {
      "nullRate": 0.75,
      "gen": {
        "name": "text",
        "args": {
          "min": 17,
          "max": 17
        }
      }
    }
  },
  "status": {
    "pick": [
      {
        "value": "shipped",
        "weight": 3
      },
      {
        "value": "pending",
        "weight": 1
      }
    ]
  },
  "sample": {
    "code": "ORD-1999",
    "status": "shipped",
    "amount": 184.8,
    "shippedAt": "2024-12-10T20:55:56.211Z",
    "note": null
  }
}
```

## `suggestSpec(query, { llm, spec? })`

An authoring-time helper. `llm` is `(prompt: string) => Promise<string>`. It builds a prompt (`buildSuggestPrompt(query, spec?)`) with the query, the inferred SDL and decisions, the spec grammar and the generator names, parses the reply (a bare JSON object, a fenced block or prose around a JSON object), and validates it: Spec schema, generator names, path syntax, conflicts, and paths that match no field. Pass the `packs`, `distributions` and `images` you generate with so the prompt lists the pack generators and the validation accepts them. On failure it re-prompts once with the problems; then it throws `bad-suggestion` (`hint` lists the problems). The prompt wording is versioned (`SUGGEST_PROMPT_VERSION`) and is not part of the output-stability guarantee. `suggestSpec` is never called by generation.

## Errors

`GraceholderError` has `code`, optional `path` and `hint`, and for GraphQL problems `cause` and `errors`.

| Code | When |
|---|---|
| `graphql` | parse, validation or execution errors from graphql-js |
| `bad-operation` | missing or ambiguous operation, or not a query (a world also runs mutations; subscriptions are never supported) |
| `bad-options` | invalid `anchorDate`, `query`, `llm`, `images`, `distributions` or `packs` |
| `unknown-locale` | locale other than `en` |
| `unknown-directive`, `bad-directive` | not a graceholder directive; malformed directive arguments |
| `unknown-generator`, `bad-generator-args` | unknown name (with hint); `min > max`, bad pattern, ... |
| `bad-spec`, `unused-spec-path` | malformed spec; unused path under `strict` |
| `conflicting-overrides`, `conflicting-shape` | `@list` with `@one`, different values in two places; a field used as both scalar and object |
| `bad-derive` | cycle, self-derive or non-scalar source |
| `bad-cursor`, `bad-arguments` | undecodable cursor; negative or non-integer sizes, `page < 1`, windows over 10000 |
| `bad-mutation`, `not-found` | a world could not read a mutation (unknown verb, no identifying argument, duplicate id); update, delete or pin of a deleted entity |
| `unknown-pack`, `bad-pack` | `packs` names a pack that is not registered; an invalid pack, or a different pack under a used name |
| `bad-suggestion` | `suggestSpec` reply still invalid after the repair round |
| `bad-schema` | the `schema` option is unreadable or invalid, has no query root, or an abstract type has no members |
| `schema-conflict` | a directive or spec entry contradicts the schema (list or single value, `@type`, `nullRate` on a non-null field, a generator whose output does not fit, an enum value that is not declared) |
| `bad-samples` | `specFromSamples`: a sample does not fit the query (or the schema), or no sample was given |
| `unsupported` | several concrete types where one is required |
| `internal` | a bug |

## Stability

`KEY_SCHEME` is `"gh1"`. See [../STABILITY.md](../STABILITY.md).
