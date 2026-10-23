// Execution: graphql-js `execute` over the inferred schema with keyed resolvers
// (docs/design.md section 8; key rules in sections 2 and 3).
import { buildSchema, execute, validate } from "graphql";
import { GraceholderError } from "./errors.js";
import { keyStream, KEY_SCHEME } from "./key.js";
import { xxh64 } from "./xxh64.js";
import { generate, asciiFold } from "./generators.js";
import { encodeCursor, decodeCursor } from "./cursor.js";
import { argsKeyOf, entityKeyFromArgs } from "./args.js";
import { classifyScalar, isSeriesType } from "./rules.js";
import { tokenize, typeNameFor } from "./naming.js";

export const POOL_SIZE = 100;
export const ENDLESS_TOTAL = 1000;
const MAX_WINDOW = 10000;
const encoder = new TextEncoder();

const bad = (msg, path) => new GraceholderError("bad-arguments", msg, { path });

function nonNegInt(args, name, min = 0) {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (!Number.isInteger(v) || v < min) throw bad(`argument ${name} must be an integer >= ${min}, got ${JSON.stringify(v)}`);
  return v;
}

/**
 * Window selection from paging arguments (docs/design.md 3.4).
 * `declared` means the collection has a declared total `n` (@count or spec), so it has a real end.
 * `defaultSize` is the page size when no size argument is given (default: `n`).
 * @param {Record<string, any>} args
 * @param {number} n
 * @param {{ connection?: any, declared?: boolean, endlessTotal?: number, defaultSize?: number }} opts
 * @returns {{ start: number, count: number, total: number|null, endless: boolean }}
 *   `start` is 1-based; `total` is the finite size of the collection, if it has one.
 */
export function windowOf(args, n, { connection, declared = false, endlessTotal = ENDLESS_TOTAL, defaultSize }) {
  const dflt = defaultSize ?? n; // the page size when none is given
  const has = (k) => args[k] !== undefined && args[k] !== null;
  const cap = (count) => {
    if (count > MAX_WINDOW) throw bad(`a window of ${count} items exceeds the limit of ${MAX_WINDOW}`);
    return count;
  };
  const finish = (w) => {
    if (!declared) return w;
    const end = Math.min(w.start + w.count - 1, n);
    return { start: w.start, count: Math.max(0, end - w.start + 1), total: n, endless: false };
  };
  const paged = ["first", "last", "after", "before", "offset", "limit", "skip", "take", "page", "pageSize", "perPage"].some(has);
  const total = connection ? endlessTotal : null;
  if (!paged) return finish({ start: 1, count: connection ? dflt : n, total: connection ? total : n, endless: Boolean(connection) });

  // Exactly one size argument, one offset argument, and one style (page, offset or relay).
  const sizeNames = ["first", "limit", "take", "pageSize", "perPage"].filter(has);
  const offsetNames = ["offset", "skip"].filter(has);
  const conflict = (why) => bad(`conflicting paging arguments (${why}): ${["first", "last", "after", "before", "offset", "skip", "limit", "take", "page", "pageSize", "perPage"].filter(has).join(", ")}`);
  if (sizeNames.length > 1) throw conflict("one size argument only");
  if (offsetNames.length > 1) throw conflict("one of offset or skip");
  const pageStyle = has("page") || has("pageSize") || has("perPage");
  if (pageStyle) {
    if (!has("page")) throw conflict("pageSize/perPage need page");
    if (offsetNames.length || has("last") || has("after") || has("before") || ["first", "limit", "take"].some(has)) throw conflict("page cannot be combined with other styles");
  } else if (offsetNames.length) {
    if (has("last") || has("after") || has("before")) throw conflict("offset/skip cannot be combined with cursors");
  } else if (has("last") && sizeNames.length) {
    throw conflict("last cannot be combined with a size");
  } else if (!has("last") && (has("limit") || has("take")) && (has("after") || has("before"))) {
    throw conflict("limit/take cannot be combined with cursors; use first");
  }
  const size = sizeNames.length ? nonNegInt(args, sizeNames[0]) : undefined;

  if (pageStyle) {
    const page = nonNegInt(args, "page", 1);
    const count = size ?? dflt;
    return finish({ start: (page - 1) * count + 1, count: cap(count), total, endless: true });
  }
  if (offsetNames.length || ((has("limit") || has("take")) && !has("last"))) {
    const off = offsetNames.length ? nonNegInt(args, offsetNames[0]) : 0;
    return finish({ start: off + 1, count: cap(size ?? dflt), total, endless: true });
  }
  const first = size;
  const last = nonNegInt(args, "last");
  const after = has("after") ? decodeCursor(args.after) : undefined;
  const before = has("before") ? decodeCursor(args.before) : undefined;
  if (first === undefined && last !== undefined) {
    if (before !== undefined) {
      const end = before - 1;
      const start = Math.max(1, end - last + 1);
      return finish({ start, count: cap(Math.max(0, end - start + 1)), total, endless: true });
    }
    // the last items of a finite collection
    const start = Math.max(1, n - last + 1);
    return { start, count: cap(n - start + 1), total: n, endless: false };
  }
  const start = (after ?? 0) + 1;
  let count = first ?? dflt;
  if (before !== undefined) count = Math.min(count, Math.max(0, before - start));
  return finish({ start, count: cap(count), total, endless: true });
}

const NO_VALUE = Object.freeze({ has: false, value: undefined });
const PAGING_KEYS = ["first", "last", "after", "before", "offset", "limit", "skip", "take", "page", "pageSize", "perPage"];
const CREATED_FIELDS = new Set(["createdAt", "created_at", "createdOn", "created"]);
const UPDATED_FIELDS = new Set(["updatedAt", "updated_at", "updatedOn", "modifiedAt", "modified_at", "updated"]);

const slugify = (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * @param {{ sdl: string, document: any, model: Map<string, Map<string, any>>, abstracts: Map<string, any>, opSeed?: string, schema?: import("graphql").GraphQLSchema, rootType?: string }} inferred
 * @param {{ seed: string|number, anchorMs: number, locale?: string, variables?: Record<string, unknown>, poolSize?: number, endlessTotal?: number, world?: any, trace?: (path: any, value: any) => void, images?: "url"|"svg", packs?: any[], realistic?: boolean }} opts
 * @returns {import("graphql").ExecutionResult}
 */
export function run(inferred, opts) {
  const schema = inferred.schema ?? buildSchema(inferred.sdl);
  const invalid = validate(schema, inferred.document);
  if (invalid.length) return { errors: invalid };
  const packs = opts.packs ?? [];
  const realistic = Boolean(opts.realistic);
  /** geo-style types (`address`, `location`) share their parent's persona so the parent's and the address's city agree */
  const inherits = (typeName) => packs.some((p) => p.inherit?.(typeName));
  const ROOT = inferred.rootType ?? "Query";
  const poolSize = opts.poolSize ?? POOL_SIZE;
  const endlessTotal = opts.endlessTotal ?? ENDLESS_TOTAL;
  const rootSeed = inferred.opSeed ?? opts.seed;
  const ws = opts.world;
  const anchorIso = new Date(opts.anchorMs).toISOString();

  const K = (seed, scope, typeName, entityKey, fieldName, subKeys) => ({ seed, scope, typeName, entityKey, fieldName, subKeys });
  const sub = (argsKey) => (argsKey ? [argsKey] : undefined);
  const fieldOf = (type, name) => inferred.model.get(type)?.get(name);

  /** Collection size: a declared @count/spec count, else a keyed 3 to 10. */
  const count = (seed, parent, entityKey, fieldName, argsKey) => {
    const declared = fieldOf(parent, fieldName)?.count;
    const stream = keyStream(K(seed, "l", parent, entityKey, fieldName, sub(argsKey)));
    if (declared?.n !== undefined) return declared.n;
    if (declared) return stream.int(declared.min, declared.max);
    // a time series reads better with some history
    return realistic && fieldOf(parent, fieldName)?.kind === "object" && isSeriesType(fieldOf(parent, fieldName).typeName) ? stream.int(14, 60) : stream.int(3, 10);
  };

  /** Generate one scalar; `personaKey` is the entity whose persona slots the generator reads. */
  const scalar = (seed, f, parent, entityKey, fieldName, subKeys, personaKey = entityKey, extra = {}) => {
    if (fieldName === "qty") fieldName = "quantity"; // one latent quantity per item, whichever name is selected
    if (ws) {
      const o = worldValue(parent, entityKey, fieldName);
      if (o.has) return o.value;
    }
    if (f.derive !== undefined) return derived(seed, f, parent, entityKey, fieldName, subKeys, personaKey, extra);
    if (f.gen === "count.of") return siblingView(seed, parent, entityKey, f.genArgs.of, fieldOf(parent, f.genArgs.of)).size;
    if (f.gen.startsWith("order.")) return orderMoney(seed, f.gen, parent, entityKey);
    return generate(f.gen, genCtx(seed, f, parent, entityKey, fieldName, subKeys, personaKey, extra));
  };

  /** A pinned or mutated value of one field of one entity (docs/design.md section 16, World). */
  const worldValue = (parent, entityKey, fieldName) => {
    const rec = ws.entity(parent, entityKey);
    if (!rec) return NO_VALUE;
    const name = fieldName === "quantity" || fieldName === "qty" ? "quantity" : fieldName;
    if (Object.hasOwn(rec.fields, name)) return { has: true, value: rec.fields[name] };
    if (rec.created && CREATED_FIELDS.has(name)) return { has: true, value: anchorIso };
    if ((rec.created || rec.updated) && UPDATED_FIELDS.has(name)) return { has: true, value: anchorIso };
    return NO_VALUE;
  };

  /** Pinned first/last names of a persona, from a pinned first/last/full-name field. */
  const personaCache = new Map();
  const personaPins = (parent, entityKey) => {
    const ck = `${parent}\u0000${entityKey}`;
    if (personaCache.has(ck)) return personaCache.get(ck);
    let out;
    const rec = ws.entity(parent, entityKey);
    if (rec) {
      let first;
      let last;
      let full;
      for (const [name, value] of Object.entries(rec.fields)) {
        if (typeof value !== "string" || value.trim() === "") continue;
        const gen = fieldOrDefault(parent, name).gen;
        if (gen === "person.first") first = value.trim();
        else if (gen === "person.last") last = value.trim();
        else if (gen === "person.full") full = value.trim();
      }
      if (full !== undefined) {
        const parts = full.split(/\s+/);
        first ??= parts[0];
        if (parts.length > 1) last ??= parts[parts.length - 1];
      }
      if (first !== undefined || last !== undefined) out = { first, last };
    }
    personaCache.set(ck, out);
    return out;
  };

  const genCtx = (seed, f, parent, entityKey, fieldName, subKeys, personaKey, extra = {}) => ({
    pinned: ws ? personaPins(extra.personaType ?? parent, personaKey) : undefined,
    stream: keyStream(K(seed, "e", parent, entityKey, fieldName, subKeys)),
    slot: (name) => keyStream(K(seed, "p", extra.personaType ?? parent, personaKey, name)),
    series: extra.series && { i: extra.series.i, n: extra.series.n, slot: (name) => keyStream(K(seed, "p", parent, extra.series.key, name)) },
    images: opts.images,
    packs,
    anchorMs: opts.anchorMs,
    args: f.genArgs,
    typeName: parent,
    entityKey,
    fieldName,
    locale: opts.locale,
  });

  const fieldOrDefault = (type, name, alt) => {
    const fields = inferred.model.get(type);
    for (const n of [name, alt]) if (n && fields?.has(n)) return fields.get(n);
    const c = classifyScalar(name, { typeName: type, list: false, packs, realistic });
    return { kind: "scalar", list: false, gen: c.gen, genArgs: c.args };
  };

  /** @derive: the source field's value of the same entity, shaped by this field's own generator kind. */
  const derived = (seed, f, parent, entityKey, fieldName, subKeys, personaKey, extra) => {
    const srcInfo = fieldOrDefault(parent, f.derive);
    const value = scalar(seed, srcInfo, parent, entityKey, f.derive, undefined, personaKey, extra);
    if (value === null || value === undefined) return value;
    if (f.gen === "slug") return slugify(value);
    if (f.gen === "person.username") return asciiFold(String(value));
    if (f.gen === "person.email") {
      const domain = String(generate("person.email", genCtx(seed, f, parent, entityKey, fieldName, subKeys, personaKey, extra))).split("@")[1];
      return `${asciiFold(String(value))}@${domain}`;
    }
    return value;
  };

  /** subtotal = sum(items price * latent quantity) over the whole collection; total = subtotal + tax (integer cents). */
  const orderMoney = (seed, gen, parent, entityKey) => {
    const itemsField = [...(inferred.model.get(parent)?.values() ?? [])].find(
      (x) => x.kind === "object" && x.list && !x.synthetic && ["items", "lines"].includes(tokenize(x.name).at(-1)),
    );
    // without a selected items field, assume the conventional `items` collection of `Item`
    const itemsName = itemsField?.name ?? "items";
    const itemType = itemsField?.typeName ?? "Item";
    const view = siblingView(seed, parent, entityKey, itemsName, itemsField);
    const n = view.size;
    const keyOf = view.keyAt;
    const price = fieldOrDefault(itemType, "price");
    // every item has a latent quantity keyed by the item (the same value whether `quantity`, `qty`
    // or nothing is selected), so aggregates never depend on the selection
    const qty = fieldOrDefault(itemType, "quantity", "qty");
    let subCents = 0;
    for (let i = 1; i <= n; i++) {
      const member = keyOf(i);
      subCents += Math.round(scalar(seed, price, itemType, member, "price") * 100) * scalar(seed, qty, itemType, member, "quantity");
    }
    const taxCents = Math.round((subCents * keyStream(K(seed, "p", parent, entityKey, "taxRate")).int(0, 12)) / 100);
    if (gen === "order.subtotal") return subCents / 100;
    if (gen === "order.tax") return taxCents / 100;
    return (subCents + taxCents) / 100;
  };

  /** Keys of the members of a collection: shared pool at the top level, owned elsewhere. */
  const memberKeyFn = (parent, entityKey, fieldName, argsKey, f) => {
    const prefix = argsKey ? `f${xxh64(encoder.encode(`${KEY_SCHEME}\x1f${argsKey}`)).toString(16).padStart(16, "0").slice(0, 8)}.` : "";
    const shared = f.own ? false : (f.shared ?? parent === ROOT);
    return shared ? (i) => `${prefix}${i}` : (i) => `${entityKey}.${fieldName}.${prefix}${i}`;
  };

  /**
   * The effective members of a collection once the world has created or deleted entities of its
   * item type (docs/design.md section 16, World): base members minus deleted ones, created ones added at the
   * end (finite collections) or the start (endless ones). null when the world does not touch it.
   * `baseSize` is the size of the base sequence.
   */
  const overlay = (f, parent, entityKey, argsKey, memberKey, baseSize, endless) => {
    if (!ws || !f || f.kind !== "object" || f.abstract) return null;
    const itemType = f.connection ? f.connection.item : f.typeName;
    if (!ws.touches(itemType)) return null;
    const shared = f.own ? false : (f.shared ?? parent === ROOT);
    const prefix = memberKey(0).slice(0, -1);
    const dead = [];
    for (const key of ws.deletedKeys(itemType)) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (/^[1-9][0-9]*$/.test(rest) && Number(rest) <= baseSize) dead.push(Number(rest));
    }
    dead.sort((a, b) => a - b);
    const extra = argsKey ? [] : shared ? ws.createdKeys(itemType) : ws.relatedKeys(itemType, parent, entityKey);
    const atStart = (ws.position ?? (endless ? "start" : "end")) === "start";
    const added = atStart ? [...extra].reverse() : extra;
    const live = baseSize - dead.length;
    const baseAt = (i) => {
      let j = i;
      for (const d of dead) {
        if (d <= j) j++;
        else break;
      }
      return memberKey(j);
    };
    const keyAt = atStart
      ? (i) => (i <= added.length ? added[i - 1] : baseAt(i - added.length))
      : (i) => (i > live ? added[i - live - 1] : baseAt(i));
    return { size: live + added.length, keyAt };
  };

  /** Unpaged, unfiltered view of the sibling collection `of` of an entity (counts, order items). */
  const siblingView = (seed, parent, entityKey, name, info) => {
    const n = count(seed, parent, entityKey, name, "");
    const memberKey = memberKeyFn(parent, entityKey, name, "", info ?? {});
    const f = info ?? { kind: "object", list: true, typeName: typeNameFor(name) };
    const ov = overlay(f, parent, entityKey, "", memberKey, n, false);
    return ov ?? { size: n, keyAt: memberKey };
  };

  /** Resolve a (possibly paged) collection field to its window of member keys. */
  const collection = (seed, f, parent, entityKey, fieldName, args) => {
    const idsArg = Array.isArray(args.ids) ? args.ids : undefined;
    if (idsArg && !f.connection) {
      const keys = idsArg.map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
      return { start: 1, count: keys.length, total: keys.length, endless: false, memberKey: (i) => keys[i - 1] };
    }
    const argsKey = argsKeyOf(args);
    const n = count(seed, parent, entityKey, fieldName, argsKey);
    const memberKey = memberKeyFn(parent, entityKey, fieldName, argsKey, f);
    if (ws) {
      // with a world that touches the item type the collection gets a real end: its base size
      // (n, or the endless total for paged lists and connections) plus the created, minus the deleted
      const declared = Boolean(f.count);
      const paged = PAGING_KEYS.some((k) => args[k] !== undefined && args[k] !== null);
      const endless = !declared && (Boolean(f.connection) || paged);
      const ov = overlay(f, parent, entityKey, argsKey, memberKey, endless ? endlessTotal : n, endless);
      if (ov) {
        const win = windowOf(args, ov.size, { connection: Boolean(f.connection), declared: true, endlessTotal, defaultSize: declared ? ov.size : n });
        return { ...win, memberKey: ov.keyAt };
      }
    }
    const win = windowOf(args, n, { connection: Boolean(f.connection), declared: Boolean(f.count), endlessTotal });
    return { ...win, memberKey };
  };

  const fieldResolver = (source, args, _ctx, info) => {
    const parent = info.parentType.name;
    const fieldName = info.fieldName;
    const f = fieldOf(parent, fieldName);
    if (!f) return undefined;
    const entityKey = source.entityKey;
    const seed = f.seed ?? source.seed ?? rootSeed;
    const ref = (typeName, key, extra) => ({ typeName, entityKey: key, seed, ...extra });
    // a geo-style child shares the persona of the entity that owns it (see `inherits`)
    const personaOf = source.persona ?? { type: parent, key: entityKey };
    const personaFor = (typeName) => (inherits(typeName) ? { persona: personaOf } : undefined);

    switch (f.special) {
      case "edges": {
        const c = source.conn;
        return Array.from({ length: c.count }, (_, k) => ({ typeName: f.typeName, entityKey, seed, index: c.start + k, itemKey: c.memberKey(c.start + k) }));
      }
      case "nodes": {
        const c = source.conn;
        return Array.from({ length: c.count }, (_, k) => ref(f.typeName, c.memberKey(c.start + k)));
      }
      case "pageInfo": return { typeName: f.typeName, entityKey, seed, conn: source.conn };
      case "totalCount": return source.conn.total ?? endlessTotal;
      case "cursor": return encodeCursor(source.index);
      case "edgeNode": return ref(f.typeName, source.itemKey);
      case "pageInfoField": {
        const c = source.conn;
        const end = c.start + c.count - 1;
        if (fieldName === "hasNextPage") return c.endless || (c.total !== null && end < c.total);
        if (fieldName === "hasPreviousPage") return c.start > 1;
        if (c.count === 0) return null;
        return encodeCursor(fieldName === "startCursor" ? c.start : end);
      }
      default:
    }

    if (ws && f.kind === "scalar") {
      const o = worldValue(parent, entityKey, fieldName);
      if (o.has) return o.value;
    }
    if (f.nullRate !== undefined && keyStream(K(seed, "e", parent, entityKey, fieldName, ["null"])).float() < f.nullRate) return null;

    const argsKey = argsKeyOf(args);
    if (f.kind === "scalar") {
      const own = source.persona ? { personaType: source.persona.type } : {};
      if (!f.list) return scalar(seed, f, parent, entityKey, fieldName, sub(argsKey), source.persona?.key ?? entityKey, { ...own, series: source.series && { ...source.series } });
      const n = count(seed, parent, entityKey, fieldName, argsKey);
      return Array.from({ length: n }, (_, i) => scalar(seed, f, parent, entityKey, fieldName, argsKey ? [argsKey, i] : [i], `${entityKey}.${fieldName}.${i + 1}`));
    }
    if (f.connection) {
      const conn = collection(seed, f, parent, entityKey, fieldName, args);
      return { typeName: f.typeName, entityKey: `${entityKey}.${fieldName}`, seed, conn };
    }
    if (f.list) {
      const c = collection(seed, f, parent, entityKey, fieldName, args);
      if (realistic && isSeriesType(f.typeName)) {
        // one series per owning entity, field and filter; each point knows its position and the series length
        const n = count(seed, parent, entityKey, fieldName, argsKey);
        const key = `${entityKey}.${fieldName}${argsKey ? `.${argsKey}` : ""}`;
        return Array.from({ length: c.count }, (_, k) => ref(f.typeName, c.memberKey(c.start + k), { series: { i: c.start + k, n, key } }));
      }
      return Array.from({ length: c.count }, (_, k) => ref(f.typeName, c.memberKey(c.start + k)));
    }
    // singular: identifying arguments select the entity; top-level fields are entity 1;
    // otherwise a stable reference into the pool of the type (E2), or an owned entity
    const selected = entityKeyFromArgs(args, f.keyArgs);
    const child = personaFor(f.typeName);
    const k =
      selected ??
      (f.own || (child && parent !== ROOT)
        ? `${entityKey}.${fieldName}`
        : parent === ROOT ? "1" : String(keyStream(K(seed, "l", parent, entityKey, fieldName, sub(argsKey))).int(1, poolSize)));
    if (ws && !f.abstract && ws.isDeleted(f.typeName, k)) return null;
    return ref(f.typeName, k, selected === undefined && parent !== ROOT ? child : undefined);
  };

  const typeResolver = (value, _ctx, _info, abstractType) => {
    const a = inferred.abstracts.get(abstractType.name);
    return keyStream(K(value.seed ?? rootSeed, "e", abstractType.name, value.entityKey, "__typename")).pick(a.possible);
  };

  // bulk SQL needs the entity key of every object in the result, which the plain data does not carry
  const tracer = opts.trace;
  const resolve = tracer
    ? (source, args, ctx, info) => {
        const out = fieldResolver(source, args, ctx, info);
        if (out !== null && typeof out === "object") tracer(info.path, out);
        return out;
      }
    : fieldResolver;

  /** @type {any} */
  const result = execute({
    schema,
    document: inferred.document,
    rootValue: { typeName: ROOT, entityKey: ROOT, seed: rootSeed },
    variableValues: opts.variables,
    fieldResolver: resolve,
    typeResolver,
  });
  if (typeof result?.then === "function") {
    throw new GraceholderError("internal", "graceholder resolvers must be synchronous");
  }
  return result;
}
