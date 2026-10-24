// Inference rules: list-vs-one (L) and scalar type/generator by name (T). FROZEN at 1.0.0.
import { tokenize, singularize, personaKind } from "./naming.js";


const IRREGULAR_PLURALS = new Set(["people", "children", "men", "women", "mice"]);
/** Plural-looking words that are singular count-like scalars (T8) or mass nouns. */
const SINGULAR_PLURALS = new Set(["views", "likes", "votes", "dislikes", "news", "series", "species"]);
const L4_NAMES = new Set(["list"]);

function pluralLast(word) {
  if (SINGULAR_PLURALS.has(word)) return false;
  if (IRREGULAR_PLURALS.has(word)) return true;
  if (word === "data") return false;
  return word.endsWith("s") && !/(ss|us|is)$/.test(word);
}

/**
 * L2-L6. L1 (directive/spec) arrives with M4.
 * @param {string} fieldName
 * @param {{ paging: boolean, idsArg: boolean, listLiteralArg: boolean, realistic?: boolean, object?: boolean }} ctx
 * @returns {{ list: boolean, rule: string }}
 */
export function listRule(fieldName, ctx) {
  const tokens = tokenize(fieldName);
  const last = tokens[tokens.length - 1] ?? "";
  if (ctx.paging) return { list: true, rule: "L2" };
  // realistic mode: `salesHistory { date value }` is a time series, which is a list
  if (ctx.realistic && ctx.object && SERIES_TYPE_WORDS.has(last)) return { list: true, rule: "L7" };
  // realistic mode: a scalar `followers` or `sales` is a number, not a list of words
  if (ctx.realistic && !ctx.object && Object.hasOwn(POPULARITY, last)) return { list: false, rule: "L6" };
  if (pluralLast(last)) return { list: true, rule: "L3" };
  if (L4_NAMES.has(fieldName.toLowerCase()) || L4_NAMES.has(last) || (tokens[0] === "all" && tokens.length > 1)) {
    return { list: true, rule: "L4" };
  }
  if (ctx.idsArg || ctx.listLiteralArg) return { list: true, rule: "L5" };
  return { list: false, rule: "L6" };
}

// --- scalar type by name ------------------------------------------------------

const IMAGE_WORDS = new Set(["avatar", "image", "photo", "thumbnail", "picture", "logo"]);
const IMAGE_SUFFIX = new Set(["url", "uri", "link", "src"]);
const URL_WORDS = new Set(["url", "uri", "link", "website", "homepage"]);
const PHONE_WORDS = new Set(["phone", "mobile", "tel", "telephone"]);
const BOOL_PREFIX = new Set(["is", "has", "can", "should", "was", "did", "allow", "allows", "allowed"]);
const BOOL_SUFFIX = new Set(["enabled", "active", "verified", "public", "deleted", "archived", "flag"]);

/** T8: last word -> inclusive integer range. */
const INT_RANGES = {
  count: [0, 500], total: [0, 1000], qty: [1, 10], quantity: [1, 10], num: [1, 100], age: [18, 90],
  year: [1990, 2024], index: [0, 99], position: [1, 20], rank: [1, 100], level: [1, 50], size: [1, 100],
  length: [1, 100], views: [0, 100000], likes: [0, 5000], votes: [0, 1000],
};

/** T9: last word -> [generator, min, max]. */
const FLOAT_RANGES = {
  price: ["money", 1, 500], cost: ["money", 1, 500], amount: ["money", 1, 1000], total: ["money", 1, 1000],
  subtotal: ["money", 1, 1000], tax: ["money", 0, 100], fee: ["money", 0, 100], balance: ["money", 0, 10000],
  salary: ["money", 30000, 200000], revenue: ["money", 1000, 1000000], rate: ["float", 0, 100],
  ratio: ["float", 0, 1], score: ["float", 0, 100], rating: ["float", 1, 5], weight: ["float", 1, 200],
  height: ["float", 1, 250], lat: ["float", -90, 90], lng: ["float", -180, 180], latitude: ["float", -90, 90],
  longitude: ["float", -180, 180], percent: ["float", 0, 100],
};

/**
 * Realistic mode only (options.distributions: "realistic"): popularity-like counts are heavy-tailed.
 * word -> [distribution, min, max]
 */
const POPULARITY = {
  views: ["lognormal", 0, 1000000], view: ["lognormal", 0, 1000000], impressions: ["lognormal", 0, 5000000],
  plays: ["lognormal", 0, 1000000], reads: ["lognormal", 0, 500000], clicks: ["lognormal", 0, 100000],
  likes: ["lognormal", 0, 50000], like: ["lognormal", 0, 50000], shares: ["lognormal", 0, 10000],
  followers: ["powerlaw", 0, 1000000], follower: ["powerlaw", 0, 1000000], subscribers: ["powerlaw", 0, 1000000],
  stars: ["powerlaw", 0, 100000], downloads: ["powerlaw", 0, 10000000], sales: ["zipf", 0, 100000],
};
const SERIES_TYPE_WORDS = new Set(["history", "series", "timeline", "trend"]);
const SERIES_DATE_WORDS = new Set(["date", "day", "at", "time", "timestamp", "month", "week", "period", "ts", "x"]);
const SERIES_VALUE_WORDS = new Set([
  "value", "amount", "count", "total", "price", "y", "balance", "close", "volume", "sales", "revenue", "views",
  "visits", "users", "score", "rate", "temperature", "level", "reading",
]);

/** Realistic mode: is this the element type of a time series (`SalesHistory`, `PriceSeries`)? */
export const isSeriesType = (typeName) => SERIES_TYPE_WORDS.has(tokenize(typeName).at(-1) ?? "");

const COHERENT_DATES = { created: "time.created", updated: "time.updated", published: "time.published" };
const DATE_WORDS = new Set(["at", "date", "time", "timestamp"]);
const BIRTH_WORDS = new Set(["birthday", "dob"]);

const ORG_TYPE_KINDS = new Set(["org"]);

const r = (sdl, gen, rule, args = {}, extra = {}) => ({ sdl, gen, args, rule, ...extra });

/**
 * `<x>Count`, `<x>sCount` and `total<X>s` count a sibling collection (docs/design.md 6.2).
 * @returns {string[]|null} the words naming the counted collection, last word singular
 */
export function countOf(fieldName) {
  const tokens = tokenize(fieldName);
  let words = null;
  if (tokens.length >= 2 && tokens[tokens.length - 1] === "count") words = tokens.slice(0, -1);
  else if (tokens.length >= 2 && tokens[0] === "total" && /s$/.test(tokens[tokens.length - 1]) && !SINGULAR_PLURALS.has(tokens[tokens.length - 1])) words = tokens.slice(1);
  if (!words || (words.length === 1 && words[0] === "total")) return null;
  const out = [...words];
  out[out.length - 1] = singularize(out[out.length - 1]);
  return out;
}

/**
 * Pick the SDL scalar type and generator for a scalar field. First matching row wins (T1-T13).
 * @param {string} fieldName
 * @param {{ typeName: string, list: boolean, packs?: any[], realistic?: boolean }} ctx
 * @returns {{ sdl: string, gen: string, args: Record<string, any>, rule: string, nullable?: boolean, pack?: string }}
 */
export function classifyScalar(fieldName, ctx) {
  if (fieldName === "__typename") return r("String", "typename", "T2");
  const tokens = tokenize(fieldName);
  if (tokens.length === 0) return r("String", "words", "T13", { n: 2 });
  if (ctx.list) tokens[tokens.length - 1] = singularize(tokens[tokens.length - 1]);
  const last = tokens[tokens.length - 1];
  const first = tokens[0];
  const has = (w) => tokens.includes(w);
  const kind = personaKind(ctx.typeName);

  // T1
  if (last === "id") {
    if (tokens.length === 1 && !ctx.list) return r("ID", "id.key", "T1");
    return r("ID", "id.int", "T1", { min: 1, max: 100, string: true });
  }
  // realistic mode: fields of a time-series element type (`salesHistory { date value }`)
  if (ctx.realistic && isSeriesType(ctx.typeName)) {
    if (tokens.length === 1 && SERIES_DATE_WORDS.has(last)) return r("DateTime", "series.date", "T14");
    if (tokens.length === 1 && SERIES_VALUE_WORDS.has(last)) return r("Float", "series.value", "T14");
  }
  // packs, in order: the first pack that recognises the name wins (rule P1)
  for (const pack of ctx.packs ?? []) {
    const hit = pack.rules?.({ tokens, first, last, kind, typeName: ctx.typeName, list: ctx.list });
    if (hit) return r(hit.sdl, hit.gen, "P1", hit.args ?? {}, { pack: pack.name, ...(hit.nullable ? { nullable: true } : {}) });
  }
  // T3
  if (last === "email" || last === "mail" || (last === "address" && has("email"))) return r("String", "person.email", "T3");
  // T5 before T4: `avatarUrl` is an image, not a plain url
  if (IMAGE_WORDS.has(last) || (tokens.some((t) => IMAGE_WORDS.has(t)) && IMAGE_SUFFIX.has(last))) {
    return r("String", "imageUrl", "T5");
  }
  // T4
  if (URL_WORDS.has(last) || has("url")) return r("String", "url", "T4");
  // T6
  if (PHONE_WORDS.has(last)) return r("String", "person.phone", "T6");
  // T7
  if (BOOL_PREFIX.has(first) || BOOL_SUFFIX.has(last)) return r("Boolean", "bool", "T7");
  // T8, realistic mode: heavy-tailed popularity counts (`views`, `likeCount`, `followers`, `sales`)
  if (ctx.realistic) {
    const word = Object.hasOwn(POPULARITY, last) ? last : (last === "count" || last === "total") && tokens.length > 1 ? tokens[tokens.length - 2] : undefined;
    const pop = word !== undefined && Object.hasOwn(POPULARITY, word) ? POPULARITY[word] : undefined;
    if (pop) return r("Int", "int", "T8", { min: pop[1], max: pop[2], dist: pop[0] });
  }
  // T8 (a type context overrides `total`, see T9)
  const numberOf = first === "number" && tokens[1] === "of";
  const orderTotal = last === "total" && kind === "order";
  if ((last in INT_RANGES && !orderTotal) || numberOf) {
    const [min, max] = numberOf ? INT_RANGES.count : INT_RANGES[last];
    if (last === "age" && kind === "person" && tokens.length === 1) return r("Int", "person.age", "T8", { min, max });
    return r("Int", "int", "T8", { min, max });
  }
  // T9
  if (kind === "order" && tokens.length === 1 && (last === "subtotal" || last === "total" || last === "tax")) {
    const [, min, max] = FLOAT_RANGES[last];
    return r("Float", `order.${last}`, "T9", { min, max });
  }
  if (last in FLOAT_RANGES) {
    const [gen, min, max] = FLOAT_RANGES[last];
    return r("Float", gen, "T9", { min, max });
  }
  // T10
  if (DATE_WORDS.has(last) || BIRTH_WORDS.has(last)) {
    if (BIRTH_WORDS.has(last)) return r("DateTime", "time.birthday", "T10");
    if (tokens.length === 2 && last === "at" && first === "deleted") return r("DateTime", "time.deleted", "T10", {}, { nullable: true });
    if (tokens.length === 2 && last === "at" && first in COHERENT_DATES) return r("DateTime", COHERENT_DATES[first], "T10");
    return r("DateTime", "datetime", "T10", { minDaysAgo: 30, maxDaysAgo: 1500 });
  }
  // T11
  const named = namedString(tokens, first, last, has, kind, ctx.typeName);
  if (named) return r("String", named.gen, "T11", named.args ?? {});
  // T13
  return r("String", "words", "T13", { n: 2 });
}

function namedString(tokens, first, last, has, kind, typeName) {
  const prev = tokens[tokens.length - 2];
  if (last === "name") {
    if (prev === "first" || prev === "given") return { gen: "person.first" };
    if (prev === "last" || prev === "family" || prev === "sur") return { gen: "person.last" };
    if (prev === "full") return { gen: "person.full" };
    if (kind === "product") return { gen: "product.name" };
    if (ORG_TYPE_KINDS.has(kind)) return { gen: "company.name" };
    return { gen: "person.full" };
  }
  if (last === "username" || last === "handle" || last === "nickname") return { gen: "person.username" };
  if (last === "title") {
    if (first === "job" && tokens.length === 2) return { gen: "person.jobTitle" };
    if (kind === "person") return { gen: "person.jobTitle" };
    return { gen: "title" };
  }
  if (last === "company" || last === "organization") return { gen: "company.name" };
  if (last === "city") return { gen: "place.city" };
  if (last === "state") return { gen: "place.state" };
  if (last === "country") return { gen: "place.country" };
  if (has("zip") || has("zipcode") || first === "postal") return { gen: "place.zip" };
  if (last === "street") return { gen: "place.street" };
  if (last === "address") return { gen: "place.address" };
  if (last === "bio") return { gen: "person.bio" };
  if (last === "description" || last === "summary" || last === "text" || last === "comment" || last === "message") return { gen: "sentence" };
  if (last === "body" || last === "content") return { gen: "paragraph" };
  if (last === "slug") return { gen: "slug" };
  if (last === "status") return { gen: "oneOf", args: { vocab: "status" } };
  if (last === "role") return { gen: "oneOf", args: { vocab: "role" } };
  if (last === "color" || last === "colour") return { gen: "color" };
  if (last === "currency") return { gen: "oneOf", args: { vocab: "currency" } };
  if (last === "locale") return { gen: "oneOf", args: { vocab: "locale" } };
  if (last === "language") return { gen: "oneOf", args: { vocab: "language" } };
  if (last === "uuid") return { gen: "id.uuid" };
  if (last === "ip") return { gen: "ip" };
  if (last === "sku") return { gen: "pattern", args: { p: "AAA-#####" } };
  if (last === "token") return { gen: "hex", args: { length: 32 } };
  void typeName;
  return null;
}
