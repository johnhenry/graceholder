// Type tests for the type-level query reader (src/typed.d.ts). Checked by `npm run typecheck`.
import { graceholder, createWorld, stream, type ResultOf, type ItemOf, type Data } from "@johnhenry/graceholder";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// ---- scalars by field name, selection sets, aliases ---------------------------------------------
type Scalars = ResultOf<"{ user { id email age price isActive createdAt name tags } }">;
type _scalars = Expect<Equal<Scalars, { user: { id: string; email: string; age: number; price: number; isActive: boolean; createdAt: string; name: string; tags: string[] } }>>;

type Aliased = ResultOf<"{ a: users(first: 2) { id } b: user { name } }">;
type _aliased = Expect<Equal<Aliased, { a: { id: string }[]; b: { name: string } }>>;

type Header = ResultOf<`
  # comment
  query Users($first: Int = 3) @seed(s: "x") {
    users(first: $first) { id, name }
  }`>;
type _header = Expect<Equal<Header, { users: { id: string; name: string }[] }>>;

// ---- lists: plural names, paging arguments, ids, @list/@one ------------------------------------
type Lists = ResultOf<"{ people { id } child { id } blogPosts { id } thing(limit: 3) { id } stuff(ids: [1]) { id } forced @list { id } users @one { id } }">;
type _lists = Expect<Equal<Lists, { people: { id: string }[]; child: { id: string }; blogPosts: { id: string }[]; thing: { id: string }[]; stuff: { id: string }[]; forced: { id: string }[]; users: { id: string } }>>;

type Nested = ResultOf<"{ users { posts { comments { author { id } } } } }">;
type _nested = Expect<Equal<Nested, { users: { posts: { comments: { author: { id: string } }[] }[] }[] }>>;

// ---- counts, dates, nullability, directives -----------------------------------------------------
type Counts = ResultOf<"{ user { postCount totalComments deletedAt nick @nullRate(p: 0.5) bio @nullRate(p: 0) } }">;
type _counts = Expect<Equal<Counts, { user: { postCount: number; totalComments: number; deletedAt: string | null; nick: string | null; bio: string } }>>;

type Gen = ResultOf<`{ u { a @gen(name: "int") b @gen(name: "bool") c @pattern(p: "A#") d @pick(values: ["x", "y"]) e @gen(name: "person.email") } }`>;
type _gen = Expect<Equal<Gen, { u: { a: number; b: boolean; c: string; d: "x" | "y"; e: string } }>>;

type Typename = ResultOf<"{ __typename blogPosts { __typename } }">;
type _typename = Expect<Equal<Typename, { __typename: "Query"; blogPosts: { __typename: "BlogPost" }[] }>>;
type Retyped = ResultOf<`{ author @type(name: "User") { __typename } }`>;
type _retyped = Expect<Equal<Retyped, { author: { __typename: "User" } }>>;

type Skipped = ResultOf<"query Q($on: Boolean!) { u { id name @include(if: $on) } }">;
type _skipped = Expect<Equal<Skipped, { u: { id: string; name?: string } }>>;

// ---- fragments ---------------------------------------------------------------------------------
type Frag = ResultOf<"query { users { ...U } } fragment U on User { id posts { ...P } } fragment P on Post { title }">;
type _frag = Expect<Equal<Frag, { users: { id: string; posts: { title: string }[] }[] }>>;
type Merged = ResultOf<"{ u { posts { id } ...F } } fragment F on User { posts { title } }">;
type _merged = Expect<Equal<Merged, { u: { posts: { id: string; title: string }[] } }>>;
type InlineOnly = ResultOf<"{ u { id ... on User { name } } }">;
type _inline = Expect<Equal<InlineOnly, { u: { id: string; name: string } }>>;

// ---- unions, interfaces ------------------------------------------------------------------------
type Union = ResultOf<"{ search(first: 3) { ... on User { __typename id } ... on Post { __typename title } } }">;
type _union = Expect<Equal<Union, { search: ({ __typename: "User"; id: string } | { __typename: "Post"; title: string })[] }>>;
declare const hit: Union["search"][number];
if (hit.__typename === "User") {
  const id: string = hit.id;
  // @ts-expect-error title only exists on Post
  hit.title;
  void id;
}
type Iface = ResultOf<"{ feed(first: 2) { id ... on Photo { url } ... on Video { length } } }">;
type _iface = Expect<Equal<Iface, { feed: ({ id: string; url: string } | { id: string; length: number })[] }>>;

// ---- connections -------------------------------------------------------------------------------
type Conn = ResultOf<"{ postsConnection(first: 2) { totalCount pageInfo { hasNextPage endCursor } edges { cursor node { id title } } } }">;
type _conn = Expect<Equal<Conn, { postsConnection: { totalCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; edges: { cursor: string; node: { id: string; title: string } }[] } }>>;

// ---- stream items --------------------------------------------------------------------------------
type Item = ItemOf<"{ users { id name } }">;
type _item = Expect<Equal<Item, { id: string; name: string }>>;
type ConnItem = ItemOf<"{ postsConnection(first: 2) { edges { node { id } } } }">;
type _connItem = Expect<Equal<ConnItem, { id: string }>>;
type Named = ItemOf<"{ me { id } posts { title } users { id } }", "users">;
type _named = Expect<Equal<Named, { id: string }>>;
type FirstList = ItemOf<"{ me { id } posts { title } users { id } }">;
type _first = Expect<Equal<FirstList, { title: string }>>;

// ---- what falls back --------------------------------------------------------------------------------
declare const dynamic: string;
const fallback: Data = graceholder(dynamic);
type _dynamic = Expect<Equal<ResultOf<string>, Record<string, unknown>>>;
type _broken = Expect<Equal<ResultOf<"{ users { id ">, Record<string, unknown>>>;
type _twoOps = Expect<Equal<ResultOf<"query A { a { id } } query B { b { id } }">, Record<string, unknown>>>;

// ---- wired into the API --------------------------------------------------------------------------------
const data = graceholder("{ users(first: 2) { id name email } }", { seed: "t" });
const first: { id: string; name: string; email: string } = data.users[0];
const name: string = data.users[0].name;
// @ts-expect-error there is no such field in the query
data.users[0].nickname;
// @ts-expect-error the field is a list
data.users.id;
// @ts-expect-error id is a string
const wrong: number = data.users[0].id;
void [first, name, wrong, fallback];

const res = graceholder("{ users { id } }", { errors: "result" });
const maybe: string | undefined = res.data?.users[0].id;
void maybe;

const world = createWorld({ seed: "w" });
const wr = world.query("{ user(id: 3) { name age } }");
const age: number | undefined = wr.data?.user.age;
// @ts-expect-error not selected
wr.data?.user.email;
void age;

const s = stream("{ users { id name } }", { count: 3 });
for (const u of s) {
  const id: string = u.id;
  // @ts-expect-error not selected
  u.email;
  void id;
}
const ws = world.stream("{ posts { title } }", { count: 2 });
const t: string = [...ws][0].title;
void t;
const byField = stream("{ as { id } bs { title } }", { count: 1, field: "bs" });
const title: string = [...byField][0].title;
void title;
// an explicit item type still works
const explicit = stream<{ custom: number }>("{ users { id } }", { count: 1 });
const custom: number = [...explicit][0].custom;
void custom;
