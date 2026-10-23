// specFromSamples: learn a side-car spec from real responses (docs/design.md section 18).
// Pure and deterministic: the same query, samples and options give the same spec. It reads formats
// and statistics, never free text: see the privacy rules in section 18.2.
import { Kind, isEnumType } from "graphql";
import { GraceholderError } from "./errors.js";
import { infer } from "./infer.js";
import { anchorMs as parseAnchor, DEFAULT_ANCHOR } from "./anchor.js";
import { compileSpec } from "./spec.js";
import { PAGING_ARGS } from "./args.js";

const DAY_MS = 86400000;
const YEAR_DAYS = 365.25;
const bad = (msg, path) => new GraceholderError("bad-samples", msg, path === undefined ? undefined : { path });
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const r3 = (x) => Math.round(x * 1000) / 1000;
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Generators whose value is the identity of the entity or computed from the graph: never learned. */
const KEEP = new Set(["id.key", "id.int", "count.of", "order.subtotal", "order.tax", "order.total"]);
/** Generators that stand for personal data: enum-like or not, their values are never copied. */
const PERSONAL = new Set(["person.first", "person.last", "person.full", "person.username", "person.phone", "person.bio"]);
/** Generators that stand for free text: a learned length range replaces them. */
const TEXTISH = new Set(["word", "words", "sentence", "sentences", "paragraph", "lorem", "title", "person.bio", "text"]);
/** Coherent date generators and the window of days before the anchor they can produce. */
const COHERENT_DAYS = {
  "time.created": [30, 1500], "time.updated": [0, 1500], "time.published": [0, 1500],
  "time.birthday": [18 * YEAR_DAYS, 90 * YEAR_DAYS + 364],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const URL_RE = /^https?:\/\/[^\s]+$/i;
const IMAGE_URL = /\.(?:png|jpe?g|gif|webp|svg|avif)(?:\?[^\s]*)?$/i;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Response key -> merged field nodes of one selection list, looking through fragments. */
function collectFields(selections, fragments, out = new Map()) {
  for (const sel of selections) {
    if (sel.kind === Kind.FIELD) {
      const name = sel.name.value;
      if (name.startsWith("__")) continue;
      const key = sel.alias?.value ?? name;
      const entry = out.get(key) ?? { key, name, selections: [], hasSelection: false };
      if (sel.selectionSet) {
        entry.hasSelection = true;
        entry.selections.push(...sel.selectionSet.selections);
      }
      out.set(key, entry);
    } else if (sel.kind === Kind.INLINE_FRAGMENT) {
      collectFields(sel.selectionSet.selections, fragments, out);
    } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
      collectFields(fragments.get(sel.name.value).selectionSet.selections, fragments, out);
    }
  }
  return out;
}

function normalizeSamples(samples, rootKeys) {
  const list = Array.isArray(samples) ? samples : [samples];
  if (list.length === 0) throw bad("specFromSamples needs at least one sample response");
  return list.map((s, i) => {
    if (!isObject(s)) throw bad(`sample ${i} must be an object (a response's data, or { data })`);
    if (Object.hasOwn(s, "data") && !rootKeys.has("data")) {
      if (!isObject(s.data)) throw bad(`sample ${i} has no data${s.errors ? " (it has errors)" : ""}`);
      return s.data;
    }
    return s;
  });
}

class Acc {
  constructor(path, info) {
    this.path = path;
    this.info = info;
    this.present = 0; // parent instances that had the key
    this.nulls = 0;
    this.sizes = []; // list lengths, one per instance holding a list
    this.values = []; // non-null scalar values, flattened across instances and list elements
    this.sawList = false;
    this.sawSingle = false;
    this.opaque = false; // an object where a scalar was selected (a JSON scalar)
  }
}

function walkSamples(ctx, selections, parentPath, instances) {
  for (const f of collectFields(selections, ctx.fragments).values()) {
    const path = parentPath ? `${parentPath}.${f.name}` : f.name;
    let acc = ctx.accs.get(path);
    if (!acc) {
      acc = new Acc(path, ctx.byPath.get(path));
      ctx.accs.set(path, acc);
    }
    const children = [];
    for (const inst of instances) {
      if (!Object.hasOwn(inst, f.key)) continue;
      const v = inst[f.key];
      acc.present++;
      if (v === null) {
        acc.nulls++;
        continue;
      }
      if (Array.isArray(v)) {
        acc.sawList = true;
        acc.sizes.push(v.length);
        for (const e of v) {
          if (e === null) continue;
          if (f.hasSelection) {
            if (!isObject(e)) throw bad(`${path}: the query selects sub-fields, but a list element is ${typeof e}`, path);
            children.push(e);
          } else if (isObject(e) || Array.isArray(e)) acc.opaque = true;
          else acc.values.push(e);
        }
      } else {
        acc.sawSingle = true;
        if (f.hasSelection) {
          if (!isObject(v)) throw bad(`${path}: the query selects sub-fields, but the sample has ${typeof v}`, path);
          children.push(v);
        } else if (isObject(v)) acc.opaque = true;
        else acc.values.push(v);
      }
    }
    if (f.hasSelection && children.length) walkSamples(ctx, f.selections, path, children);
  }
}

// --- value learning ----------------------------------------------------------------------------

const decimalsOf = (v) => {
  const t = String(v);
  if (/e/i.test(t)) return 6;
  const i = t.indexOf(".");
  return Math.min(8, i < 0 ? 0 : t.length - i - 1);
};

/** Pattern (docs/design.md 18.3) for same-length ASCII strings, or null when they do not share a format. */
export function shapePattern(values) {
  const len = values[0].length;
  if (len === 0 || len > 64 || values.some((v) => v.length !== len)) return null;
  if (values.some((v) => !/^[\x21-\x7e]+$/.test(v))) return null;
  const distinct = new Set(values).size;
  const cls = (c) => (/[0-9]/.test(c) ? "d" : /[a-z]/.test(c) ? "l" : /[A-Z]/.test(c) ? "u" : "o");
  const slots = [];
  for (let i = 0; i < len; i++) {
    const chars = new Set(values.map((v) => v[i]));
    const classes = new Set([...chars].map(cls));
    if (chars.size === 1) {
      const c = [...chars][0];
      slots.push({ kind: cls(c) === "o" ? "lit" : "const", c, cls: cls(c) });
    } else if (classes.size === 1) {
      const k = [...classes][0];
      if (k === "o") return null; // different punctuation in one place: not a format
      slots.push({ kind: "class", cls: k });
    } else if (classes.has("o")) {
      return null;
    } else {
      slots.push({ kind: "class", cls: "x" }); // letters and digits mixed
    }
  }
  // a constant alphabetic prefix of up to 5 letters, followed by a digit or a separator, is part of the format
  let prefix = 0;
  if (distinct >= 2) {
    while (prefix < len && slots[prefix].kind === "const" && /[A-Za-z]/.test(slots[prefix].c)) prefix++;
    const next = slots[prefix];
    if (prefix > 5 || prefix === len || !(next.cls === "d" || next.cls === "o")) prefix = 0;
  }
  const hasDigit = values.some((v) => /[0-9]/.test(v));
  const hasLiteral = slots.some((s) => s.kind === "lit");
  const allUpper = len >= 2 && values.every((v) => /^[A-Z]+$/.test(v));
  if (!(hasDigit || hasLiteral || allUpper)) return null;
  if (distinct === 1 && !hasDigit) return null;
  const escape = (c) => (/[#?A*\\]/.test(c) ? `\\${c}` : c);
  return slots
    .map((s, i) => {
      if (s.kind === "lit") return escape(s.c);
      if (s.kind === "const" && i < prefix) return escape(s.c);
      const k = s.cls;
      return k === "d" ? "#" : k === "l" ? "?" : k === "u" ? "A" : "*";
    })
    .join("");
}

function learnValues(ctx, acc) {
  const { path, info } = acc;
  const values = acc.values;
  const note = (kind, message) => ctx.notes.push({ path, kind, message });
  if (info.ovSrc?.gen === "directive") return note("skipped", "a directive on the field already sets its generator"), null;
  if (info.derive !== undefined) return note("kept-heuristic", "derived fields follow their source"), null;
  const heur = info.gen;
  if (KEEP.has(heur)) return note("kept-heuristic", `${heur} supplies identifiers and aggregates; the entity graph keeps them consistent`), null;
  const named = info.schema?.named;
  if (values.every((v) => typeof v === "boolean")) {
    return { gen: { name: "bool", args: { p: r3(values.filter(Boolean).length / values.length) } } };
  }
  if (values.every((v) => typeof v === "number" && Number.isFinite(v))) return learnNumbers(values, named?.name, note);
  if (values.every((v) => typeof v === "string")) return learnStrings(ctx, acc, values, heur, note);
  return note("skipped", "values of mixed types"), null;
}

function learnNumbers(values, declared, note) {
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const integral = declared === "Int" ? true : declared === "Float" ? false : values.every(Number.isInteger);
  if (integral) {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) return note("skipped", "integers outside the safe range"), null;
    return { gen: { name: "int", args: { min, max } } };
  }
  return { gen: { name: "float", args: { min, max, decimals: Math.max(...values.map(decimalsOf)) } } };
}

function learnStrings(ctx, acc, values, heur, note) {
  const named = acc.info.schema?.named;
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const n = values.length;
  const d = counts.size;

  // a schema enum: the values are public, only their frequencies come from the data
  if (named && isEnumType(named)) {
    const allowed = new Set(named.getValues().map((v) => v.name));
    const stray = values.find((v) => !allowed.has(v));
    if (stray !== undefined) throw bad(`${acc.path}: ${JSON.stringify(stray)} is not a value of the enum ${named.name}`, acc.path);
    return { pick: weighted(counts) };
  }

  if (values.every((v) => UUID.test(v))) return { gen: "id.uuid" };
  if (values.every((v) => EMAIL.test(v))) return { gen: "person.email" };
  if (values.every((v) => URL_RE.test(v))) return { gen: values.every((v) => IMAGE_URL.test(v)) ? "imageUrl" : "url" };
  if (values.every((v) => IPV4.test(v))) return { gen: "ip" };
  const dates = learnDates(ctx, values, heur, note);
  if (dates !== undefined) return dates;

  const constantCase = values.every((v) => /^[A-Z][A-Z_]+$/.test(v));
  const enumLike = values.every((v) => v.length <= 40) && ((d <= ctx.maxEnum && n >= 2 * d) || (constantCase && d <= 24));
  if (enumLike && ctx.allows(acc.path)) {
    if (PERSONAL.has(heur)) return note("withheld", `${heur} stands for personal data; its values are never copied`), null;
    return { pick: weighted(counts) };
  }
  const hasDigit = values.some((v) => /[0-9]/.test(v));
  if (enumLike && !hasDigit) {
    return note("withheld", `${d} distinct value(s) look like an enumeration; pass allowValues to copy them`), null;
  }

  const len = values[0].length;
  if (len >= 8 && values.every((v) => v.length === len && /^[0-9a-f]+$/.test(v)) && values.some((v) => /[a-f]/.test(v)) && values.some((v) => /[0-9]/.test(v))) {
    return { gen: { name: "hex", args: { length: len } } };
  }
  if (values.every((v) => /^[0-9]+$/.test(v))) {
    if (values.every((v) => v.length === len)) return { pattern: "#".repeat(len) };
    const nums = values.map(Number);
    if (nums.every(Number.isSafeInteger)) return { gen: { name: "id.int", args: { min: Math.min(...nums), max: Math.max(...nums), string: true } } };
  }
  const shape = shapePattern(values);
  if (shape !== null) return { pattern: shape };

  if (TEXTISH.has(heur)) {
    let min = Infinity;
    let max = 0;
    for (const v of values) {
      if (v.length < min) min = v.length;
      if (v.length > max) max = v.length;
    }
    return { gen: { name: "text", args: { min, max } } };
  }
  return note("kept-heuristic", `free text is never copied; the ${heur} heuristic stays`), null;
}

/** Counts as `{ value, weight }` objects (most common first), or plain values when all are equally common. */
function weighted(counts) {
  const entries = [...counts].sort((a, b) => b[1] - a[1] || byText(a[0], b[0]));
  if (entries.every(([, c]) => c === entries[0][1])) return entries.map(([v]) => v).sort(byText);
  return entries.map(([value, weight]) => ({ value, weight }));
}

/** ISO date-times and dates as a datetime range relative to the anchor; undefined when the values are not dates. */
function learnDates(ctx, values, heur, note) {
  let dateOnly = true;
  const times = [];
  for (const v of values) {
    const dt = ISO_DATETIME.exec(v);
    if (dt) {
      dateOnly = false;
      times.push(Date.parse(dt[1] ? v : `${v}Z`));
    } else if (ISO_DATE.test(v)) {
      times.push(Date.parse(v));
    } else return undefined;
  }
  if (times.some((t) => !Number.isFinite(t))) return undefined;
  let lo = times[0];
  let hi = times[0];
  for (const t of times) {
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  const minDaysAgo = Math.floor((ctx.anchorMs - hi) / DAY_MS);
  const maxDaysAgo = Math.ceil((ctx.anchorMs - lo) / DAY_MS);
  const window = COHERENT_DAYS[heur];
  if (window && minDaysAgo >= window[0] && maxDaysAgo <= window[1]) {
    return note("kept-heuristic", `${heur} keeps dates coherent with the entity's other dates and already covers this range`), null;
  }
  const args = { minDaysAgo, maxDaysAgo };
  if (dateOnly) args.format = "date";
  return { gen: { name: "datetime", args } };
}

// --- emission ----------------------------------------------------------------------------------

/**
 * Like {@link specFromSamples}, but also returns the notes explaining what was withheld or kept.
 * @param {string|import("graphql").DocumentNode} query
 * @param {any} samples one response or an array of responses (`data` objects or `{ data }`)
 * @param {{ schema?: any, allowValues?: boolean|string[], maxEnum?: number, anchorDate?: string|Date, operationName?: string, variables?: Record<string, unknown> }} [opts]
 * @returns {{ spec: Record<string, any>, notes: { path: string, kind: string, message: string }[] }}
 */
export function analyzeSamples(query, samples, opts = {}) {
  const { allowValues = false, maxEnum = 12 } = opts;
  if (typeof allowValues !== "boolean" && !(Array.isArray(allowValues) && allowValues.every((p) => typeof p === "string"))) {
    throw new GraceholderError("bad-options", "allowValues must be a boolean or an array of field paths");
  }
  if (!Number.isInteger(maxEnum) || maxEnum < 1) throw new GraceholderError("bad-options", "maxEnum must be a positive integer");
  const anchorMs = parseAnchor(opts.anchorDate ?? DEFAULT_ANCHOR);
  const inferred = infer(query, { operationName: opts.operationName, variables: opts.variables, schema: opts.schema });
  const fragments = new Map(inferred.document.definitions.filter((d) => d.kind === Kind.FRAGMENT_DEFINITION).map((d) => [d.name.value, d]));
  const op = /** @type {import("graphql").OperationDefinitionNode} */ (inferred.document.definitions.find((d) => d.kind === Kind.OPERATION_DEFINITION));
  const rootKeys = new Set(collectFields(op.selectionSet.selections, fragments).keys());
  const instances = normalizeSamples(samples, rootKeys);

  const ctx = {
    fragments, byPath: inferred.byPath, accs: new Map(), notes: /** @type {{ path: string, kind: string, message: string }[]} */ ([]), anchorMs, maxEnum,
    allows: (path) => allowValues === true || (Array.isArray(allowValues) && allowValues.includes(path)),
  };
  walkSamples(ctx, op.selectionSet.selections, "", instances);

  const spec = {};
  for (const acc of ctx.accs.values()) {
    const { info, path } = acc;
    if (!info || info.synthetic) continue;
    const entry = {};
    const fromDirective = (prop) => info.ovSrc?.[prop] === "directive";
    const sch = info.schemaSourced ? info.schema : null;
    if (acc.sawList && acc.sawSingle) throw bad(`${path}: the samples have a list in some responses and a single value in others`, path);
    if (sch) {
      if (acc.sawList && !sch.list && !info.connection) throw bad(`${path}: a sample has a list, but the schema declares ${String(sch.def.type)}`, path);
      if (acc.sawSingle && sch.list) throw bad(`${path}: a sample has a single value, but the schema declares ${String(sch.def.type)}`, path);
      if (acc.nulls > 0 && sch.nonNull) throw bad(`${path}: a sample has null, but the schema declares ${String(sch.def.type)}`, path);
    } else if (!info.connection && (acc.sawList || acc.sawSingle) && acc.sawList !== info.list && !fromDirective("list")) {
      entry[acc.sawList ? "list" : "one"] = true;
    }
    if (acc.sawList && !info.connection) {
      const paged = [...info.args.keys()].some((a) => PAGING_ARGS.has(a) || a === "skip" || a === "take");
      if (paged) ctx.notes.push({ path, kind: "skipped", message: "a paged list: the page size comes from the query, not the collection" });
      else if (!fromDirective("count")) {
        const min = Math.min(...acc.sizes);
        const max = Math.max(...acc.sizes);
        entry.count = min === max ? min : [min, max];
      }
    }
    if (info.connection) {
      const totals = ctx.accs.get(`${path}.totalCount`)?.values.filter((v) => Number.isInteger(v) && v >= 0) ?? [];
      if (totals.length && !fromDirective("count")) {
        const min = Math.min(...totals);
        const max = Math.max(...totals);
        entry.count = min === max ? min : [min, max];
      } else if (!totals.length) ctx.notes.push({ path, kind: "skipped", message: "a connection without totalCount: its size is unknown" });
    }
    if (acc.nulls > 0 && acc.present > 0 && !fromDirective("nullRate")) {
      entry.nullRate = acc.nulls === acc.present ? 1 : Math.max(0.001, r3(acc.nulls / acc.present));
    }
    if (info.kind === "scalar" && acc.values.length > 0 && !acc.opaque) {
      const learned = learnValues(ctx, acc);
      if (learned) Object.assign(entry, learned);
    }
    if (Object.keys(entry).length) spec[path] = entry;
  }
  compileSpec(spec); // what we hand back must be a valid spec
  return { spec, notes: ctx.notes };
}

/**
 * Infer a side-car spec from real responses to a query.
 *
 * Learns list sizes (`count`), null rates (`nullRate`), integer and float ranges, boolean ratios,
 * date ranges, string lengths and ID/code formats (`pattern`). Free text is never copied: enum-like
 * value sets only appear in the spec when `allowValues` permits (or when the schema declares the enum).
 * @param {string|import("graphql").DocumentNode} query
 * @param {any} samples one response or an array of responses (`data` objects or `{ data }`)
 * @param {{ schema?: any, allowValues?: boolean|string[], maxEnum?: number, anchorDate?: string|Date, operationName?: string, variables?: Record<string, unknown> }} [opts]
 * @returns {Record<string, any>} a plain spec object, ready to commit
 */
export function specFromSamples(query, samples, opts = {}) {
  return analyzeSamples(query, samples, opts).spec;
}
