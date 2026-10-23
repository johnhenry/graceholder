// Generator catalogue (docs/design.md section 7). Generators are pure functions of
// a ctx whose `stream` is local to one key. Output for a given draw sequence and
// vocabulary is FROZEN at 1.0.0.
import { en } from "./vocab/en.js";
import { GraceholderError } from "./errors.js";

const V = en;
const DAY_MS = 86400000;
const HEX = "0123456789abcdef";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = LOWER.toUpperCase();
const ALNUM = LOWER + UPPER + "0123456789";

const cap = (s) => s[0].toUpperCase() + s.slice(1);
const pad = (n, w) => String(n).padStart(w, "0");
const badArgs = (name, msg) => new GraceholderError("bad-generator-args", `${name}: ${msg}`);

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

const wordList = (s, n) => Array.from({ length: n }, () => s.pick(V.words));
const sentence = (s) => {
  const w = wordList(s, s.int(6, 14));
  return cap(w.join(" ")) + ".";
};
const sentences = (s, n) => Array.from({ length: n }, () => sentence(s)).join(" ");

const person = (s) => ({ first: s.pick(V.firstNames), last: s.pick(V.lastNames) });
const street = (s) => `${s.int(1, 9999)} ${s.pick(V.streets)} ${s.pick(V.streetSuffixes)}`;
const postal = (s, row) =>
  /^[0-9]/.test(row.zip) ? row.zip + pad(s.int(0, 99), 2) : `${row.zip} ${s.int(0, 9)}${UPPER[s.int(0, 25)]}${s.int(0, 9)}`;

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

/** @type {Record<string, (ctx: GeneratorContext) => unknown>} */
const REGISTRY = {
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
  money: ({ stream: s, args }) => {
    const [min, max] = range("money", args, 1, 100);
    return s.int(Math.round(min * 100), Math.round(max * 100)) / 100;
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
  // person
  "person.first": ({ stream: s }) => s.pick(V.firstNames),
  "person.last": ({ stream: s }) => s.pick(V.lastNames),
  "person.full": ({ stream: s }) => {
    const p = person(s);
    return `${p.first} ${p.last}`;
  },
  "person.username": ({ stream: s }) => {
    const { first, last } = person(s);
    const style = s.int(0, 2);
    if (style === 0) return (first[0] + last).toLowerCase();
    if (style === 1) return `${first}.${last}`.toLowerCase();
    return first.toLowerCase() + pad(s.int(0, 99), 2);
  },
  "person.email": ({ stream: s }) => {
    const { first, last } = person(s);
    return `${first}.${last}@${s.pick(V.emailDomains)}`.toLowerCase();
  },
  "person.phone": ({ stream: s }) => `(${s.int(201, 989)}) 555-01${pad(s.int(0, 99), 2)}`,
  "person.jobTitle": ({ stream: s }) => s.pick(V.jobTitles),
  "person.bio": ({ stream: s }) => sentences(s, s.int(1, 2)),
  // org / product
  "company.name": ({ stream: s }) => `${s.pick(V.companyHeads)} ${s.pick(V.companySuffixes)}`,
  "company.domain": ({ stream: s }) => `${s.pick(V.companyHeads).toLowerCase()}.example.com`,
  "company.industry": ({ stream: s }) => s.pick(V.industries),
  "product.name": ({ stream: s }) => `${s.pick(V.productAdjectives)} ${s.pick(V.productNouns)}`,
  // place
  "place.city": ({ stream: s }) => s.pick(V.places).city,
  "place.state": ({ stream: s }) => s.pick(V.places).state,
  "place.country": ({ stream: s }) => s.pick(V.places).country,
  "place.zip": ({ stream: s }) => postal(s, s.pick(V.places)),
  "place.street": ({ stream: s }) => street(s),
  "place.address": ({ stream: s }) => {
    const row = s.pick(V.places);
    return `${street(s)}, ${row.city}, ${row.code} ${postal(s, row)}`;
  },
  "place.lat": ({ stream: s }) => round(-90 + s.float() * 180, 4),
  "place.lng": ({ stream: s }) => round(-180 + s.float() * 360, 4),
  // web
  url: ({ stream: s }) => `https://${s.pick(V.emailDomains)}/${s.pick(V.words)}-${s.pick(V.words)}`,
  imageUrl: ({ stream: s }) => `https://images.example.org/${hexString(s, 12)}.png`,
  ip: ({ stream: s }) => [s.int(1, 254), s.int(0, 254), s.int(0, 254), s.int(1, 254)].join("."),
  hex: ({ stream: s, args }) => hexString(s, intArg("hex", args, "length", 16)),
  color: ({ stream: s }) => s.pick(V.colors),
  // time
  datetime: ({ stream: s, args, anchorMs }) => {
    const min = intArg("datetime", args, "minDaysAgo", 0);
    const max = intArg("datetime", args, "maxDaysAgo", 365);
    if (min > max) throw badArgs("datetime", "minDaysAgo is greater than maxDaysAgo");
    return new Date(anchorMs - s.int(min * DAY_MS, max * DAY_MS)).toISOString();
  },
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

export const GENERATOR_NAMES = Object.freeze(Object.keys(REGISTRY));

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
 * @typedef {{ stream: import("./rng.js").Stream, anchorMs: number, args: Record<string, any>,
 *             typeName: string, entityKey: string, fieldName: string }} GeneratorContext
 * @param {string} name
 * @param {GeneratorContext} ctx
 */
export function generate(name, ctx) {
  const fn = Object.hasOwn(REGISTRY, name) ? REGISTRY[name] : undefined;
  if (!fn) {
    throw new GraceholderError("unknown-generator", `unknown generator ${JSON.stringify(name)}`, {
      hint: `did you mean ${JSON.stringify(nearestGenerator(name))}? Known: ${GENERATOR_NAMES.join(", ")}`,
    });
  }
  return fn(ctx);
}
