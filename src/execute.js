// Execution: graphql-js `execute` over the inferred schema with keyed resolvers
// (docs/design.md section 8; key rules in sections 2 and 3).
import { buildSchema, execute, validate } from "graphql";
import { GraceholderError } from "./errors.js";
import { keyStream, KEY_SCHEME } from "./key.js";
import { xxh64 } from "./xxh64.js";
import { generate } from "./generators.js";
import { encodeCursor, decodeCursor } from "./cursor.js";
import { argsKeyOf, entityKeyFromArgs } from "./args.js";
import { classifyScalar } from "./rules.js";
import { tokenize } from "./naming.js";

export const POOL_SIZE = 100;
export const ENDLESS_TOTAL = 1000;
const MAX_WINDOW = 10000;
const ROOT = "Query";
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
 * @returns {{ start: number, count: number, total: number|null, endless: boolean }}
 *   `start` is 1-based; `total` is the finite size of the collection, if it has one.
 */
export function windowOf(args, n, { connection }) {
  const has = (k) => args[k] !== undefined && args[k] !== null;
  const cap = (count) => {
    if (count > MAX_WINDOW) throw bad(`a window of ${count} items exceeds the limit of ${MAX_WINDOW}`);
    return count;
  };
  const paged = ["first", "last", "after", "before", "offset", "limit", "skip", "take", "page", "pageSize", "perPage"].some(has);
  const endlessTotal = connection ? ENDLESS_TOTAL : null;
  if (!paged) return { start: 1, count: n, total: connection ? endlessTotal : n, endless: Boolean(connection) };

  if (has("page")) {
    const size = nonNegInt(args, "pageSize") ?? nonNegInt(args, "perPage") ?? n;
    const page = nonNegInt(args, "page", 1);
    return { start: (page - 1) * size + 1, count: cap(size), total: endlessTotal, endless: true };
  }
  if (has("offset") || has("skip") || ((has("limit") || has("take")) && !has("first") && !has("last"))) {
    const off = nonNegInt(args, "offset") ?? nonNegInt(args, "skip") ?? 0;
    const size = nonNegInt(args, "limit") ?? nonNegInt(args, "take") ?? n;
    return { start: off + 1, count: cap(size), total: endlessTotal, endless: true };
  }
  const first = nonNegInt(args, "first");
  const last = nonNegInt(args, "last");
  const after = has("after") ? decodeCursor(args.after) : undefined;
  const before = has("before") ? decodeCursor(args.before) : undefined;
  if (first === undefined && last !== undefined) {
    if (before !== undefined) {
      const end = before - 1;
      const start = Math.max(1, end - last + 1);
      return { start, count: cap(Math.max(0, end - start + 1)), total: endlessTotal, endless: true };
    }
    // the last items of a finite collection
    const start = Math.max(1, n - last + 1);
    return { start, count: cap(n - start + 1), total: n, endless: false };
  }
  const start = (after ?? 0) + 1;
  let count = first ?? n;
  if (before !== undefined) count = Math.min(count, Math.max(0, before - start));
  return { start, count: cap(count), total: endlessTotal, endless: true };
}

/**
 * @param {{ sdl: string, document: any, model: Map<string, Map<string, any>>, abstracts: Map<string, any> }} inferred
 * @param {{ seed: string|number, anchorMs: number, locale?: string, variables?: Record<string, unknown> }} opts
 * @returns {import("graphql").ExecutionResult}
 */
export function run(inferred, opts) {
  const schema = buildSchema(inferred.sdl);
  const invalid = validate(schema, inferred.document);
  if (invalid.length) return { errors: invalid };

  const key = (scope, typeName, entityKey, fieldName, subKeys) => ({ seed: opts.seed, scope, typeName, entityKey, fieldName, subKeys });
  const sub = (argsKey) => (argsKey ? [argsKey] : undefined);

  const count = (parent, entityKey, fieldName, argsKey) => keyStream(key("l", parent, entityKey, fieldName, sub(argsKey))).int(3, 10);

  /** Generate one scalar; `personaKey` is the entity whose persona slots the generator reads. */
  const scalar = (f, parent, entityKey, fieldName, subKeys, personaKey = entityKey) => {
    if (f.gen === "count.of") return count(parent, entityKey, f.genArgs.of, "");
    if (f.gen.startsWith("order.")) return orderMoney(f.gen, parent, entityKey);
    return generate(f.gen, {
      stream: keyStream(key("e", parent, entityKey, fieldName, subKeys)),
      slot: (name) => keyStream(key("p", parent, personaKey, name)),
      anchorMs: opts.anchorMs,
      args: f.genArgs,
      typeName: parent,
      entityKey,
      fieldName,
      locale: opts.locale,
    });
  };

  const fieldOrDefault = (type, name, alt) => {
    const fields = inferred.model.get(type);
    for (const n of [name, alt]) if (n && fields?.has(n)) return fields.get(n);
    const c = classifyScalar(name, { typeName: type, list: false });
    return { kind: "scalar", list: false, gen: c.gen, genArgs: c.args };
  };

  /** subtotal = sum(items price * quantity) over the whole collection; total = subtotal + tax (integer cents). */
  const orderMoney = (gen, parent, entityKey) => {
    const itemsField = [...(inferred.model.get(parent)?.values() ?? [])].find(
      (x) => x.kind === "object" && x.list && !x.synthetic && ["items", "lines"].includes(tokenize(x.name).at(-1)),
    );
    // without a selected items field, assume the conventional `items` collection of `Item`
    const itemsName = itemsField?.name ?? "items";
    const itemType = itemsField?.typeName ?? "Item";
    const n = count(parent, entityKey, itemsName, "");
    const keyOf = memberKeyFn(parent, entityKey, itemsName, "");
    const price = fieldOrDefault(itemType, "price");
    const qty = fieldOrDefault(itemType, "quantity", "qty");
    let subCents = 0;
    for (let i = 1; i <= n; i++) {
      const member = keyOf(i);
      subCents += Math.round(scalar(price, itemType, member, "price") * 100) * scalar(qty, itemType, member, "quantity");
    }
    const taxCents = Math.round((subCents * keyStream(key("p", parent, entityKey, "taxRate")).int(0, 12)) / 100);
    if (gen === "order.subtotal") return subCents / 100;
    if (gen === "order.tax") return taxCents / 100;
    return (subCents + taxCents) / 100;
  };

  /** Keys of the members of a collection: shared pool at the top level, owned elsewhere. */
  const memberKeyFn = (parent, entityKey, fieldName, argsKey) => {
    const prefix = argsKey ? `f${xxh64(encoder.encode(`${KEY_SCHEME}\x1f${argsKey}`)).toString(16).padStart(16, "0").slice(0, 8)}.` : "";
    return parent === ROOT ? (i) => `${prefix}${i}` : (i) => `${entityKey}.${fieldName}.${prefix}${i}`;
  };

  /** Resolve a (possibly paged) collection field to its window of member keys. */
  const collection = (f, parent, entityKey, fieldName, args) => {
    const idsArg = Array.isArray(args.ids) ? args.ids : undefined;
    if (idsArg && !f.connection) {
      const keys = idsArg.map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
      return { start: 1, count: keys.length, total: keys.length, endless: false, memberKey: (i) => keys[i - 1] };
    }
    const argsKey = argsKeyOf(args);
    const n = count(parent, entityKey, fieldName, argsKey);
    const win = windowOf(args, n, { connection: Boolean(f.connection) });
    return { ...win, memberKey: memberKeyFn(parent, entityKey, fieldName, argsKey) };
  };

  const fieldResolver = (source, args, _ctx, info) => {
    const parent = info.parentType.name;
    const fieldName = info.fieldName;
    const f = inferred.model.get(parent)?.get(fieldName);
    if (!f) return undefined;
    const entityKey = source.entityKey;

    switch (f.special) {
      case "edges": {
        const c = source.conn;
        return Array.from({ length: c.count }, (_, k) => ({ typeName: f.typeName, entityKey, index: c.start + k, itemKey: c.memberKey(c.start + k) }));
      }
      case "nodes": {
        const c = source.conn;
        return Array.from({ length: c.count }, (_, k) => ({ typeName: f.typeName, entityKey: c.memberKey(c.start + k) }));
      }
      case "pageInfo": return { typeName: f.typeName, entityKey, conn: source.conn };
      case "totalCount": return source.conn.total ?? ENDLESS_TOTAL;
      case "cursor": return encodeCursor(source.index);
      case "edgeNode": return { typeName: f.typeName, entityKey: source.itemKey };
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

    const argsKey = argsKeyOf(args);
    if (f.kind === "scalar") {
      if (!f.list) return scalar(f, parent, entityKey, fieldName, sub(argsKey));
      const n = count(parent, entityKey, fieldName, argsKey);
      return Array.from({ length: n }, (_, i) => scalar(f, parent, entityKey, fieldName, argsKey ? [argsKey, i] : [i], `${entityKey}.${fieldName}.${i + 1}`));
    }
    if (f.connection) {
      const conn = collection(f, parent, entityKey, fieldName, args);
      return { typeName: f.typeName, entityKey: `${entityKey}.${fieldName}`, conn };
    }
    if (f.list) {
      const c = collection(f, parent, entityKey, fieldName, args);
      return Array.from({ length: c.count }, (_, k) => ({ typeName: f.typeName, entityKey: c.memberKey(c.start + k) }));
    }
    // singular: identifying arguments select the entity; top-level fields are entity 1;
    // otherwise a stable reference into the pool of the type (E2)
    const selected = entityKeyFromArgs(args);
    const k = selected ?? (parent === ROOT ? "1" : String(keyStream(key("l", parent, entityKey, fieldName, sub(argsKey))).int(1, POOL_SIZE)));
    return { typeName: f.typeName, entityKey: k };
  };

  const typeResolver = (value, _ctx, _info, abstractType) => {
    const a = inferred.abstracts.get(abstractType.name);
    return keyStream(key("e", abstractType.name, value.entityKey, "__typename")).pick(a.possible);
  };

  /** @type {any} */
  const result = execute({
    schema,
    document: inferred.document,
    rootValue: { typeName: ROOT, entityKey: ROOT },
    variableValues: opts.variables,
    fieldResolver,
    typeResolver,
  });
  if (typeof result?.then === "function") {
    throw new GraceholderError("internal", "graceholder resolvers must be synchronous");
  }
  return result;
}
