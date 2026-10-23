# graceholder design

Status: proposed (pre-implementation). Package: `@johnhenry/graceholder`. This document replaces the 40-line `mock-ql-sculptor` code on the old `main`.

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
| `u64(n)` | n-th SplitMix64 output |
| `float(n)` | `Number(u64(n) >> 11n) / 2**53`, in `[0,1)` |
| `int(n, lo, hi)` | `lo + Number(u64(n) % BigInt(hi - lo + 1))` (inclusive). Modulo bias is accepted and frozen. |
| `pick(n, arr)` | `arr[int(n, 0, arr.length-1)]` |
| `weighted(n, [[v,w],...])` | cumulative weights over `float(n)` |
| `bool(n, p)` | `float(n) < p` |

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

- Collection membership is *derived by key*, not stored. Member ordinal `i` (1-based) of collection `C` has entityKey = `i` for top-level collections shared by type (see 3.3), or `"<parentKey>/<fieldName>/<i>"`... **No**: to keep the same `User:42` identical everywhere, list members are always drawn from the **type pool**: member `i` of collection `C` is pool entity with key `poolIndex(C, i)`.
- `poolIndex(C, i) = i` for top-level fields and for unscoped lists (collection-by-type pool); this is what makes `users` page 1 contain `User:1..N` and `posts{author}` refer to pool users.
- A nested list that belongs to a parent (e.g. `user.posts`) uses a **per-parent child pool** keyed `"<parentType>:<parentKey>.<fieldName>"` as the typeName-scope extension; members are `Post` entities with keys `"<parentKey>.<fieldName>.<i>"`... to avoid two ways to say it, the rule is:

> **Rule E1.** A list is *shared* (members come from the type pool, key = index) when its collection is top-level (child of `Query`) or the spec/directive says `shared`/`@type` unified it with a top-level collection. Otherwise it is *owned* (members have key `"<parentKey>.<fieldName>.<i>"`, type = element type).
> **Rule E2.** A singular object field reached with no identifying argument is *owned* by default: key = `"<parentKey>.<fieldName>"` for non-`Query` parents; for `Query` it is the pool entity `1`. With `@type("User")` or a spec `type`, it is *shared*: key = `String(int(h, 1, poolSize))` where `poolSize = 100` (a spec-settable default) with `h` drawn from key `(seed, "l", parentType, parentKey, fieldName)`. So `post.author` with `@type("User")` is one of `User:1..100`, stable, and equals `user(id: 7)` when it lands on 7.

This makes the default (query-alone, no unification) predictable: nothing is shared unless you say so or an argument identifies it. Open question 2 asks whether to share by inferred type name by default instead (the original brief: "object fields with an inferred type share a pool by type name").

**Decision for v1:** follow the brief. *Inferred* object types of the same name share the type pool: `post.author` and `comment.author` inferred as `Author` share `Author`'s pool unless made owned by `@one(owned)`. To keep that from being surprising, `inferSchema` reports each sharing decision (`source:"heuristic"`, `rule:"E2-shared"`). The E2 "owned" behavior above applies only when the inferred type name is unique in the operation (it cannot collide with anything), where owned vs. shared is indistinguishable in practice except for `id` values. Therefore the observable rule is simply: **same type name + same key = same entity; singular object fields pick a key from the type pool `1..poolSize` (default 100) via the keyed hash of the parent; top-level singular fields without args use key 1.**

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
| L3 | Last word of name is plural (ends `s` but not `ss`/`us`/`is`, or in irregular list: `people`, `children`, `men`, `women`, `mice`, `data`? no: `data` is singular) | list |
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

Singularize (frozen, small, no dependency): irregular table (`people->person`, `men->man`, `women->woman`, `children->child`, `mice->mouse`, `feet->foot`, `teeth->tooth`, `geese->goose`, `analyses->analysis`, `indices->index`, `criteria->criterion`, `data->datum` is NOT applied; `data` stays `Data`); `ies -> y` (`stories->story`; not after a vowel: `movies->movie`); `(s|x|z|ch|sh)es -> $1` (`boxes->box`, `addresses->address`, `watches->watch`); `ves -> f`? (not applied; `ves -> ve`: `leaves->leave`? **Decision:** only `ves->f` for `knives,wives,leaves,lives,shelves,wolves` listed in the irregular table); `ss`/`us`/`is` endings unchanged; trailing `s -> ''`. Rules live in one frozen module and are covered by golden tests.

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

`... on X` fragments on a field define possible types. A field with `... on A`, `... on B` and no common concrete selection becomes `union <Name>Union = A | B`. If fields are selected outside the inline fragments, they become an `interface <Name>` with those fields and A, B implement it. The concrete type of an entity is chosen by `pick(hash(key("e", ifaceName, entityKey, "__typename")), possibleTypes)` unless weighted by spec/`@oneOf`. `__typename` is always the resolved concrete type.

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
| `@oneOf(values: [...])` | pick from a fixed set (weights via `{value,weight}` objects) |
| `@nullRate(p: 0.2)` | probability of `null` (field becomes nullable) |
| `@derive(from: "firstName")` | derive from another field of the same entity (see 6.3 for forms: a field name, or `"upper(name)"`-style expressions are NOT supported in v1) |
| `@type(name: "User")` | set/unify the type name (shares the pool) |
| `@seed(s: "x")` | override the seed for this subtree (inner overrides outer) |

The brief writes `@gen(name, ...args)`: concrete syntax is `@gen(name: "number.int", min: 1, max: 5)`. A single positional-like shorthand `@oneOf(["a","b"])` is not valid GraphQL, so the argument is named `values`. Also `@type(name: "User")` and `@pattern(p: "...")`.

### 5.2 Side-car spec

```ts
type Spec = Record<string /* path pattern */, FieldSpec> & { $options?: { poolSize?: number; endlessTotal?: number } };
interface FieldSpec {
  list?: boolean; one?: boolean;               // shape
  count?: number | [number, number] | { min: number; max: number };
  gen?: string | { name: string; args?: Record<string, unknown> };
  pattern?: string; oneOf?: Array<unknown | { value: unknown; weight: number }>;
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
- Vocabulary tables are **append-only within a major version**? No: appending changes `int(n, 0, len-1)` mapping, so **any** vocabulary edit is an output change (major). Tables are therefore frozen at 1.0.0.
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

**Not output changes (minor/patch):** new generators, new directives or spec properties, new locales, newly *recognised* name heuristics for names that currently fall through to the `T13` default? **No** (that changes output): new heuristics are output changes. Only strictly additive features that cannot affect existing inputs qualify: new generator names, new opt-in directives/options, new locales, error-message wording, performance, types, docs, the `suggestSpec` prompt.

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
  "*.status":     { "oneOf": ["draft", "published", "archived"] },
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

Decisions (excerpt): `posts` list (L2 paging arg; L3 plural), `posts.author` -> `User` (spec, `source:"spec"`, shared pool), `orders` count 2..4 (directive), `commentCount` Int (T8), `status` oneOf (spec `*.status`), `total` Float (contextual order rule), `tags` list of String (L3), count 1..3 (spec).

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

**1.0.0 readiness checklist**
- [ ] All golden files reviewed; key scheme `gh1`, hash, RNG, vocab, inference rules declared frozen
- [ ] STABILITY.md and "what counts as an output change" published; CI enforces the `breaking` label for golden diffs
- [ ] Output identical on Node 22, current LTS and a browser
- [ ] Vocab provenance/licences documented; checksums asserted
- [ ] Open questions in section 15 resolved or explicitly deferred
- [ ] Bundle size measured and documented; zero runtime deps except `graphql`
- [ ] Trusted publishing configured; README examples run as tests

## 15. Open questions

1. **Locales beyond `en`.** v1 ships `en` only. Do we want a second locale before 1.0 to prove the abstraction, and who curates the vocab?
2. **Default sharing of inferred types.** Section 3.2 follows the brief (same inferred type name shares a pool). The risk is surprise coupling (`author` in two unrelated places is the same pool). Alternative: owned by default, share only via `@type`/spec. Which default?
3. **Default pool size** (100) for shared singular references, and the `endlessTotal` (1000): acceptable?
4. **`anchorDate` default** constant `2025-01-01T00:00:00.000Z`: fine, or something later?
5. **graphql-js version range** (16 only, or 17 as well).
6. **Directive spelling** `@gen(name: "...", ...)` and `@oneOf(values: [...])` instead of positional arguments, since GraphQL has no positional arguments (and `@oneOf` collides with the GraphQL `@oneOf` input directive in newer specs; consider `@pick`). Acceptable?
7. **Vocabulary source.** Hand-curated public-domain lists vs. generating tables from faker at authoring time (licence MIT, content provenance mixed). Preference?
8. **Modulo bias** in `int()` is accepted for simplicity; fine for mock data?
9. **Expression language for `@derive`** (e.g. `upper(name)`, templates): deferred; is a template string (`"{firstName}.{lastName}@x.com"`) worth adding in v1?
10. **Non-null vs nullable** inferred SDL (non-null by default): is that what consumers want when they feed the SDL to other tools?
