// Bulk generation: a query's root collection as a lazy, windowed stream (docs/design.md section 19).
// Item k of the stream is item k of the equivalent windowed query `field(offset: k, first: 1)`.
import { Kind, buildSchema, visit } from "graphql";
import { GraceholderError } from "../errors.js";
import { prepare } from "../generate.js";
import { run } from "../execute.js";
import { selectOperation, toDocument } from "../infer.js";
import { PAGING_ARGS } from "../args.js";
import { encodeCursor } from "../cursor.js";

export const MAX_CHUNK = 10000;
const DEFAULT_CHUNK = 500;

const bad = (msg, extra) => new GraceholderError("bad-options", msg, extra);
const name = (value) => ({ kind: Kind.NAME, value });

/** Paging argument styles tried in order; schema mode may only declare some of them. */
const STYLES = [
  ["offset", "first"],
  ["skip", "take"],
  ["offset", "limit"],
  ["skip", "limit"],
  ["skip", "first"],
  ["after", "first"],
];

function argument(argName, n) {
  const value = argName === "after" ? { kind: Kind.STRING, value: encodeCursor(n) } : { kind: Kind.INT, value: String(n) };
  return { kind: Kind.ARGUMENT, name: name(argName), value };
}

/** The window arguments of a chunk: `offset` items skipped, `size` items wanted. */
const windowArgs = (style, offset, size) => [argument(style[0], offset), argument(style[1], size)];

function usedVariables(nodes) {
  const used = new Set();
  for (const n of nodes) visit(n, { VariableDefinition: () => false, Variable: (v) => void used.add(v.name.value) });
  return used;
}

/** The operation reduced to one root field, windowed by `style`, with the unused variables dropped. */
function singleFieldDocument(doc, op, field, style) {
  const kept = (field.arguments ?? []).filter((a) => !PAGING_ARGS.has(a.name.value));
  const windowed = { ...field, arguments: [...kept, ...windowArgs(style, 0, 1)] };
  const fragments = doc.definitions.filter((d) => d.kind === Kind.FRAGMENT_DEFINITION);
  const newOp = { ...op, selectionSet: { ...op.selectionSet, selections: [windowed] } };
  const used = usedVariables([newOp, ...fragments]);
  return {
    ...doc,
    definitions: [{ ...newOp, variableDefinitions: (op.variableDefinitions ?? []).filter((d) => used.has(d.variable.name.value)) }, ...fragments],
  };
}

const rootFieldNodes = (op) => op.selectionSet.selections.filter((s) => s.kind === Kind.FIELD && !s.name.value.startsWith("__"));
const responseKey = (f) => f.alias?.value ?? f.name.value;

/** Add every scalar the model knows for a type to each selection of that type (SQL needs one column set per type). */
export function normalizeSelections(doc, model, rootField) {
  const scalarsOf = (typeName) => {
    const out = [];
    for (const [n, f] of model.get(typeName) ?? []) {
      if (f.kind === "scalar" && !f.special && Object.keys(f.args ?? {}).length === 0) out.push(n);
    }
    return out;
  };
  const rewrite = (selSet, typeName) => {
    const selections = selSet.selections.map((s) => {
      if (s.kind === Kind.FIELD && s.selectionSet) {
        const f = model.get(typeName)?.get(s.name.value);
        return f?.kind === "object" ? { ...s, selectionSet: rewrite(s.selectionSet, f.typeName) } : s;
      }
      if (s.kind === Kind.INLINE_FRAGMENT) return { ...s, selectionSet: rewrite(s.selectionSet, s.typeCondition?.name.value ?? typeName) };
      return s;
    });
    const have = new Set(selections.filter((s) => s.kind === Kind.FIELD).map((s) => s.name.value));
    for (const n of scalarsOf(typeName)) {
      if (!have.has(n)) selections.push({ kind: Kind.FIELD, name: name(n), arguments: [], directives: [] });
    }
    return { ...selSet, selections };
  };
  const [opDef0, ...rest] = doc.definitions;
  const opDef = /** @type {any} */ (opDef0);
  const f = opDef.selectionSet.selections[0];
  const rootModel = model.get(rootField.parentType)?.get(f.name.value);
  const newField = f.selectionSet && rootModel?.kind === "object" ? { ...f, selectionSet: rewrite(f.selectionSet, rootModel.typeName) } : f;
  const defs = rest.map((d) => (d.kind === Kind.FRAGMENT_DEFINITION ? { ...d, selectionSet: rewrite(d.selectionSet, d.typeCondition.name.value) } : d));
  return { ...doc, definitions: [{ ...opDef, selectionSet: { ...opDef.selectionSet, selections: [newField] } }, ...defs] };
}

/**
 * @param {any} query
 * @param {any} options stream options (see docs/api.md)
 * @param {any} [world]
 * @param {{ normalize?: boolean }} [internal]
 */
export function planStream(query, options = {}, world = undefined, internal = {}) {
  const { count, offset = 0, chunkSize = DEFAULT_CHUNK, field } = options;
  const isCount = (v) => Number.isInteger(v) && v >= 0;
  if (count !== undefined && !isCount(count)) throw bad(`count must be a non-negative integer, got ${JSON.stringify(count)}`);
  if (!isCount(offset)) throw bad(`offset must be a non-negative integer, got ${JSON.stringify(offset)}`);
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK) throw bad(`chunkSize must be an integer from 1 to ${MAX_CHUNK}, got ${JSON.stringify(chunkSize)}`);

  const doc = toDocument(query);
  const op = selectOperation(doc, options.operationName);
  const roots = rootFieldNodes(op);
  if (roots.length === 0) throw bad("stream needs a query with a root collection field");

  // infer the whole operation once to learn which root fields are collections
  const whole = prepare(doc, options, world).inferred;
  const rootType = whole.rootType ?? "Query";
  const isCollection = (f) => {
    const m = whole.model.get(rootType)?.get(f.name.value);
    return Boolean(m && m.kind === "object" && (m.list || m.connection));
  };
  let node;
  if (field !== undefined) {
    node = roots.find((f) => responseKey(f) === field);
    if (!node) throw bad(`the query has no root field ${JSON.stringify(field)}`, { hint: `root fields: ${roots.map(responseKey).join(", ")}` });
    if (!isCollection(node)) throw bad(`the root field ${JSON.stringify(field)} is not a collection`);
  } else {
    node = roots.find(isCollection);
    if (!node) throw bad("stream needs a root collection field (a list or a connection); none of the root fields is one", { hint: `root fields: ${roots.map(responseKey).join(", ")}` });
  }
  if (whole.abstracts.has(whole.model.get(rootType).get(node.name.value).typeName)) {
    throw bad("stream does not support a root collection of a union or interface type");
  }

  // try the paging styles in order; without a user schema the first always fits
  let built;
  let lastError;
  for (const style of STYLES) {
    try {
      let single = singleFieldDocument(doc, op, node, style);
      let p = prepare(single, { ...options, strict: false, operationName: undefined }, world);
      if (internal.normalize) {
        single = normalizeSelections(single, p.inferred.model, { parentType: rootType });
        p = prepare(single, { ...options, strict: false, operationName: undefined }, world);
      }
      built = { style, ...p, document: single };
      break;
    } catch (e) {
      lastError = e;
      if (!options.schema || !(e instanceof GraceholderError) || e.code !== "graphql") throw e;
    }
  }
  if (!built) throw lastError;

  const { inferred, runOptions, style } = built;
  const rootInfo = inferred.model.get(inferred.rootType ?? "Query").get(node.name.value);
  const key = responseKey(node);
  const declared = rootInfo.count !== undefined;
  if (count === undefined && !declared) {
    throw bad(`stream needs a count: ${JSON.stringify(key)} has no declared size`, { hint: `pass { count: 1000 } or declare the size, for example ${key} @count(n: 1000)` });
  }
  inferred.schema ??= buildSchema(inferred.sdl);
  const opDef = /** @type {any} */ (inferred.document.definitions[0]);
  const field0 = opDef.selectionSet.selections[0];
  const keep = (field0.arguments ?? []).filter((a) => !PAGING_ARGS.has(a.name.value));

  /** Run one window and return its root items plus the trace of entity keys (when asked). */
  const fetchWindow = (start, size, trace) => {
    const win = { ...field0, arguments: [...keep, ...windowArgs(style, start, size)] };
    const document = {
      ...inferred.document,
      definitions: [{ ...opDef, selectionSet: { ...opDef.selectionSet, selections: [win] } }, ...inferred.document.definitions.slice(1)],
    };
    const result = run({ ...inferred, document }, trace ? { ...runOptions, trace } : runOptions);
    if (result.errors?.length) {
      const own = result.errors.find((e) => e.originalError instanceof GraceholderError);
      if (own) throw own.originalError;
      throw new GraceholderError("graphql", result.errors[0].message, { cause: result.errors[0], errors: result.errors });
    }
    const value = JSON.parse(JSON.stringify(/** @type {any} */ (result.data)[key]));
    if (!rootInfo.connection) return value;
    if (Array.isArray(value?.nodes)) return value.nodes;
    if (Array.isArray(value?.edges)) return value.edges.map((e) => e.node);
    throw bad(`the connection ${JSON.stringify(key)} must select nodes or edges { node } to be streamed`);
  };

  return { key, rootInfo, count, offset, chunkSize, fetchWindow, inferred, runOptions, world };
}

/** The windows `[start, start + size)` covering the requested range, lazily. */
export function* windows(plan, from = plan.offset, count = plan.count, trace) {
  let start = from;
  let remaining = count ?? Infinity;
  while (remaining > 0) {
    const size = Math.min(plan.chunkSize, remaining);
    const items = plan.fetchWindow(start, size, trace);
    yield { start, items };
    start += items.length;
    remaining -= items.length;
    if (items.length < size) return;
  }
}
