// Generator catalogue (docs/design.md section 7). Generators are pure functions of a
// ctx. `ctx.stream` is local to one key; `ctx.slot(name)` is the stream of one persona
// slot (scope "p"), so coherent fields read the same slots and adding a slot never
// changes another. Output for a given draw sequence and vocabulary is FROZEN at 1.0.0.
import { LOCALES } from "./vocab/en.js";
import { GraceholderError } from "./errors.js";

const DAY_MS = 86400000;
const YEAR_MS = 365.25 * DAY_MS;
const HEX = "0123456789abcdef";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = LOWER.toUpperCase();
const ALNUM = LOWER + UPPER + "0123456789";

const cap = (s) => s[0].toUpperCase() + s.slice(1);
const pad = (n, w) => String(n).padStart(w, "0");
const badArgs = (name, msg) => new GraceholderError("bad-generator-args", `${name}: ${msg}`);

const SPECIAL_FOLD = { "ø": "o", "Ø": "o", "ł": "l", "Ł": "l", "æ": "ae", "Æ": "ae", "ß": "ss", "đ": "d", "ð": "d", "þ": "th" };

/** Lowercase ASCII-only form of a name, for usernames and email local parts. */
export function asciiFold(text) {
  let out = "";
  for (const ch of text) out += SPECIAL_FOLD[ch] ?? ch;
  return out.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function intArg(name, args, key, dflt) {
  const v = args[key] ?? dflt;
  if (!Number.isFinite(v)) throw badArgs(name, `${key} must be a number`);
  return v;
}

function range(name, args, dMin, dMax) {
  const min = intArg(name, args, "min", dMin);
  const max = intArg(name, args, "max", dMax);
  if (min > max) throw badArgs(name, `min (${min}) is greater than max (${max})`);
  return [min, max];
}

const hexString = (s, n) => {
  let out = "";
  for (let i = 0; i < n; i++) out += HEX[s.int(0, 15)];
  return out;
};

function pattern(name, p, s) {
  if (typeof p !== "string") throw badArgs(name, "p must be a string");
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\") out += p[++i] ?? "";
    else if (c === "#") out += s.int(0, 9);
    else if (c === "?") out += LOWER[s.int(0, 25)];
    else if (c === "A") out += UPPER[s.int(0, 25)];
    else if (c === "*") out += ALNUM[s.int(0, ALNUM.length - 1)];
    else out += c;
  }
  return out;
}

const round = (x, decimals) => {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
};

/** Age of the persona's `created` slot, in ms before the anchor: 30 to 1500 days. */
const createdAge = (ctx) => ctx.slot("created").int(30 * DAY_MS, 1500 * DAY_MS);
const updatedAge = (ctx) => {
  const c = createdAge(ctx);
  return c - ctx.slot("updated").int(0, c);
};

/** @param {typeof LOCALES.en} V */
function buildRegistry(V) {
  const wordList = (s, n) => Array.from({ length: n }, () => s.pick(V.words));
  const sentence = (s) => cap(wordList(s, s.int(6, 14)).join(" ")) + ".";
  const sentences = (s, n) => Array.from({ length: n }, () => sentence(s)).join(" ");

  const first = (ctx) => ctx.pinned?.first ?? ctx.slot("first").pick(V.firstNames);
  const last = (ctx) => ctx.pinned?.last ?? ctx.slot("last").pick(V.lastNames);
  const place = (ctx) => ctx.slot("place").pick(V.places);
  const street = (ctx) => {
    const s = ctx.slot("street");
    return `${s.int(1, 9999)} ${s.pick(V.streets)} ${s.pick(V.streetSuffixes)}`;
  };
  const postal = (ctx, row) => {
    const s = ctx.slot("zip");
    return /^[0-9]/.test(row.zip) ? row.zip + pad(s.int(0, 99), 2) : `${row.zip} ${s.int(0, 9)}${UPPER[s.int(0, 25)]}${s.int(0, 9)}`;
  };
  const orgName = (ctx) => `${ctx.slot("orgHead").pick(V.companyHeads)} ${ctx.slot("orgSuffix").pick(V.companySuffixes)}`;
  const age = (ctx) => ctx.slot("age").int(18, 90);

  return {
    // ids
    "id.key": ({ entityKey, stream }) => (/^[0-9]+$/.test(entityKey) ? entityKey : String(stream.int(1, 999999))),
    "id.uuid": ({ stream: s }) => {
      const h = hexString(s, 32).split("");
      h[12] = "4";
      h[16] = "89ab"[s.int(0, 3)];
      const j = h.join("");
      return `${j.slice(0, 8)}-${j.slice(8, 12)}-${j.slice(12, 16)}-${j.slice(16, 20)}-${j.slice(20)}`;
    },
    "id.int": ({ stream: s, args }) => {
      const [min, max] = range("id.int", args, 1, 1000);
      const v = s.int(min, max);
      return args.string ? String(v) : v;
    },
    // numbers
    int: ({ stream: s, args }) => {
      const [min, max] = range("int", args, 0, 100);
      return s.int(min, max);
    },
    float: ({ stream: s, args }) => {
      const [min, max] = range("float", args, 0, 1);
      const decimals = intArg("float", args, "decimals", 2);
      return Math.min(max, Math.max(min, round(min + s.float() * (max - min), decimals)));
    },
    // whole cents; endings .00, .99, .49 or any cents, weighted
    money: ({ stream: s, args }) => {
      const [min, max] = range("money", args, 1, 100);
      const lo = Math.round(min * 100);
      const hi = Math.round(max * 100);
      const minD = Math.ceil(min);
      const maxD = Math.floor(max);
      if (maxD < minD) return s.int(lo, hi) / 100;
      const dollars = s.int(minD, maxD);
      const ending = s.weighted([[0, 3], [1, 4], [2, 2], [3, 3]]);
      const cents = ending === 0 ? 0 : ending === 1 ? 99 : ending === 2 ? 49 : s.int(0, 99);
      return Math.min(hi, Math.max(lo, dollars * 100 + cents)) / 100;
    },
    percent: ({ stream: s }) => round(s.float() * 100, 2),
    bool: ({ stream: s, args }) => s.bool(args.p ?? 0.5),
    // text
    word: ({ stream: s }) => s.pick(V.words),
    words: ({ stream: s, args }) => wordList(s, intArg("words", args, "n", 2)).join(" "),
    sentence: ({ stream: s }) => sentence(s),
    sentences: ({ stream: s, args }) => sentences(s, intArg("sentences", args, "n", 2)),
    paragraph: ({ stream: s }) => sentences(s, s.int(3, 6)),
    title: ({ stream: s }) => wordList(s, s.int(3, 6)).map(cap).join(" "),
    slug: ({ stream: s }) => wordList(s, s.int(2, 4)).join("-"),
    lorem: ({ stream: s, args }) =>
      Array.from({ length: intArg("lorem", args, "paragraphs", 1) }, () => sentences(s, s.int(3, 6))).join("\n\n"),
    // person: every field reads the persona slots, so they agree with each other
    "person.first": (ctx) => first(ctx),
    "person.last": (ctx) => last(ctx),
    "person.full": (ctx) => `${first(ctx)} ${last(ctx)}`,
    "person.username": (ctx) => {
      const f = asciiFold(first(ctx));
      const l = asciiFold(last(ctx));
      const style = ctx.slot("userStyle").int(0, 2);
      if (style === 0) return f[0] + l;
      if (style === 1) return `${f}.${l}`;
      return f + pad(ctx.slot("userNum").int(0, 99), 2);
    },
    "person.email": (ctx) => {
      const f = asciiFold(first(ctx));
      const l = asciiFold(last(ctx));
      const style = ctx.slot("emailStyle").int(0, 2);
      const local = style === 0 ? `${f}.${l}` : style === 1 ? `${f}${l}` : `${f}.${l}${ctx.slot("emailNum").int(1, 99)}`;
      const domain = ctx.slot("domain").weighted(V.emailDomains.map((d, i) => [d, [4, 3, 2, 1, 1][i] ?? 1]));
      return `${local}@${domain}`;
    },
    "person.phone": (ctx) => `(${ctx.slot("phoneArea").int(201, 989)}) 555-01${pad(ctx.slot("phoneLine").int(0, 99), 2)}`,
    "person.jobTitle": (ctx) => ctx.slot("job").pick(V.jobTitles),
    "person.bio": (ctx) => {
      const s = ctx.slot("bio");
      return sentences(s, s.int(1, 2));
    },
    "person.age": (ctx) => age(ctx),
    // org / product
    "company.name": (ctx) => orgName(ctx),
    "company.domain": (ctx) => `${ctx.slot("orgHead").pick(V.companyHeads).toLowerCase()}.example.com`,
    "company.industry": (ctx) => ctx.slot("industry").pick(V.industries),
    "product.name": (ctx) => `${ctx.slot("adj").pick(V.productAdjectives)} ${ctx.slot("noun").pick(V.productNouns)}`,
    // place: one persona row, so city, state, country and zip agree
    "place.city": (ctx) => place(ctx).city,
    "place.state": (ctx) => place(ctx).state,
    "place.country": (ctx) => place(ctx).country,
    "place.zip": (ctx) => postal(ctx, place(ctx)),
    "place.street": (ctx) => street(ctx),
    "place.address": (ctx) => {
      const row = place(ctx);
      return `${street(ctx)}, ${row.city}, ${row.code} ${postal(ctx, row)}`;
    },
    "place.lat": ({ stream: s }) => round(-90 + s.float() * 180, 4),
    "place.lng": ({ stream: s }) => round(-180 + s.float() * 360, 4),
    // web
    url: ({ stream: s }) => `https://${s.pick(V.emailDomains)}/${s.pick(V.words)}-${s.pick(V.words)}`,
    imageUrl: ({ stream: s }) => `https://images.example.org/${hexString(s, 12)}.png`,
    ip: ({ stream: s }) => [s.int(1, 254), s.int(0, 254), s.int(0, 254), s.int(1, 254)].join("."),
    hex: ({ stream: s, args }) => hexString(s, intArg("hex", args, "length", 16)),
    color: ({ stream: s }) => s.pick(V.colors),
    // time: coherent per entity, relative to the anchor (createdAt <= updatedAt <= anchor)
    datetime: ({ stream: s, args, anchorMs }) => {
      const min = intArg("datetime", args, "minDaysAgo", 0);
      const max = intArg("datetime", args, "maxDaysAgo", 365);
      if (min > max) throw badArgs("datetime", "minDaysAgo is greater than maxDaysAgo");
      return new Date(anchorMs - s.int(min * DAY_MS, max * DAY_MS)).toISOString();
    },
    "time.created": (ctx) => new Date(ctx.anchorMs - createdAge(ctx)).toISOString(),
    "time.updated": (ctx) => new Date(ctx.anchorMs - updatedAge(ctx)).toISOString(),
    "time.published": (ctx) => {
      const c = createdAge(ctx);
      return new Date(ctx.anchorMs - (c - ctx.slot("published").int(0, c))).toISOString();
    },
    // null unless args.nullRate < 1; then never before updatedAt and never after the anchor
    "time.deleted": (ctx) => {
      if (ctx.stream.float() < (ctx.args.nullRate ?? 1)) return null;
      const u = updatedAge(ctx);
      return new Date(ctx.anchorMs - (u - ctx.slot("deleted").int(0, u))).toISOString();
    },
    "time.birthday": (ctx) => new Date(ctx.anchorMs - Math.floor(age(ctx) * YEAR_MS) - ctx.slot("birthDay").int(0, 364) * DAY_MS).toISOString(),
    // choice
    oneOf: ({ stream: s, args }) => {
      if (args.vocab !== undefined) {
        const table = V[args.vocab];
        if (!Array.isArray(table) || table.length === 0 || typeof table[0] !== "string") {
          throw badArgs("oneOf", `unknown vocabulary ${JSON.stringify(args.vocab)}`);
        }
        return s.pick(table);
      }
      if (!Array.isArray(args.values) || args.values.length === 0) throw badArgs("oneOf", "values must be a non-empty array");
      if (args.values.every((v) => v !== null && typeof v === "object" && "weight" in v)) {
        return s.weighted(args.values.map((v) => [v.value, v.weight]));
      }
      return s.pick(args.values);
    },
    pattern: ({ stream: s, args }) => pattern("pattern", args.p, s),
  };
}

/** Names that are computed by the executor (they need the entity graph), not by a pure generator. */
export const GRAPH_GENERATORS = Object.freeze(["count.of", "order.subtotal", "order.tax", "order.total"]);

const REGISTRIES = new Map();
function registryFor(locale) {
  let r = REGISTRIES.get(locale);
  if (!r) {
    if (!Object.hasOwn(LOCALES, locale)) throw new GraceholderError("unknown-locale", `unknown locale ${JSON.stringify(locale)}`);
    r = buildRegistry(LOCALES[locale]);
    REGISTRIES.set(locale, r);
  }
  return r;
}

export const GENERATOR_NAMES = Object.freeze([...Object.keys(registryFor("en")), ...GRAPH_GENERATORS]);

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

/** Nearest known generator name, for "did you mean" hints. */
export function nearestGenerator(name) {
  let best = GENERATOR_NAMES[0];
  for (const n of GENERATOR_NAMES) if (distance(name, n) < distance(name, best)) best = n;
  return best;
}

/**
 * @typedef {{ stream: import("./rng.js").Stream, slot: (name: string) => import("./rng.js").Stream,
 *             anchorMs: number, args: Record<string, any>, typeName: string, entityKey: string,
 *             fieldName: string, locale?: string }} GeneratorContext
 * @param {string} name
 * @param {GeneratorContext} ctx
 */
export function generate(name, ctx) {
  const registry = registryFor(ctx.locale ?? "en");
  const fn = Object.hasOwn(registry, name) ? registry[name] : undefined;
  if (!fn) {
    throw new GraceholderError("unknown-generator", `unknown generator ${JSON.stringify(name)}`, {
      hint: `did you mean ${JSON.stringify(nearestGenerator(name))}? Known: ${GENERATOR_NAMES.join(", ")}`,
    });
  }
  return fn(ctx);
}
