// Schema mode (docs/design.md section 17): load a schema given as SDL, an introspection
// result or a graphql-js schema, and map its scalars onto generators.
import {
  buildSchema,
  buildASTSchema,
  buildClientSchema,
  isSchema,
  validateSchema,
  Kind,
  isNonNullType,
  isListType,
  isEnumType,
  isScalarType,
  isObjectType,
  isInterfaceType,
  isUnionType,
  getNamedType,
} from "graphql";
import { GraceholderError } from "./errors.js";

const cache = new WeakMap();
const textCache = new Map();
const TEXT_CACHE_MAX = 16;

const bad = (msg, extra) => new GraceholderError("bad-schema", msg, extra);

function build(input) {
  if (isSchema(input)) return input;
  if (typeof input === "string") return buildSchema(input);
  if (input && typeof input === "object") {
    if (input.kind === Kind.DOCUMENT) return buildASTSchema(input);
    const introspection = input.__schema ? input : input.data?.__schema ? input.data : null;
    if (introspection) return buildClientSchema(introspection);
  }
  throw bad("schema must be SDL text, a parsed SDL document, an introspection result ({ __schema } or { data: { __schema } }) or a GraphQLSchema");
}

/**
 * Load and validate a schema. Results are cached by identity (objects) or text (strings).
 * @param {unknown} input
 * @returns {import("graphql").GraphQLSchema}
 */
export function loadSchema(input) {
  const isText = typeof input === "string";
  if (isText && textCache.has(input)) return textCache.get(input);
  if (!isText && input && typeof input === "object" && cache.has(input)) return cache.get(input);
  let schema;
  try {
    schema = build(input);
  } catch (e) {
    if (e instanceof GraceholderError) throw e;
    throw bad(`could not read the schema: ${/** @type {Error} */ (e).message}`, { cause: e });
  }
  const problems = validateSchema(schema);
  if (problems.length) throw bad(`the schema is not valid: ${problems[0].message}`, { cause: problems[0], hint: problems.slice(1, 4).map((p) => p.message).join("; ") || undefined });
  if (!schema.getQueryType()) throw bad("the schema has no query root type");
  if (isText) {
    if (textCache.size >= TEXT_CACHE_MAX) textCache.delete(textCache.keys().next().value);
    textCache.set(input, schema);
  } else if (input && typeof input === "object") {
    cache.set(input, schema);
  }
  return schema;
}

/**
 * Decompose a field type.
 * @param {import("graphql").GraphQLOutputType} type
 * @returns {{ named: import("graphql").GraphQLNamedOutputType, list: boolean, nonNull: boolean, itemNonNull: boolean }}
 */
export function shapeOf(type) {
  /** @type {any} */
  let t = type;
  const nonNull = isNonNullType(t);
  if (nonNull) t = t.ofType;
  let list = false;
  let itemNonNull = false;
  if (isListType(t)) {
    list = true;
    t = t.ofType;
    if (isNonNullType(t)) {
      itemNonNull = true;
      t = t.ofType;
    }
    if (isListType(t)) {
      throw new GraceholderError("unsupported", `nested list type ${String(type)} is not supported`, { hint: "use a list of objects, or override the field with a spec" });
    }
  }
  return { named: getNamedType(type), list, nonNull, itemNonNull };
}

/** Concrete object types a (possibly abstract) type can be at run time, in schema order. */
export function concreteTypes(schema, type) {
  if (isObjectType(type)) return [type];
  if (isInterfaceType(type) || isUnionType(type)) return [...schema.getPossibleTypes(type)];
  return [];
}

// --- scalars -> generators ---------------------------------------------------------------------

const DATE_TIME = { gen: "datetime", args: { minDaysAgo: 30, maxDaysAgo: 1500 } };

/** Custom scalar name (lower case, `_`/`-` removed) -> generator. First hit wins; otherwise the field name decides. */
/** @type {any[]} */
const CUSTOM_ENTRIES = [
  ...["datetime", "timestamp", "isodatetime", "instant", "utcdatetime", "localdatetime", "datetimeiso", "zoneddatetime", "offsetdatetime"].map((n) => [n, DATE_TIME]),
  ...["date", "isodate", "calendardate", "localdate", "plaindate"].map((n) => [n, { gen: "datetime", args: { minDaysAgo: 30, maxDaysAgo: 1500, format: "date" } }]),
  ...["url", "uri", "href", "weburl"].map((n) => [n, { gen: "url", args: {} }]),
  ...["email", "emailaddress"].map((n) => [n, { gen: "person.email", args: {} }]),
  ...["uuid", "guid"].map((n) => [n, { gen: "id.uuid", args: {} }]),
  ...["phone", "phonenumber", "tel"].map((n) => [n, { gen: "person.phone", args: {} }]),
  ...["ip", "ipv4", "ipaddress", "ipv4address"].map((n) => [n, { gen: "ip", args: {} }]),
  ...["color", "colour", "hexcolor", "hexcolorcode"].map((n) => [n, { gen: "color", args: {} }]),
  ...["slug"].map((n) => [n, { gen: "slug", args: {} }]),
  ...["bigint", "long", "int64", "safeint", "nonnegativeint", "positiveint", "unsignedint", "uint", "integer"].map((n) => [n, { gen: "int", args: { min: 0, max: 100000 } }]),
  ...["decimal", "bigdecimal", "float64", "double", "nonnegativefloat", "positivefloat", "money"].map((n) => [n, { gen: "float", args: { min: 0, max: 1000, decimals: 2 } }]),
  ...["json", "jsonobject", "any", "object", "unknown", "void"].map((n) => [n, { gen: "words", args: { n: 2 } }]),
];
const CUSTOM_SCALARS = new Map(CUSTOM_ENTRIES);

/** Look up the generator for a custom scalar by its own name. */
export function customScalarGen(scalarName) {
  return CUSTOM_SCALARS.get(scalarName.toLowerCase().replace(/[_-]/g, "")) ?? null;
}

/** May a heuristic generator whose SDL type is `heur` fill a built-in scalar `declared`? */
export function compatible(heur, declared) {
  switch (declared) {
    case "Int": return heur === "Int" || heur === "ID";
    case "Float": return heur === "Int" || heur === "Float";
    case "Boolean": return heur === "Boolean";
    case "String": return heur === "String" || heur === "DateTime" || heur === "ID";
    case "ID": return heur === "ID" || heur === "String" || heur === "Int";
    default: return false;
  }
}

/** The generator used for a built-in scalar when no name heuristic fits its type. */
export const BUILTIN_FALLBACK = {
  Int: { gen: "int", args: { min: 0, max: 100 } },
  Float: { gen: "float", args: { min: 0, max: 100, decimals: 2 } },
  Boolean: { gen: "bool", args: {} },
  String: { gen: "words", args: { n: 2 } },
  ID: { gen: "id.key", args: {} },
};

/** A graphql type guard used by the walker. */
export const isLeaf = (type) => isScalarType(type) || isEnumType(type);
