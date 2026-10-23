# graceholder design

Status: M0 and M1 implemented; the open questions are resolved (section 15) and implementation decisions are logged in section 16. Package: `@johnhenry/graceholder`. This document replaces the 40-line `mock-ql-sculptor` code on the old `main`.

**Goal:** consistently repeatable generated data, in any shape we want, from a GraphQL query.

Decisions already made: the query alone is the main mode (no schema required); library only (no CLI, server or MSW in v1); ESM + TypeScript types; Node >= 22 and browsers; `graphql` (graphql-js) is the only runtime dependency.

## Contents

1. [Public API](#1-public-api)
2. [Keyed determinism](#2-keyed-determinism)
3. [Entity graph](#3-entity-graph)
4. [Schema inference](#4-schema-inference)
5. [Overrides: directives and side-car spec](#5-overrides-directives-and-side-car-spec)
6. [Personas and coherent records](#6-personas-and-coherent-records)
7. [Generator catalogue (v1)](#7-generator-catalogue-v1)
8. [Execution pipeline](#8-execution-pipeline)
9. [Errors](#9-errors)
10. [`suggestSpec`](#10-suggestspec)
11. [Stability policy](#11-stability-policy)
12. [Prior art](#12-prior-art)
13. [Worked example](#13-worked-example)
14. [Milestones](#14-milestones)
15. [Open questions](#15-open-questions)

---

## 1. Public API

```ts
graceholder(query: string | DocumentNode, options?: Options): ExecutionResult["data"]  // sync
inferSchema(query: string | DocumentNode, spec?: Spec, options?: Pick<Options,"operationName"|"variables">): InferResult
suggestSpec(query: string, opts: { llm: (prompt: string) => Promise<string>; spec?: Spec }): Promise<Spec>

interface Options {
  seed?: string | number;        // default "graceholder"; numbers are stringified (String(n))
  spec?: Spec;                   // side-car spec, see section 5
  variables?: Record<string, unknown>;
  operationName?: string;
  locale?: string;               // default "en"; v1 ships "en" only (open question 1)
  anchorDate?: string | Date;    // default constant "2025-01-01T00:00:00.000Z"
  errors?: "throw" | "result";   // default "throw"; "result" returns {data, errors}
}
interface InferResult { sdl: string; decisions: Decision[]; document: DocumentNode /* directives stripped */ }
interface Decision { path: string; field: string; kind: "list"|"object"|"scalar"|"arg"|"type"|"count"; value: unknown;
                     source: "directive"|"spec"|"heuristic"|"default"; rule?: string }
```

`graceholder()` is synchronous: graphql-js `execute` is sync when no resolver returns a promise, and ours never do. If `errors: "throw"` and execution reports errors, a `GraceholderError` is thrown (section 9). `data` is a plain null-prototype-free JSON-compatible object (no `Date`, `BigInt`; dates are ISO strings).

## 2. Keyed determinism

Every generated value is a pure function of a key. There is **no sequential RNG stream** shared between fields.

```
value = gen( rng( hash64( keyString ) ) )
```

### 2.1 Hash choice: XXH64 (seed 0)

- Well specified, with public reference vectors, 64-bit, fast, no dependencies, and implementable synchronously on 32-bit halves (no `BigInt` needed, but `BigInt` is allowed for the reference implementation). Synchronous matters because `graceholder()` is sync; WebCrypto digests are async, so SHA-256 is out.
- Not cryptographic. Not needed.
- Rejected: `@snaplet/copycat` keyed generators (see 12.2: depends on its own dictionaries and a transitive hash; its output changes across minor versions, which is incompatible with section 11); FNV-1a (poor avalanche on short similar keys such as `User:1`, `User:2`); cyrb53/murmur-ish home-grown variants (not formally specified); MurmurHash3 (fine, but XXH64 has a bigger test-vector corpus and a 64-bit native output).
- The implementation ships the XXH64 reference test vectors as unit tests. We freeze XXH64 as published; any bug-for-bug deviation is a bug.

### 2.2 Key string (frozen at 1.0.0)

Components are joined with the byte `0x1F` (unit separator) and encoded as UTF-8. No escaping is needed because components may not contain `0x1F`; if user-provided text contains it, it is replaced with `0xFFFD` before joining.

```
keyString = join(0x1F, [ "gh1", seed, scope, typeName, entityKey, fieldName, ...subKeys ])
```

| Component | Value |
|---|---|
| `"gh1"` | Key-scheme version literal. Bumped only with a new major version. |
| `seed` | `String(options.seed ?? "graceholder")`, or the `@seed("s")` override in effect (inner wins, see 5.3). |
| `scope` | `"e"` for entity-owned values, `"l"` for list/collection structure (count, windowing), `"p"` for persona values, `"a"` for anonymous (non-entity) values. |
| `typeName` | Resolved GraphQL type name (after `@type`/spec unification), e.g. `User`. |
| `entityKey` | Canonical entity key (section 3.1), or for anonymous values the *path key* (section 3.4). |
| `fieldName` | The schema field name, **never the alias**. For persona values, the persona slot name (e.g. `first`). |
| `subKeys` | Optional extra components: array index (decimal), generator-call ordinal (decimal, for generators that need several draws, starting `0`), etc. |

Properties that follow: renaming an alias, reordering fields, adding or removing sibling fields, adding fragments, or changing unrelated variables never changes another value. Changing the `seed`, a type name, an entity key or a field name does.

### 2.3 From hash to randomness

`h = XXH64(utf8(keyString))` gives a 64-bit unsigned integer. Draws come from a **SplitMix64** sequence started at state `h`; draw `n` (0-based) is `splitmix64_next` applied `n+1` times. This stream is local to one `(key)` and is consumed only by that value's generator, so it is not a shared stream. Helpers (frozen):

| Helper | Definition |
|---|---|
| `u64()` | next SplitMix64 output of the stream |
| `float()` | `Number(u64() >> 11n) / 2**53`, in `[0,1)` |
| `int(lo, hi)` | Inclusive and unbiased. With `range = hi - lo + 1` and `limit = 2^64 - (2^64 mod range)`, draw u64 values until one is `< limit`, then return `lo + (draw mod range)`. At least one draw is always consumed, even for `lo == hi`. Bounds must be safe integers and `range <= 2^53`. (Hub decision: no modulo bias.) |
| `pick(arr)` | `arr[int(0, arr.length-1)]` |
| `weighted([[v,w],...])` | cumulative weights over `float() * totalWeight` |
| `bool(p)` | `float() < p` |

The implementation is a local **stream** over the SplitMix64 sequence: each helper call consumes the next draw(s). A generator's output is therefore a pure function of its key and of the order of its own helper calls. `u64(n)` in earlier drafts is the n-th draw of this stream.

Derived keys: `sub(key, name)` = the same key string with `name` appended as an extra `subKey`; used by generators that need independent sub-values.

## 3. Entity graph

### 3.1 Entity identity

An *entity* is an object-typed value with a stable identity `(typeName, entityKey)`. Fields of an entity are always generated under scope `"e"` with that identity, so the same entity is identical wherever it appears.

`entityKey` derivation, in order:

1. **Identifying argument.** An argument named `id`, `ids` (per element), `key`, `slug`, `uuid`, `email`, `username`, `handle` or `sku` on a single-object field selects the entity: `entityKey = String(value)` (JSON-canonical for non-strings). `user(id: 5)` is always `User:5`. Spec/directive can name other identifying args (`{key: ["orgId","userId"]}`; composite keys are joined with `0x1E`).
2. **Explicit `id` field value.** For list members, the key is the member's ordinal within its collection (3.2) unless the collection is argument-selected.
3. **Position.** Otherwise the key is the *path key* (3.4) for singular fields, and the window ordinal for list members.

If the selection includes `id`, its value is `entityKey` coerced to the inferred `id` type (see inference: `ID`/`Int`/`String` per the field heuristics; default `ID`, rendered as decimal string for numeric keys, e.g. `"42"`). That keeps `id` consistent with identity, and an object reached through two paths with the same type and key is the same entity.

### 3.2 Pools and the "endless collection"

Every object type has a **pool**: an endless sequence of entities with keys `1, 2, 3, ...` (decimal). A list field of type `T` is a **window** onto the collection `(parentIdentity, fieldName, args-except-paging)` of `T`:

- Collection membership is *derived by key*, not stored.
- Rule E1: a list is **shared** (members come from the type pool; member `i` has key `String(i)`) when its collection is top-level (child of `Query`), or when `@type`/spec unified its element type with a type that has a top-level collection. Otherwise it is **owned**: members have key `"<parentKey>.<fieldName>.<i>"`.
- Rule E2: a singular object field with no identifying argument is a *reference into the type pool*: key = `String(int(h, 1, poolSize))`, `poolSize` default 100 (`$options.poolSize`), with `h` drawn from key `("l", parentType, parentKey, fieldName)`. Top-level singular fields with no identifying argument use key `1`. So `post.author` typed `User` is one of `User:1..100`, stable, and equal to `user(id: 7)` when it lands on 7.

**Decision for v1 (follows the brief):** same type name + same key = same entity. Inferred object types of the same name share the type pool (`post.author` and `comment.author` both inferred as `Author` draw from `Author:1..poolSize`). `inferSchema` reports each sharing decision (`rule: "E2-shared"`). Open question 2 asks whether the default should instead be owned.

### 3.3 Collection size and windowing

- Count of a collection: `n = int(draw0 of key("l", parentType, parentKey, fieldName, argsKey), 3, 10)` unless `@count`/spec/`first`/`limit` says otherwise (see inference). The count is the **total** available (`totalCount`), not the window size.
- A window `[start, start+size)` is taken out of an endless sequence **if no total is declared** (`@count` absent and the collection is paged), else out of `[1..n]`.
- `argsKey` = canonical JSON of the arguments **excluding** paging arguments (`first`, `last`, `after`, `before`, `offset`, `limit`, `skip`, `take`, `page`, `pageSize`, `cursor`), keys sorted. Filtering args (e.g. `status: "OPEN"`) therefore select *different* collections; paging args select windows of the same collection.

### 3.4 Paging

Window selection from paging arguments (whichever are present):

| Style | Args | Window |
|---|---|---|
| offset | `offset`/`skip`, `limit`/`take` | start `offset+1`, size `limit` |
| page | `page` (1-based), `pageSize`/`perPage` | start `(page-1)*pageSize+1` |
| relay forward | `first`, `after` | start `decode(after)+1`, size `first` |
| relay backward | `last`, `before` | the `last` items ending before `decode(before)`; if no `before`, the last `last` items of the total (requires a total: collection gets a finite `n`) |

Relay connections are detected structurally: a field whose selection contains `edges { node }` and/or `pageInfo`, or whose return type name ends in `Connection`. They are executed against an inferred `XConnection { edges: [XEdge!]!, pageInfo: PageInfo!, nodes: [X!]!, totalCount: Int! }` with `XEdge { cursor: String!, node: X! }`. Cursor for item `i` is `base64url("gc1:" + i)`; `after` decodes it (an undecodable cursor is an error). `pageInfo.hasNextPage` is true while `i < total`; with no declared total the collection is endless, so `hasNextPage` is always true (a collection with `@count` or a spec `count` gets a real end). `startCursor/endCursor` are the first/last returned cursors. `totalCount`: the declared/derived total `n`, or `1000` (spec `endlessTotal`, default) for endless connections.

Default size when no paging arg: the total `n` (3-10). Plain (non-connection) lists with paging args and no declared count are endless windows.

### 3.5 Path key

For *anonymous* values (no entity identity, e.g. a scalar field of a non-entity object such as `address.city` inside a singular, owned value), the entityKey is the parent's entityKey, which is already stable. A path key is only used for root fields: `"Query"`. Aliases are never part of any key. Two aliased uses of the same field with the same arguments therefore return the same value; different arguments on the same field name select different collections/entities (arguments participate in `argsKey`), which is exactly the GraphQL semantic.

## 4. Schema inference

`inferSchema` walks the selection sets of the chosen operation (and fragments reachable from it, with variables resolved), merges all occurrences of the same `(parentType, fieldName)`, and emits SDL.

### 4.1 Pipeline

1. Parse (graphql-js `parse`), pick operation by `operationName` (error if ambiguous).
2. Extract directives into per-field overrides; strip them from the document (graphql-js would reject unknown directives in validation). Unknown directive name starting with a registered graceholder directive is handled; anything else is an error (section 9).
3. Walk and infer types. Fields are visited with their parent type; sibling merges use the same `(parentType, fieldName)`.
4. Apply the side-car spec by path (section 5) with precedence.
5. Emit SDL + `decisions`, then build the executable schema (`buildSchema`) with generated resolvers (section 8).

### 4.2 Rules table

Evaluated top to bottom; first matching rule wins. "Name" is the *field* name (not alias), matched case-insensitively against the tokenised name (camelCase/snake_case split into lowercase words).

**Shape (object / list / scalar):**

| # | Rule | Result |
|---|---|---|
| S1 | Field has a selection set | object (or list of object, see L rules) |
| S2 | Field has no selection set | scalar (T rules) |
| S3 | Selection contains `edges`/`pageInfo`/`nodes` + `totalCount` pattern | Relay connection |
| S4 | Selection contains `... on X` with more than one distinct `X` | union by default (`interface` if the field's type is declared by the spec or the fields outside the inline fragments are non-empty; see 4.4) |

**List vs. one (for object and scalar fields):**

| # | Rule | Result |
|---|---|---|
| L1 | Directive/spec `@list`/`@one`/`list`/`one` | as given |
| L2 | Has paging argument (`first`, `last`, `limit`, `offset`, `skip`, `take`, `page`, `after`) | list (or connection if S3) |
| L3 | Last word of name is plural (ends `s` but not `ss`/`us`/`is`, or is an irregular plural: `people`, `children`, `men`, `women`, `mice`; `data` is singular) | list |
| L4 | Name is `items`, `nodes`, `edges`, `results`, `list`, `all*` | list |
| L5 | Has an argument named `ids` or an argument of list literal type (`[..]`) | list |
| L6 | Otherwise | one |

Scalars follow L1, L3-L5 too: `tags` and `emails` are lists of `String`.

**Type name (object types):**

| # | Rule | Result |
|---|---|---|
| N1 | `@type("X")` / spec `type` | `X` |
| N2 | `... on X` inline fragments / named-fragment type conditions applied directly to this field's selection | `X` (intersection: if the type condition is on the field itself and not a union, the type is X) |
| N3 | Otherwise: singularize last word (rules below) of the field name, then PascalCase | e.g. `blogPosts` -> `BlogPost`, `addresses` -> `Address`, `people` -> `Person`, `author` -> `Author` |
| N4 | Collision: two fields infer the same name but have different field sets | They are merged (same type name = same type), the union of fields |
| N5 | Name collides with a built-in scalar or `Query` | suffix `Type` |

Singularize (frozen, small, no dependency), applied to the last word of the tokenised name, first match wins: (1) irregular table: `people->person`, `men->man`, `women->woman`, `children->child`, `mice->mouse`, `feet->foot`, `teeth->tooth`, `geese->goose`, `analyses->analysis`, `indices->index`, `criteria->criterion`, `knives->knife`, `wives->wife`, `leaves->leaf`, `lives->life`, `shelves->shelf`, `wolves->wolf`; `data` is treated as singular and unchanged; (2) `ies -> y` unless preceded by a vowel (`stories->story`, `movies->movie`); (3) `(s|x|z|ch|sh)es -> $1` (`boxes->box`, `addresses->address`, `watches->watch`); (4) endings `ss`, `us`, `is` unchanged; (5) trailing `s` removed. The rules live in one frozen module and are covered by golden tests.

**Count (lists):**

| # | Rule | Result |
|---|---|---|
| C1 | `@count`/spec `count` (`n` or `[min,max]`) | as given; `n` fixed, range -> `int(key, min, max)` |
| C2 | `first`/`limit`/`take`/`pageSize` argument with a literal or variable value | that many (see paging) |
| C3 | Otherwise | `int(key, 3, 10)` from the collection key (3.3) |

**Scalar type and generator by name.** Tokenise the field name into words (`createdAt` -> `created at`). The first matching row wins. A `Generator` column is the generator used (section 7); the GraphQL scalar is the SDL type.

| # | Name matches (tokens / pattern) | SDL type | Generator |
|---|---|---|---|
| T1 | exactly `id`, or ends with word `id` (`userId`) | `ID` | `id` (the entity key; for `xId` pointing at a pool: an integer key in `1..poolSize`) |
| T2 | `__typename` | handled by graphql-js | - |
| T3 | `email`, ends `email`/`mail` | `String` | `email` (persona-derived) |
| T4 | `url`, `uri`, `link`, `website`, `homepage`, ends `url` | `String` | `url` |
| T5 | `avatar`, `image`, `photo`, `thumbnail`, `picture`, `logo` (+`url`) | `String` | `imageUrl` |
| T6 | `phone`, `mobile`, `tel` | `String` | `phone` |
| T7 | starts `is`/`has`/`can`/`should`/`was`/`did`/`allow*`, or ends `enabled`/`active`/`verified`/`public`/`deleted`/`archived`, or `flag` | `Boolean` | `bool` |
| T8 | ends word `count`/`total`/`qty`/`quantity`/`num`/`number of`/`age`/`year`/`index`/`position`/`rank`/`level`/`size`/`length`/`views`/`likes`/`votes` | `Int` | `int` with per-name range table (frozen) |
| T9 | `price`, `cost`, `amount`, `total`, `subtotal`, `tax`, `fee`, `balance`, `salary`, `revenue`, `rate`, `ratio`, `score`, `rating`, `weight`, `height`, `lat`, `lng`, `latitude`, `longitude`, `percent` | `Float` | `money` / `float` with range table |
| T10 | ends `at`/`date`/`time`/`timestamp`, `createdAt`, `updatedAt`, `deletedAt`, `birthday`, `dob` | `String` (ISO-8601 `DateTime` scalar; SDL `scalar DateTime`) | `datetime` (coherent ordering, section 6) |
| T11 | `firstName`, `lastName`, `fullName`, `name` (on a person-like type, see 6.1), `username`, `handle`, `nickname`, `title`/`jobTitle` (by type), `company`, `organization`, `city`, `state`, `country`, `zip`, `postal*`, `street`, `address` (scalar), `bio`, `description`, `summary`, `body`, `content`, `text`, `comment`, `message`, `slug`, `status`, `role`, `color`, `currency`, `locale`, `language`, `uuid`, `ip`, `sku`, `token` | `String` | per-name generator from the catalogue (e.g. `name`, `username`, `city`, `sentence`, `paragraph`, `slug`, `oneOf` from the status/role vocab, `uuid`) |
| T12 | Argument-driven: field has an argument literal of Int/Float/Boolean/String that is the only hint | type by literal | n/a (only for `arg` inference, 4.3) |
| T13 | Otherwise | `String` | `word`/`sentence` (`words(2)`) |

Ambiguity notes (frozen): `total` appears in both T8 (count-like) and T9 (money); precedence is the table order but a type context overrides: inside an object type whose name includes `Order|Invoice|Cart|Payment|Receipt` a `total` is `Float` money. `name` on a type named `Company|Organization|Org|Team|Product|Brand|Project|Store|Shop` uses a company/product generator; otherwise a person full name. These contextual rules are enumerated in the test list.

### 4.3 Argument and variable types

Argument types are inferred from usage: a literal gives `Int`/`Float`/`String`/`Boolean`/list/input object; a variable uses its declared type in the operation. Input objects are emitted as `input <Field><Arg>Input`. Arguments are never validated for semantics, only used for identity/paging/filtering (3.1, 3.3, 3.4).

### 4.4 Unions and interfaces

`... on X` fragments on a field define possible types. A field with `... on A`, `... on B` and no common concrete selection becomes `union <Name>Union = A | B`. If fields are selected outside the inline fragments, they become an `interface <Name>` with those fields and A, B implement it. The concrete type of an entity is chosen by `pick(hash(key("e", ifaceName, entityKey, "__typename")), possibleTypes)` unless weighted by spec/`@pick`. `__typename` is always the resolved concrete type.

### 4.5 Output SDL conventions

- Fields: object/list fields are nullable by default only if `@nullRate` > 0 (then nullable), otherwise non-null (`T!` and `[T!]!`), since mock data should not randomly be null.
- Scalars: `DateTime` is emitted as `scalar DateTime` with a pass-through serializer.
- Stable ordering: types in order of first appearance in the document; fields in order of first appearance.

## 5. Overrides: directives and side-car spec

### 5.1 Inline directives

All directives are removed (the document is rewritten) before validation and execution. They may appear on fields (and `@seed` on the operation).

| Directive | Meaning |
|---|---|
| `@list` / `@one` | force list / singular |
| `@count(n: 5)` / `@count(min: 2, max: 8)` | collection size / range |
| `@gen(name: "name.first", ...args)` | named generator with args (catalogue), arbitrary extra args become the `args` object |
| `@pattern(p: "ORD-#####")` | pattern string: `#` digit, `?` lowercase letter, `A` uppercase letter, `*` alphanumeric, `\` escapes |
| `@pick(values: [...])` | pick from a fixed set (weights via `{value,weight}` objects) |
| `@nullRate(p: 0.2)` | probability of `null` (field becomes nullable) |
| `@derive(from: "firstName")` | derive from another field of the same entity (see 6.3 for forms: a field name, or `"upper(name)"`-style expressions are NOT supported in v1) |
| `@type(name: "User")` | set/unify the type name (shares the pool) |
| `@seed(s: "x")` | override the seed for this subtree (inner overrides outer) |

The brief writes `@gen(name, ...args)`: concrete syntax is `@gen(name: "number.int", min: 1, max: 5)`. A single positional-like shorthand `@pick(["a","b"])` is not valid GraphQL, so the argument is named `values`. Also `@type(name: "User")` and `@pattern(p: "...")`.

### 5.2 Side-car spec

```ts
type Spec = Record<string /* path pattern */, FieldSpec> & { $options?: { poolSize?: number; endlessTotal?: number } };
interface FieldSpec {
  list?: boolean; one?: boolean;               // shape
  count?: number | [number, number] | { min: number; max: number };
  gen?: string | { name: string; args?: Record<string, unknown> };
  pattern?: string; pick?: Array<unknown | { value: unknown; weight: number }>;
  nullRate?: number; derive?: { from: string };
  type?: string; seed?: string | number;
  key?: string | string[];                      // identifying arguments
  shared?: boolean;
}
```

**Path grammar.** A path is dot-separated field names from the operation root, using **schema field names, not aliases**, optionally prefixed by an operation-type-free root (the first segment is the root field). Segments: a literal name; `*` (exactly one segment); `**` (zero or more segments). A pattern is anchored at the root unless it starts with `**`. A bare `"*.status"` matches `status` on any root field's child. Matching is on field names only (list-ness is not part of the path). Type-scoped keys are also supported: `"@User.email"` matches field `email` on type `User` wherever it appears (resolved after inference).

Examples: `"users"`, `"users.author"`, `"*.status"`, `"**.createdAt"`, `"@User.email"`.

### 5.3 Precedence (highest wins), per property

1. Inline directive on that exact field.
2. Spec entry, most specific first: exact path > path with `*` > path with `**`; tie broken by longer literal prefix then by later declaration order; `@Type.field` rank equals an exact path but loses to the exact path match when both apply.
3. Heuristic inference (section 4).
4. Defaults.

Properties merge independently: a directive `@count` and a spec `gen` for the same field both apply. `@seed` is the exception: the innermost seed in effect wins (directive on a descendant overrides ancestors, which override spec, which overrides options). Conflicts within the same level (`list` and `one` both set) are an error.

## 6. Personas and coherent records

### 6.1 Persona model

On first access of any field of an entity, a **persona** is computed for the `(typeName, entityKey)`; it is a set of named slots, each generated under scope `"p"` with its own keyed hash (`slot` is the fieldName component), so adding a slot never changes existing ones. The persona kind depends on the type name (frozen table, word match on tokens of the type name; first match wins):

| Kind | Type name tokens | Slots |
|---|---|---|
| `person` | user, person, customer, author, member, employee, contact, account, profile, owner, student, patient, driver, guest, reviewer, commenter, friend, follower, manager, admin | `first`, `last`, `middle?`, `username`, `domain`, `emailLocalStyle`, `birthYear`, `createdAt`, `updatedAt`, `phoneArea`, `city`, `state`, `country`, `zip`, `bioSeed`, `avatarSeed` |
| `org` | company, organization, org, team, brand, vendor, store, shop, employer | `name`, `domain`, `foundedYear`, `industry`, ... |
| `product` | product, item (inside order-like parents), sku, listing | `name`, `price`, `sku`, `category` |
| `post` | post, article, comment, message, review, note, story | `title`, `body`, `createdAt`, `updatedAt` |
| `order` | order, invoice, cart, payment | `createdAt`, `updatedAt`, totals |
| `generic` | anything else | `name`, `createdAt`, `updatedAt` |

### 6.2 Derived fields (frozen derivations)

| Field | Derivation |
|---|---|
| `firstName`, `lastName`, `fullName`, `name` (person) | persona `first`/`last`; `fullName = first + " " + last` |
| `username`/`handle` | `lower(first[0] + last)` or `lower(first) + "." + lower(last)` or `lower(first) + birthYear%100` (style slot, picked once per entity) |
| `email` | `<local style from the persona>@<persona domain>`; domain is either a vocab free-mail domain (weighted) or, for entities with an `org` link, the org domain; characters ASCII-folded |
| `createdAt`, `updatedAt`, `deletedAt`, `publishedAt` | `createdAt = anchorDate - offsetDays(persona)` with offset in `[30, 1500]` days; `updatedAt = createdAt + int(0, days since createdAt)` and always `<= anchorDate`; `deletedAt >= updatedAt`, and `<= anchorDate` (non-null only if `@nullRate`/spec allows it; default null rate for `deletedAt` is 1.0, i.e. null) |
| `birthday`/`dob` | `birthYear` persona slot, consistent with `age` fields if present: `age = anchorYear - birthYear` (adjusted by month/day) |
| `subtotal`/`total`/`tax` | `total = subtotal + tax` where `subtotal = sum(items[].price * quantity)` if the order has an `items` selection (then each item is a keyed owned entity; the sum is computed over the *full* collection of the order's items, not the window shown, so totals are paging-independent); else a keyed amount. Two-decimal rounding by integer cents. |
| `<x>Count` / `total<X>` where `<x>` is a list sibling | equals the collection total (`n`) |
| `price` | cents-based integer then `/100` (two decimals, `.99`/`.49`/`.00` endings weighted) |
| `city/state/country/zip` | one persona location slot (a row from the vendored `places` table) so they're mutually coherent |

### 6.3 `@derive(from:)`

Takes the name of another field on the same entity; the value is that field's generated value fed through a **derivation by target field's inferred kind**: string->string identity-ish transformations are limited in v1 to `slug`, `username`, `email` (if the target generator is one of them), otherwise copy. Cycles are an error. This is needed for fields whose name heuristics cannot see the persona.

### 6.4 `anchorDate` and `locale`

- `anchorDate`: ISO string or `Date`; default the constant `"2025-01-01T00:00:00.000Z"`. `new Date()` / `Date.now()` is never read in the library (lint rule, enforced by a CI grep + test with a faked clock).
- `locale`: selects the vendored vocabulary bundle (names, places, words). v1 ships `en` only; other values throw `GraceholderError(code: "unknown-locale")` rather than silently falling back. Locale is **not** part of the key string; vocabularies are indexed by position, so each locale bundle is a separate set of tables (output differs by locale, by design). The locale tag is recorded in the golden-file header.

## 7. Generator catalogue (v1)

Generators are pure: `(ctx) => value`, with `ctx = { draw(n), key, persona, anchorDate, args, sub(name) }`. Referenced by `@gen(name: ...)` and spec `gen`. Names use dotted categories; unknown names are an error with a "did you mean" suggestion.

| Group | Names |
|---|---|
| ids | `id.key` (entity key), `id.uuid` (v4-shaped from draws), `id.int` (min,max), `id.ulid` (time part from anchor) |
| number | `int` (`min`,`max`), `float` (`min`,`max`,`decimals`), `money` (`min`,`max`), `percent`, `bool` (`p`) |
| text | `word`, `words` (`n`), `sentence`, `sentences`, `paragraph`, `title`, `slug`, `lorem` |
| person | `person.first`, `person.last`, `person.full`, `person.username`, `person.email`, `person.phone`, `person.jobTitle`, `person.bio` |
| org | `company.name`, `company.domain`, `company.industry` |
| place | `place.city`, `place.state`, `place.country`, `place.zip`, `place.street`, `place.lat`, `place.lng` |
| web | `url`, `imageUrl` (`placeholder` style, deterministic, no network), `ip`, `hex`, `color` |
| time | `datetime`, `date`, `past`, `future`, `between` (`from`,`to`) all relative to `anchorDate` |
| choice | `oneOf` (`values`), `weighted`, `enum` (inside a spec), `pattern` |
| structure | `null`, `const` (`value`), `derive` |

Every generator's output for a given draw sequence and vocabulary is frozen at 1.0.0 (section 11). `datetime` returns an ISO string with `Z` and milliseconds; `float` values are rounded to `decimals` (default 2) via integer scaling.

### 7.1 Vocabularies: vendored, not depended on

- First/last names, cities/states/countries/zip prefixes, domains, job titles, industries, product nouns, lorem words, status/role vocab: small curated JSON tables **vendored into the repo** (`src/vocab/en/*.ts`), order-frozen, with SHA-256 checksums asserted in a test. Sizes are modest (~500 names each, ~200 places, ~1500 words): all original or public-domain/CC0 data (US Census name lists are public domain; place data from public domain sources; lorem words are the classical ipsum list). Provenance and licence recorded in `src/vocab/PROVENANCE.md`.
- Vocabulary tables are not append-only: `pick` maps by index and length. Appending would change the index mapping, so tables are frozen at 1.0.0 and any edit is an output change.
- Why not `@faker-js/faker` or `@snaplet/copycat` as a runtime dependency: their dictionaries change in minor versions, they are large (browser bundle size), and their determinism is by their own design, not ours. We can still use them as *authoring-time* sources to generate our vendored tables (a one-off script, not a dependency).

## 8. Execution pipeline

```
parse -> pick operation -> strip directives & collect overrides -> infer (shapes, types, decisions)
      -> apply spec -> buildSchema(SDL) -> attach resolvers -> graphql-js execute -> data
```

- One shared `buildSchema` + resolver map per call. Resolvers are `(source, args, ctx, info)`; `source` for an entity carries `{ typeName, entityKey, persona }` and for roots is `{}`.
- Default field resolver: scalar -> generator by decision; object -> entity ref; list -> window of refs; union/interface -> `resolveType` via the keyed pick; connection -> synthesized edges/pageInfo.
- Custom scalar `DateTime`; no other custom scalars in v1 (JSON-ish fields are objects by selection).
- Fragments, aliases, variables, `@skip`/`@include`, `__typename` and introspection are graphql-js's job; we only need our key rules to ignore aliases and use resolved argument values (variables substituted via `info`/`args`).
- Nothing in execution reads a clock, `Math.random`, environment, or locale of the host. A CI test greps for these tokens in `src/`.
- Caching: persona/entity values may be memoised **per call**; no cross-call state (so repeated calls are trivially identical).

## 9. Errors

`GraceholderError extends Error` with `code`, `path` (spec/field path where relevant), and `hint`.

| Condition | Code | Behaviour |
|---|---|---|
| Unknown inline directive (not graceholder's, not `@skip`/`@include`) | `unknown-directive` | throw at inference; hint lists known directives and a nearest-match suggestion |
| Unknown generator name | `unknown-generator` | throw with "did you mean" |
| Generator arg type/range error (`min>max`, bad pattern) | `bad-generator-args` | throw |
| Spec key matches no field in the operation | `unused-spec-path` | **warning by default** (collected in `decisions` as `unused`; `strict: true` option turns it into an error) |
| Conflicting directives (`@list` + `@one`) | `conflicting-overrides` | throw |
| `@derive` cycle or unknown source | `bad-derive` | throw |
| Invalid cursor | `bad-cursor` | throw |
| Unknown locale | `unknown-locale` | throw |
| Ambiguous/missing operation | `bad-operation` | throw |
| graphql-js parse/validation/execution errors | `graphql` | throw wrapping the originals in `cause`; with `errors:"result"` returned as `{data, errors}` |
| `suggestSpec` LLM output unparseable / violates spec schema | `bad-suggestion` | reject (no partial specs) |

## 10. `suggestSpec`

`suggestSpec(query, { llm, spec? })` is an **authoring-time helper**, never called by generation. The core imports no LLM SDK; `llm` is `(prompt: string) => Promise<string>`. It:

1. Runs `inferSchema(query, spec)` and builds a prompt containing the query, the inferred SDL, the decisions, the spec grammar, the generator catalogue names and the instruction to return only a JSON `Spec` containing overrides where heuristics are probably wrong.
2. Parses the response JSON (tolerating a fenced code block), validates it against the Spec schema and checks all generator names, path syntax and directive args; one repair round is offered by re-prompting with the validation errors; otherwise `bad-suggestion`.
3. Returns the validated `Spec`. Users commit it to the repo; `graceholder()` with that spec is deterministic.

The prompt template is versioned and exported; its wording is not part of the output-stability guarantee (it never affects generated data).

## 11. Stability policy

**Guarantee:** same `seed` + same query + same `spec` + same options + same package version => byte-identical output (`JSON.stringify` equality), on every supported runtime (Node >= 22, evergreen browsers). Across versions: within a major version, output for a given input never changes.

**What counts as an output change (needs a major bump):**
- the key scheme (`gh1` literal, separator, component set or order), hash, RNG, helper formulas (`int`, `pick`, etc.);
- any generator's value for the same draws; generator catalogue *semantics* changes;
- any vocabulary table edit, reorder or locale default change;
- inference rules: shape, type-name, count, scalar-type or generator selection for a previously inferred case; the singularizer; persona table; derivation formulas; paging and cursor formats; `anchorDate` default;
- changes to how directives/spec properties resolve (precedence).

**Not output changes (minor/patch):** new generators, new directives or spec properties, new locales, error-message wording, performance, types, docs and the `suggestSpec` prompt. (newly recognised name heuristics are output changes, even for names that currently fall through to `T13`). Only strictly additive features that cannot affect existing inputs qualify.

**Enforcement:**
- Golden files: `test/golden/*.json` (input query + spec + options + expected output). CI runs them on Node 22 and the current LTS, and in a browser-like runner (Node with `--experimental-vm-modules` jsdom-free check is enough; plus a Playwright smoke in M5). A PR that changes a golden file requires the `breaking` label and a changeset marked major; a CI script fails otherwise.
- The XXH64/SplitMix64 vectors and vocabulary SHA-256 checksums are asserted separately.
- Dependency policy: the only runtime dependency is `graphql` (peer range `^16`, tested on 16 and 17-alpha if available). graphql-js affects execution semantics, not values, and the golden tests would catch any change. Everything affecting values (hash, RNG, vocab) is in-repo. `devDependencies` are free to float.
- A `STABILITY.md` generated from this section ships with the package; the key-scheme version literal `gh1` is exported as `KEY_SCHEME`.

## 12. Prior art

### 12.1 `@graphql-tools/mock` (`MockStore`)

Needs a schema; the query-alone mode is the headline use case here, so it cannot be the front door. Reusable ideas: a store keyed by `(type, key)` giving entity identity; `Query`-level fields with `id` args keyed into the store; connection-style helpers. Not reused because: (a) it is built around a **schema-first** `addMocksToSchema`; inferring a schema from a query then feeding it in is possible but we would still own all determinism, since its default mocks use `Math.random` unless seeded and a sequential seeded stream is order dependent (the thing pillar 1 rules out); (b) its list lengths are fixed at 2 by default; (c) it adds `@graphql-tools/*` dependencies. We do borrow the **store concept** (a per-call memo of entities), implemented with keyed derivation instead of a mutable store.

### 12.2 `@snaplet/copycat`

The old code used it; it is deterministic-by-input (hashing a key into a value), which is the right idea, and we adopt the idea. We do not depend on it: (a) output stability across its versions is not guaranteed by the project (dictionary and algorithm changes in minors); (b) it pulls a large dictionary footprint; (c) its API shape is "one function per datatype with a free-form input", while we need coherent persona-derived fields and our own frozen key scheme. Because our key derivation is explicit and ours, we can freeze it. Existing vocabulary *content* can be mined from public sources at authoring time (7.1).

### 12.3 faker

`@faker-js/faker` with `faker.seed()` is sequential: the value of field `n` depends on how many draws came before it, so reordering fields changes everything; its datasets also change between releases (their changelogs list seeded-output changes). Not used at runtime. Useful as a reference for category naming (we mirror its dotted names where sensible so `@gen(name: "person.firstName")`-style guesses work) and for authoring-time vocabulary sourcing (licence permitting).

### 12.4 Others considered

`graphql-faker` (SDL directives, needs schema, server oriented), `casual`/`chance` (sequential seeded streams), `json-schema-faker` (schema-first). None gives keyed determinism with query-alone inference.

## 13. Worked example

Query:

```graphql
query Feed($first: Int = 3) {
  me: user(id: 5) { id fullName email createdAt updatedAt }
  posts(first: $first, after: "Z2MxOjI") {
    id
    title
    status
    author { firstName email }
    commentCount
    tags
  }
  orders @count(min: 2, max: 4) {
    code
    items { name price quantity }
    subtotal
    total
  }
}
```

Spec:

```json
{
  "orders.code":  { "pattern": "ORD-#####" },
  "posts.author": { "type": "User" },
  "*.status":     { "pick": ["draft", "published", "archived"] },
  "tags":         { "count": [1, 3] }
}
```

Note: the `after` cursor above is `base64url("gc1:2")`; `Z2MxOjI` is exactly the base64url (unpadded) of `gc1:2`.

Inferred SDL (abridged; `inferSchema(query, spec).sdl`):

```graphql
scalar DateTime

type Query {
  user(id: Int!): User!
  posts(first: Int, after: String): [Post!]!
  orders: [Order!]!
}
type User { id: ID! fullName: String! email: String! createdAt: DateTime! updatedAt: DateTime! firstName: String! }
type Post { id: ID! title: String! status: String! author: User! commentCount: Int! tags: [String!]! }
type Order { code: String! items: [Item!]! subtotal: Float! total: Float! }
type Item { name: String! price: Float! quantity: Int! }
```

(`user(id:)` argument typing is by literal: `5` -> `Int`; with `me: user(id: "5")` it would be `String`.)

Decisions (excerpt): `posts` list (L2 paging arg; L3 plural), `posts.author` -> `User` (spec, `source:"spec"`, shared pool), `orders` count 2..4 (directive), `commentCount` Int (T8), `status` pick (spec `*.status`), `total` Float (contextual order rule), `tags` list of String (L3), count 1..3 (spec).

Output shape (values illustrative; real values are frozen by golden files once implemented):

```json
{
  "me": { "id": "5", "fullName": "Dana Whitfield", "email": "dana.whitfield@example.org",
          "createdAt": "2023-08-14T09:12:44.000Z", "updatedAt": "2024-05-02T17:30:09.000Z" },
  "posts": [
    { "id": "3", "title": "…", "status": "published",
      "author": { "firstName": "Dana", "email": "dana.whitfield@example.org" },
      "commentCount": 12, "tags": ["…", "…"] }
  ],
  "orders": [
    { "code": "ORD-48213",
      "items": [ { "name": "…", "price": 19.99, "quantity": 2 } ],
      "subtotal": 39.98, "total": 43.18 }
  ]
}
```

Properties demonstrated: `posts` starts at member 3 (after cursor 2) and with `first: 3` returns 3 items (ids 3,4,5); fetching the next page with `after` = cursor of id 5 continues at 6 with no gaps or overlaps; if some `post.author` resolves to `User:5` it equals `me` field-for-field (same `fullName` and `email`); adding `createdAt` to `posts` or reordering any fields changes no existing value; `updatedAt >= createdAt`; `subtotal` equals the sum of `price*quantity` of the order's items, and `total = subtotal + tax` (tax not selected but derivable).

## 14. Milestones

All milestones follow TDD (tests first), one PR per milestone, golden files added with each. M0 is the prerequisite.

### M0: Package setup (prerequisite)
Rename to `@johnhenry/graceholder`; remove old CLI/code; TypeScript ESM build; Node >= 22; fleet CI + publish workflow (publish on push to main, npm-view guard, tag + Release; trusted publisher needs a manual first publish/2FA by the owner); `graphql` dependency; lint/typecheck/test scripts; golden-test harness; clock/`Math.random` ban check.
**Acceptance:** CI green on Node 22+; `npm pack` shows only intended files; package name/engines correct.

### M1: Repeatable core
Scope: XXH64 + SplitMix64 + key string (section 2); parse -> infer (shape, list rule L3-L6 w/o paging, type names, scalar type by name T1-T13 subset, counts C3) -> SDL -> execute with generated resolvers; aliases, fragments, variables, `__typename`, nesting; `inferSchema` internal; generator basics (`int`, `float`, `bool`, `word(s)`, `sentence`, `uuid`, `url`, `datetime`, `slug`); minimal vendored vocab; golden tests.
**Acceptance:**
- Same seed+query -> identical output across runs and Node versions; different seed -> different output.
- Reordering fields, adding/removing sibling fields, changing aliases never alters other values.
- Fragments (named/inline), variables (incl. defaults), aliases and `__typename` work.
- Lists have a stable count 3-10 by key; singularised type names as per section 4.
- No `Math.random`/`Date.now` in `src`.
**Tests:** XXH64 vectors; SplitMix64 vectors; `int`/`pick`/`float` helper edge cases; key-string snapshot (frozen strings); singularizer table; name-to-type table (each T row); list/one table (each L row); count range; alias invariance; field-order invariance; sibling add/remove invariance; fragment/variable/`__typename` cases; seed sensitivity; sync return; goldens for 5 representative queries.

### M2: Entity graph, arguments, pagination
Scope: section 3: entity identity, type pools, `id`-like args selecting entities, shared pool by type name, windows, offset/page/relay paging, Relay connections (`edges/node/pageInfo/totalCount`), cursors, unions/interfaces via `... on X`.
**Acceptance:**
- `user(id: 5)` is identical wherever it appears and across aliases.
- Paged windows are consistent: concatenating consecutive pages equals one large page; no gaps/overlaps; `first/after`, `offset/limit`, `page/pageSize`, `last/before` all work.
- Relay connections produce valid `pageInfo` and cursors round-trip.
- Union/interface `__typename` stable per entity.
- Filter args select distinct collections.
**Tests:** identity across paths; alias identity; different args -> different entity; page concatenation property test (random page sizes); cursor round trip and bad cursor; hasNextPage with and without `@count`; `last/before`; union/interface resolution and fragment selection; shared pool via same type name; composite-key args; goldens.

### M3: Personas, derived fields, anchorDate, locale
Scope: section 6: persona kinds and slots, derivations (email/username/names, createdAt<=updatedAt<=anchor, totals/sums, counts, age/birthday), `anchorDate`, `locale` (en bundle + unknown-locale error), vendored vocab complete with checksum test and PROVENANCE.
**Acceptance:**
- `email` contains the persona's name parts; `username` consistent; same persona -> same values in every field that uses it.
- `createdAt <= updatedAt <= anchorDate` always; changing `anchorDate` shifts dates deterministically and leaves non-date values unchanged.
- `total = subtotal + tax`, `subtotal = sum(items)` independent of paging window.
- `<x>Count` equals list total.
- Unknown locale throws.
**Tests:** persona slot isolation (adding a slot changes nothing else); email/name coherence over 1000 entities; date ordering property test over 1000 entities; anchorDate change; totals with windowed items; count equals total; ASCII folding; vocabulary checksum; clock-faking test (system clock changes do not change output); goldens.

### M4: Directives, side-car spec, public `inferSchema`
Scope: section 5: all directives (stripped), spec grammar (`*`, `**`, `@Type.field`), precedence, `inferSchema(query, spec)` returning SDL + decisions, error handling (section 9), remaining generators in the catalogue.
**Acceptance:**
- Every directive and spec property works and is equivalent in both forms.
- Precedence matches 5.3 (directive > exact > `*` > `**` > heuristic > default), per property.
- Unknown directive/generator/derive cycle/conflicts raise the right `GraceholderError` codes; unused spec paths reported in `decisions`.
- `inferSchema` returns SDL that `buildSchema` accepts and decisions with sources.
**Tests:** one test per directive; one per spec property; path-pattern matching table; precedence matrix; `@seed` nesting; `@nullRate` determinism; `@pattern` token table; `@derive`; error-code table with "did you mean"; decisions content snapshot; SDL validity for all goldens; goldens updated.

### M5: `suggestSpec`, docs, 1.0.0 readiness
Scope: section 10; README, API docs, STABILITY.md, cookbook; browser build verification.
**Acceptance:** `suggestSpec` works with a stub `llm`, validates and repairs; rejects bad output; core has no LLM dependency; docs complete; 1.0.0 checklist below is satisfied.
**Tests:** stub LLM returning valid/fenced/invalid JSON; repair round; unknown generator in suggestion rejected; prompt snapshot (non-stability-bearing); package has no LLM deps (check `dependencies`); browser smoke (bundle with esbuild, run in a headless browser) identical output to Node for goldens.

**1.0.0 readiness checklist** (status at the end of M5; the open items need the owner)
- [ ] All golden files reviewed; key scheme `gh1`, hash, RNG, vocab, inference rules declared frozen (owner review before tagging 1.0.0: any golden change after that is breaking)
- [x] STABILITY.md and "what counts as an output change" published (generated from section 11 and checked by a test); the `breaking`-label check for golden diffs exists (`golden-guard.yml`) and becomes enforcing at version 1.0.0
- [x] Output identical on Node 22, current LTS (24) and a browser (browser-like VM in CI, headless Chromium via `npm run test:browser`)
- [x] Vocab provenance/licences documented; checksums asserted
- [x] Open questions in section 15 resolved or explicitly deferred
- [x] Bundle size measured and documented (about 200 kB minified, 58 kB gzip, `graphql` included); zero runtime deps except `graphql`
- [ ] Trusted publishing configured (owner: first publish with 2FA, then `npm trust`; see the checklist comment on the setup issue)
- [x] README examples run as tests (`test/docs.test.js`)

## 15. Open questions (resolved)

All ten questions were decided before implementation (defaults chosen by the hub, easy to change before 1.0):

1. **Locales beyond `en`:** deferred past 1.0.
2. **Default sharing of inferred types:** inferred types of the same name share one pool by default; `inferSchema` reports each sharing decision; opt out per type with spec `own: true` (M4).
3. **Pool size 100, `endlessTotal` 1000:** accepted.
4. **`anchorDate` default `2025-01-01T00:00:00.000Z`:** accepted.
5. **graphql-js range:** `^16` only; revisit 17 when it is stable and the golden tests pass on it.
6. **Directive spelling:** `@gen(name: ...)` stays; `@oneOf` is renamed **`@pick`** (and the spec property is `pick`) to avoid the GraphQL spec's input `@oneOf`. The `oneOf` *generator* keeps its catalogue name.
7. **Vocabulary source:** hand-curated, original or public-domain tables (no faker-derived content).
8. **Modulo bias:** none. `int()` uses rejection sampling (section 2.3).
9. **`@derive` expression language:** deferred; copy/transform forms only in v1.
10. **Non-null by default:** accepted.

## 16. Implementation decisions

Choices made while implementing, where the text above was ambiguous or needed a correction. Later milestones append here.

### M1

- **Files.** Plain JS with hand-written `src/index.d.ts` (no build step). `src/xxh64.js`, `rng.js`, `key.js`, `naming.js`, `rules.js`, `infer.js`, `execute.js`, `generators.js`, `vocab/en.js`.
- **Only `query` operations** are supported; mutations and subscriptions throw `bad-operation`. Fragments the operation does not reach are dropped before validation. The document is validated against the inferred schema, so GraphQL's own rules apply (for example, unused variables are an error).
- **Spec is not supported yet:** passing `spec` throws `unsupported` (M4). Inline directives other than `@skip`/`@include` throw `unknown-directive`.
- **Arguments are typed but not used.** In M1 argument values never change identity or counts (M2 adds identifying arguments, filters and paging). Literals are typed `Int`/`Float`/`String`/`Boolean`/list/input object and are nullable (`user(id: Int)`, not `Int!`); variables use their declared type; if an argument is seen with differing types the nullable form of the first wins. Enum literals and empty objects/lists use the pass-through scalar `GraceholderAny`; unknown named variable types become pass-through custom scalars. Object literals become `input <Field><Arg>Input`.
- **Entity keys (section 3, subset).** Top-level lists are the shared pool (member `i` has key `String(i)`, 1-based); nested lists are owned (`<parentKey>.<field>.<i>`); a top-level singular field is entity `1`; a nested singular field is a reference `int(1, 100)` into the pool of its type. List counts are `int(3, 10)` from the `l`-scope key; scalar lists use the same count, with the element index as a sub-key.
- **`id` values.** A decimal entity key is the id; for non-decimal (owned) keys the id is `int(1, 999999)` from the entity's own `id` key, so ids look like ids. `xId` fields are `id.int` in `1..100` as strings.
- **Type names.** N2 considers type conditions applied directly to a field's selection (named spreads and inline fragments, looking through condition-less inline fragments). Two different conditions on one field throw `unsupported` (unions arrive in M2). Two occurrences of one field that disagree on type throw `conflicting-shape`, as does a field used both with and without a sub-selection. A type with no selected fields other than `__typename` gets a placeholder `_empty: String` field in the SDL.
- **Singularizer refinements** (the section 4.2 text produced wrong results on common words): `ies -> y` only when a consonant precedes it, with an irregular entry for `-ie` words (`movies`, `cookies`, `pies`, `ties`, `lies`, `zombies`, `selfies`, `rookies`, `calories`) and unchanged `species`/`series`; `(ss|x|ch|sh)es` drops `es` (`addresses -> address`, `boxes`, `watches`, `dishes`), but plain `ses`/`zes` drop only the `s` (`cases -> case`, `databases -> database`, `prizes -> prize`).
- **Plural-looking singulars.** `views`, `likes`, `votes`, `dislikes`, `news`, `series`, `species` are never lists (T8 treats the first three as counts).
- **L-rule order.** The table order is kept: L3 (plural) is tested before L4, so `allUsers` is L3; L4 catches `list` and `all*` names that are not plural (`allData`).
- **T-rule details.** T5 is tested before T4 so `avatarUrl` is an image URL; an image word alone only wins with a `url`/`uri`/`link`/`src` suffix (so `imageCount` is T8). T3 matches a last word of `email`/`mail`, or `address` preceded by `email`. T1: exactly `id` is the entity key, a trailing `id` (`userId`) is an integer reference. For list fields the last word is singularised before the T rules (`emails`, `tags`). `name` uses the type's persona kind: product/item/listing types get product names, org types company names, everything else a person full name (persona-coherent names arrive with M3, so M1 draws first, last, email and username independently).
- **Datetimes (M1).** `anchorDate - int(30d..1500d)` in milliseconds (birthdays 18-80 years); coherent `createdAt <= updatedAt` ordering is M3.
- **Result mode.** `errors: "result"` returns `{ data }` on success and `{ errors }` for GraphQL parse, validation and execution failures; other `GraceholderError`s always throw.

### M2

- **Identifying arguments** (priority order `id, key, slug, uuid, email, username, handle, sku`) select the entity of a singular object field: `user(id: 5)` is `User:5` everywhere, and `5` and `"5"` are the same key (non-strings use canonical JSON). `ids: [..]` on a list selects exactly those entities. Composite keys (explicit key-argument names, sorted, joined with `0x1E`) are implemented in `src/args.js` and get wired to the spec in M4.
- **Filter arguments.** Non-paging arguments form the `argsKey` (canonical JSON, sorted keys). A non-empty `argsKey` is a sub-key of the collection key (count) and of scalar fields, and prefixes the member keys of the collection (`f<8 hex>.<i>`), so `tickets(status: "OPEN")` and `tickets(status: "CLOSED")` are different collections with different members. With no filter the keys are exactly the M1 keys, so M1 goldens do not change.
- **Paging.** Precedence: `page` (`pageSize`/`perPage`), then `offset`/`skip` or a bare `limit`/`take`, then relay `first`/`after`/`last`/`before`. A bare `first` or a paged list with no size uses the collection count `n` (3 to 10) as the default size. `first` with `before` clips at `before`. `last` with `before` ends before the cursor; `last` without `before` takes the end of the finite collection (total `n`). Plain lists with paging arguments are endless; `first: 0` is an empty window. Cursors are base64url(`gc1:<index>`), unpadded; `after`/`before` that do not decode throw `bad-cursor`; negative or non-integer sizes, `page < 1` and windows larger than 10000 throw `bad-arguments`.
- **Connections** are detected structurally: a field selecting `edges {..}` or `pageInfo {..}`, or `nodes {..}` together with `totalCount`, or typed by a `...Connection` type condition. The item type comes from the field name with a trailing `Connection` word dropped (`posts`, `postsConnection` give `Post`, `PostConnection`, `PostEdge`, shared `PageInfo`). Only the selected fields are emitted, with the fixed types from section 3.4; `startCursor`/`endCursor` are nullable and null for an empty window. `totalCount` is 1000 for an endless connection and `hasNextPage` is true; a finite collection (`last` without `before`) reports its real total. Members of a connection are the same entities as the members of the plain list for the same field.
- **Unions and interfaces.** A field whose selection has several distinct type conditions becomes `union <Name>Union` (no fields outside the fragments) or `interface <Name>` (fields outside the fragments, which are added to the interface and to every member). The concrete type is `pick(possible types)` from the key `("e", abstractName, entityKey, "__typename")`; members keep the entity key, so the entity is the same as in the typed list.
- **Errors from resolvers** (`bad-cursor`, `bad-arguments`) are rethrown with their own code instead of being wrapped as `graphql`.
- **Decisions** now include `E2-shared` (an object type referenced by more than one field shares one pool), `S3` (connection) and `S4` (union/interface).
- **Golden changes.** Only `profile-scalars` changed: `user(id: 5)` now selects entity `5` instead of the top-level default `1`. The other four M1 goldens are byte-identical.

### M3

- **Persona slots.** `ctx.slot(name)` is the stream for key `("p", typeName, entityKey, slotName)`. Persona-coherent generators (`person.*`, `company.*`, `product.name`, `place.*`, `time.*`, `person.age`) read slots only, so every field of one entity agrees and adding a slot never moves another. Slots are available on every type; the persona *kind* (6.1) only chooses which generator a field name gets (for example `name`). Elements of a scalar list are their own personas (`<key>.<field>.<i>`), so `emails` varies per element.
- **Names.** `fullName = first + " " + last`; username is `first[0]+last`, `first.last` or `first+NN` (style slot); email local part is `first.last`, `firstlast` or `first.lastNN`, then `@` and a weighted vocabulary domain. Everything is ASCII-folded (`asciiFold`: NFD, strip marks, a small map for letters that do not decompose such as `o-slash`, `l-stroke`). The vocabulary gained twelve accented names so folding is exercised; this changes the name tables and therefore all earlier goldens.
- **Places.** City, state, country, zip, street and address read one `place` slot (a row of the vendored table) plus separate suffix/street slots.
- **Dates.** `createdAt = anchor - int(30d, 1500d)`; `updatedAt` is uniformly between `createdAt` and the anchor; `publishedAt` likewise; `deletedAt` is `null` by default (the field is nullable in the inferred SDL; a `nullRate < 1` argument, available through M4, makes it non-null and never before `updatedAt`). `birthday` is `anchor - floor(age * 365.25 d) - int(0, 364) d` from the `age` slot (18 to 90), so `age` agrees with `birthday` and does not depend on the anchor. Other date names (`startDate`, `lastSeenAt`, ...) stay independent keyed datetimes. Changing the anchor shifts every date equally and changes no other value.
- **Money.** `money` draws whole dollars, then an ending weighted `.00` / `.99` / `.49` / any cents, clamped to the range. In types of the order kind, `subtotal`, `tax` and `total` are computed from the order's whole `items` collection (the selected `items` field, or the conventional `items` of type `Item` when it is not selected): `subtotal = sum(price * quantity)` in integer cents using exactly the values the item fields generate, `tax = round(subtotal * rate)` with a 0 to 12 percent rate slot, `total = subtotal + tax`. Paging arguments on `items` do not change totals.
- **Counts.** `<x>Count`, `<x>sCount` and `total<X>s` are `Int`, never lists, and equal the unpaged total of the sibling collection (the selected sibling, or the guessed camelCase plural of `<x>` when it is not selected) with the same keys as that collection. Measures (`viewCount`, `likeCount`, `voteCount`, ...) keep their T8 range unless a sibling collection of that name is selected. Inference reports these as rule `C-count`.
- **Locale.** The generator registry is built per locale bundle; `en` is the only bundle and any other value throws `unknown-locale`.
- **Graph generators.** `count.of`, `order.subtotal`, `order.tax` and `order.total` are executor-level generators (they need the entity graph).

### M4

- **One override model.** Directives and spec entries are parsed into the same properties (`list`, `count`, `gen`, `nullRate`, `derive`, `type`, `seed`, `key`, `own`, `shared`); `@pattern` and `@pick` (and spec `pattern`/`pick`) are `gen` with the generators `pattern` and `oneOf`, so they compete with `@gen` for one slot. `@one` is `list: false`. Both forms are checked for equivalence in tests.
- **Where directives go.** Only on fields; `@seed` also on the operation. Directive arguments may be variables (provided values over declared defaults); a variable used only by graceholder directives is removed from the stripped document. `@skip`/`@include` are left alone. Malformed arguments throw `bad-directive`; an unknown directive throws `unknown-directive` with a nearest-name hint.
- **Merging occurrences.** A `(parentType, field)` pair can appear at several paths and with several directive sets. Properties merge; equal values are fine; a directive beats a spec value; two *different* directive values for one property throw `conflicting-overrides`. A spec path addresses the pair if it matches **any** path by which the field is reached.
- **Precedence (per property).** Directive, then the most specific matching spec entry that defines the property: exact path or `@Type.field` (an exact path beats `@Type.field`), then patterns with `*`, then patterns with `**`; ties go to the longer literal prefix, then the later declaration; then heuristics, then defaults. `*` is exactly one segment, `**` zero or more; patterns are anchored at the root.
- **Meaning of each property.** `list`/`one` replace the L rules (rule `L1`; on a connection they throw). `count` (`n`, `[min,max]`, `{min,max}`) fixes or keys the collection size from the same key as the default size and also declares the total: a paged list or connection then has a real end (`hasNextPage` false after the last item, `totalCount = n`, windows clipped); `count` on a non-list throws. `gen` runs once at inference with throwaway streams so unknown names (`unknown-generator`, with a nearest-name hint) and bad arguments (`bad-generator-args`) fail even when the list is empty; its SDL type follows the generator (`int`, `Float`, `Boolean`, `DateTime`, or from `pick` values). `nullRate` makes the field nullable (when > 0) and returns `null` when `float()` of the key `(e, type, entity, field, "null")` is below the rate; the non-null values are the same values as without the directive. `derive` copies the source field's value of the same entity (the source need not be selected) and shapes it by the derived field's own generator: `slug` slugifies, `person.username` and `person.email` ASCII-fold (email keeps its persona domain); other kinds copy. Cycles, self-derives and non-scalar sources throw `bad-derive`. `type` sets the type name (rule `N1`, highest) and therefore the pool. `seed` replaces the seed for the field and its subtree (inner wins, then outer, then the operation, then options); entity sources carry their seed. `key` lists identifying argument names (composite keys are sorted and joined with `0x1E`). `own` makes the entity (or members) owned by the parent instead of drawn from the pool; `shared` draws a nested collection's members from the type pool.
- **`$options`.** `poolSize` (default 100) and `endlessTotal` (default 1000), positive integers.
- **Spec validation.** Any structural problem throws `bad-spec`; `list` with `one` throws `conflicting-overrides`. A spec entry that matches no field is reported as a decision of kind `unused` (rule `unused-spec-path`, source `spec`); `strict: true` turns it into an error.
- **`inferSchema(query, spec?, options?)`** returns the SDL, the decisions (each with `source` of directive, spec, heuristic or default, and the `rule`) and the stripped document. Decision kinds `null`, `key`, `seed` and `unused` were added.

### M5

- **`suggestSpec`.** `suggestSpec(query, { llm, spec? })` builds the prompt (`buildSuggestPrompt`, versioned `SUGGEST_PROMPT_VERSION`), accepts a bare JSON object, a fenced block or prose around a JSON object, and validates the result by running it through `inferSchema(query, spec)`: Spec schema (`bad-spec`), generator names and arguments, conflicts, derive cycles, and **spec paths that match no field** all count as problems. One repair round re-prompts with the problems; a second failure throws `bad-suggestion` with the problems in `hint`. An `llm` that throws is not caught. The existing spec is part of the prompt and the model is asked to return the full spec; the validated reply is returned as is.
- **Documentation.** README, `docs/api.md`, `docs/cookbook.md`; their `js` examples run in `test/docs.test.js` and each `json` block directly after one is compared with the example's single `console.log` (refresh with `npm run docs:update`). `STABILITY.md` is generated from section 11 (`npm run stability`) and shipped.
- **Browser verification.** `test/bundle.test.js` bundles `src/index.js` with esbuild for the browser and reproduces every golden in a `vm` context that has no `process`, `require` or `Buffer` (runs in CI). `test/browser.test.js` does the same in headless Chromium through `playwright-core` when a Chromium is installed (`npm run test:browser` makes a missing browser a failure).
- **Golden guard.** `.github/workflows/golden-guard.yml` runs `scripts/check-golden-change.mjs`: from version 1.0.0 a PR that changes `test/golden` needs the `breaking` label (single-package repo, so the label stands in for the "major changeset"); before 1.0.0 it only reports.
- **Package contents** are tested (`npm pack` ships `src/`, `README.md`, `LICENSE`, `STABILITY.md`, `package.json`).
